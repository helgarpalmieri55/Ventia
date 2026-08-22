import { OVERAGE_CEILING_MULTIPLIER } from '@ventia/core';
import { apiFetch } from './api';

/**
 * Client for `GET /v1/admin/agent/usage` — the merchant's consumption screen.
 *
 * Types are hand-written rather than imported, for the same reason
 * `payment-alerts-api.ts` hand-writes its own: this app cannot reach into
 * `services/api/src`. They mirror the `credits` block of
 * `AgentAdminController.usage()`.
 *
 * ## Why this file carries so much prose and so little fetching
 *
 * The merchant's question is one sentence — "¿me estoy pasando?" — and every
 * wrong answer to it costs them money or scares them off their own product.
 * The two failure modes are opposite and both easy:
 *
 *  - reading overage as a breakdown ("algo se dañó"), when in fact the store
 *    is selling more than it planned to and the agent is still working;
 *  - reading the merchant assistant going quiet as the STORE going quiet,
 *    when the reserve exists precisely so that never happens.
 *
 * So the state machine and the sentences live here, as pure functions, where
 * they can be pinned by tests. The page is then only layout.
 */

export const CONSUMO_PATH = '/consumo';

/** Why the merchant's own assistant is refusing questions right now.
 * Mirrors `AgentCommandRefusalReason` in `@ventia/core`. */
export type AssistantPausedReason = 'exhausted' | 'shopper_reserve';

export interface MerchantAssistantUsage {
  /** Credits the assistant will not touch, held for shoppers. */
  reserve: number;
  /** Credits the assistant may still spend on the merchant's questions. */
  remaining: number;
  /** Null while the assistant is answering normally. */
  pausedReason: AssistantPausedReason | null;
}

export interface CreditsUsage {
  used: number;
  limit: number;
  remaining: number;
  overage: number;
  ceiling: number;
  ceilingMultiplier: number;
  warning: boolean;
  allowed: boolean;
  /** Null when there is no allowance to be a percentage of. Over 100 is
   * normal, not a bug: overage is billed, not refused. */
  percentUsed: number | null;
  cost: { shopperMessage: number; merchantQuery: number };
  breakdown: { shopperTurns: number; merchantQueries: number };
  merchantAssistant: MerchantAssistantUsage;
}

export interface AgentUsageResponse {
  /** `YYYY-MM`, UTC. */
  month: string;
  credits: CreditsUsage;
  assistedSales: {
    orders: number;
    revenueCents: number;
    totalOrders: number;
    totalRevenueCents: number;
  };
}

export function fetchAgentUsage(): Promise<AgentUsageResponse> {
  return apiFetch<AgentUsageResponse>('/v1/admin/agent/usage');
}

// ---- the one-glance answer -------------------------------------------

/**
 * Which of the five genuinely different situations this store is in.
 *
 * Ordered by which statement would be WRONG to make. A store past the ceiling
 * is also in overage and also over 80%, so `tope` has to win; a store in
 * overage is also over 80%, so `excedente` has to beat `aviso`. Getting this
 * order backwards is how a merchant whose agent has actually stopped gets
 * told "vas por el 300% de tu cupo" and nothing else.
 *
 * `sin_plan` comes first and is not a degree of consumption at all: a limit of
 * 0 means no plan was provisioned, which `AgentBudgetService` enforces as no
 * agent whatsoever. Every percentage below it would be a division by zero
 * dressed up as "0%, vas bien".
 */
export type ConsumoEstado = 'sin_plan' | 'normal' | 'aviso' | 'excedente' | 'tope';

export function consumoEstado(credits: Pick<CreditsUsage, 'limit' | 'overage' | 'warning' | 'allowed'>): ConsumoEstado {
  if (credits.limit <= 0) return 'sin_plan';
  if (!credits.allowed) return 'tope';
  if (credits.overage > 0) return 'excedente';
  if (credits.warning) return 'aviso';
  return 'normal';
}

/**
 * The visual weight each state gets.
 *
 * `excedente` is deliberately `info` and not `warning` or `error`. The
 * merchant has done nothing wrong — their store sold more than the plan
 * assumed and the agent kept answering, which is the product working. Painting
 * that amber trains them to fear their own busiest week; painting it red tells
 * them something is broken when nothing is.
 *
 * `error` is reserved for `tope`, which is the only state where the agent has
 * genuinely stopped talking to customers, and for `sin_plan`, where it never
 * started.
 */
export type ConsumoTono = 'ok' | 'info' | 'warning' | 'error';

const TONO: Record<ConsumoEstado, ConsumoTono> = {
  sin_plan: 'error',
  normal: 'ok',
  aviso: 'warning',
  excedente: 'info',
  tope: 'error',
};

export function consumoTono(estado: ConsumoEstado): ConsumoTono {
  return TONO[estado];
}

export interface ConsumoResumen {
  estado: ConsumoEstado;
  tono: ConsumoTono;
  /** The answer to "¿me estoy pasando?", in one line. */
  titulo: string;
  /** What happens next, and what it costs. Never a scolding. */
  detalle: string;
}

const creditos = (n: number) => `${n} ${n === 1 ? 'crédito' : 'créditos'}`;

/**
 * The whole screen in two sentences.
 *
 * Every one of these says what happens NEXT, because that is the thing the
 * merchant cannot look up anywhere else in the product. "Llevas 640 de 500"
 * without "y tu asistente sigue respondiendo" is the sentence that generates
 * the support ticket.
 */
export function consumoResumen(credits: CreditsUsage): ConsumoResumen {
  const estado = consumoEstado(credits);
  const tono = consumoTono(estado);

  switch (estado) {
    case 'sin_plan':
      return {
        estado,
        tono,
        titulo: 'Tu tienda no tiene créditos de IA asignados.',
        detalle:
          'Mientras no tengas un plan activo, tu asistente no puede responderles a tus clientes por chat. Escríbenos y lo activamos.',
      };
    case 'tope':
      return {
        estado,
        tono,
        titulo: `Llegaste al tope de ${creditos(credits.ceiling)}.`,
        detalle:
          `Es el máximo que puede gastar tu tienda en un mes: ${credits.ceilingMultiplier} veces tu cupo. ` +
          'Tu asistente dejó de responder por chat hasta el próximo mes; tus clientes ven un mensaje pidiéndoles que te escriban directo. Si tu tienda de verdad necesita este volumen, sube de plan y vuelve a quedar activo.',
      };
    case 'excedente':
      return {
        estado,
        tono,
        titulo: `Llevas ${creditos(credits.overage)} por encima de tu cupo.`,
        detalle:
          'Tu tienda está vendiendo más de lo que cubre tu plan y tu asistente siguió atendiendo: no se apagó y no hay nada roto. ' +
          `Esos créditos de más se te cobran como excedente al cierre del mes. Si esto te pasa seguido, un plan más grande te sale mejor. Tu asistente solo se detiene si llegas a ${creditos(credits.ceiling)}.`,
      };
    case 'aviso':
      return {
        estado,
        tono,
        titulo: `Vas por el ${credits.percentUsed ?? 0}% de tu cupo. Te quedan ${creditos(credits.remaining)}.`,
        detalle:
          'Cuando lo pases, tu asistente NO se apaga: sigue respondiéndoles a tus clientes y los créditos de más se te cobran como excedente. ' +
          'Te avisamos ahora para que decidas antes, no después.',
      };
    case 'normal':
      return {
        estado,
        tono,
        titulo: `Te quedan ${creditos(credits.remaining)} de ${credits.limit} este mes.`,
        detalle:
          'Si algún mes se te acaban, tu asistente sigue atendiendo a tus clientes y los créditos de más se cobran como excedente. Nunca te dejamos la tienda muda por llegar al cupo.',
      };
  }
}

// ---- the bar ----------------------------------------------------------

/**
 * Two bars, not one, and this is the load-bearing choice on the page.
 *
 * A single bar scaled to the CEILING makes a store sitting exactly on its
 * allowance render at 33% full — the shape of "plenty left" for the merchant
 * who has just started paying overage. A single bar scaled to the ALLOWANCE
 * has nowhere to draw the overage at all and pins at 100%, which is the shape
 * of "you are stopped" for a merchant whose agent is still answering.
 *
 * So the allowance and the overage get one bar each: the first answers "how
 * much of what I paid for is gone", the second answers "how far past it am I,
 * out of how far I could go". Both are honest at full scale.
 */
export interface ConsumoBarras {
  /** 0–100. Fill of the allowance bar. */
  cupoPercent: number;
  /** 0–100. Fill of the overage bar, out of the room between the allowance
   * and the ceiling. 0 when there is no overage — the bar is not drawn. */
  excedentePercent: number;
  /** Credits between the allowance and the ceiling: the overage bar's scale,
   * and the number the merchant is told they could still spend. */
  margenExcedente: number;
}

export function consumoBarras(credits: Pick<CreditsUsage, 'used' | 'limit' | 'overage' | 'ceiling'>): ConsumoBarras {
  const margenExcedente = Math.max(0, credits.ceiling - credits.limit);
  return {
    // Capped at 100 on purpose: past the allowance this bar is full and the
    // second one takes over. An unprovisioned store (limit 0) reads 0 rather
    // than dividing by zero — `sin_plan` says so in words above it.
    cupoPercent: credits.limit > 0 ? Math.min(100, Math.round((credits.used / credits.limit) * 100)) : 0,
    excedentePercent:
      margenExcedente > 0 ? Math.min(100, Math.round((credits.overage / margenExcedente) * 100)) : 0,
    margenExcedente,
  };
}

// ---- the merchant's own assistant -------------------------------------

export interface AsistenteAviso {
  tono: ConsumoTono;
  titulo: string;
  detalle: string;
}

/**
 * What to say about the merchant's own assistant, and the one sentence that
 * has to survive every edit of this file: **tus clientes siguen atendidos**.
 *
 * The merchant assistant stops at `cupo - reserva` while the shopper agent
 * keeps the whole allowance, so the first thing a merchant experiences when
 * the month gets tight is their OWN questions being refused — with credits
 * visibly remaining. Without this panel the only available reading is "se
 * cayó la tienda", and the merchant's next move is a support ticket or a
 * refund request, not a plan upgrade.
 *
 * `exhausted` is a different sentence, not a louder version of the same one:
 * there the allowance really is gone, shoppers are being answered on overage,
 * and pretending the silence is a courtesy reserve would be a lie the merchant
 * could check.
 */
export function asistenteAviso(credits: CreditsUsage): AsistenteAviso {
  const { reserve, pausedReason } = credits.merchantAssistant;

  if (pausedReason === 'shopper_reserve') {
    return {
      tono: 'info',
      titulo: 'Pausamos tus preguntas al asistente. Tus clientes siguen atendidos.',
      detalle:
        `Guardamos ${creditos(reserve)} de tu cupo solo para responderles a tus clientes: tu tienda los necesita para vender, y tus consultas no. ` +
        'Tu tienda no se cayó y tu asistente sigue atendiendo a quien te escriba. Vuelves a poder preguntar el próximo mes, o antes si subes de plan.',
    };
  }

  if (pausedReason === 'exhausted') {
    return {
      tono: 'info',
      titulo: 'Tus preguntas al asistente están pausadas. Tus clientes siguen atendidos.',
      detalle:
        'Se consumió el cupo del mes, así que el asistente dejó de responderte a ti. A tus clientes les sigue respondiendo, y esos créditos entran como excedente.',
    };
  }

  const preguntas = preguntasRestantes(credits);
  return {
    tono: 'ok',
    titulo: `Te ${preguntas === 1 ? 'queda 1 pregunta' : `quedan ${preguntas} preguntas`} para tu asistente este mes.`,
    detalle:
      `Cada pregunta tuya cuesta ${creditos(credits.cost.merchantQuery)} porque el asistente lee tu catálogo y tus pedidos para responderte. ` +
      `Nunca gastamos los últimos ${creditos(reserve)} de tu cupo en tus preguntas: esos quedan reservados para tus clientes.`,
  };
}

/**
 * `merchantAssistant.remaining` counted in QUESTIONS rather than in credits.
 *
 * The API reports credits, as it should — credits are what the allowance is
 * measured in. But a merchant about to type a question wants to know how many
 * more they get, and a merchant question costs two, so reporting the credit
 * figure under the word "preguntas" overstates it by exactly 2×. Floored,
 * because half a question is not a question the assistant will answer.
 */
export function preguntasRestantes(credits: Pick<CreditsUsage, 'cost' | 'merchantAssistant'>): number {
  return Math.floor(credits.merchantAssistant.remaining / credits.cost.merchantQuery);
}

// ---- the breakdown ----------------------------------------------------

export interface LineaConsumo {
  concepto: string;
  /** How many of this thing happened. */
  cantidad: number;
  /** What one of them costs. */
  precio: number;
  /** What they cost together. */
  creditos: number;
  /** Why it costs what it costs. */
  nota: string;
}

/**
 * Where the month's credits went, as two lines that add up.
 *
 * Shown because "llevas 640 créditos" is not actionable on its own: a merchant
 * who has spent a third of their month on their own questions has a lever
 * (ask fewer), and one whose shoppers spent it has a different one (upgrade).
 * The per-unit price is on screen because 2× is the single most surprising
 * fact about this counter, and a merchant who discovers it by arithmetic feels
 * tricked.
 */
export function lineasConsumo(credits: CreditsUsage): LineaConsumo[] {
  const { shopperTurns, merchantQueries } = credits.breakdown;
  return [
    {
      concepto: 'Mensajes de tus clientes',
      cantidad: shopperTurns,
      precio: credits.cost.shopperMessage,
      creditos: shopperTurns * credits.cost.shopperMessage,
      nota: 'Cada vez que tu asistente le responde a alguien en tu tienda o por WhatsApp.',
    },
    {
      concepto: 'Tus preguntas al asistente',
      cantidad: merchantQueries,
      precio: credits.cost.merchantQuery,
      creditos: merchantQueries * credits.cost.merchantQuery,
      nota: 'Cuestan más porque el asistente revisa tu catálogo y tus pedidos para responderte.',
    },
  ];
}

/**
 * The month, as a merchant reads months.
 *
 * `2026-08` is a key, not a date. Parsed by index rather than through `new
 * Date('2026-08')`, which is parsed as UTC midnight and renders as JULY for
 * anyone west of Greenwich — including every merchant this product has.
 */
const MESES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

export function mesLargo(month: string): string {
  const [year, mes] = month.split('-');
  const nombre = MESES[Number(mes) - 1];
  return nombre ? `${nombre} de ${year}` : month;
}

/** The ceiling rule in one sentence, for the footnote. Reads the multiplier
 * off `@ventia/core` rather than writing "3", so the sentence cannot drift
 * from the rule the API enforces. */
export function reglaTope(limit: number): string {
  return `Tu asistente solo deja de responder si llegas a ${OVERAGE_CEILING_MULTIPLIER} veces tu cupo (${
    limit * OVERAGE_CEILING_MULTIPLIER
  } créditos). Es un tope de seguridad contra un consumo desbocado, no un límite que una tienda normal alcance.`;
}
