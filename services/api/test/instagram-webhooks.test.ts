import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';
import type { InstagramAccountsService as InstagramAccountsServiceType } from '../src/instagram/instagram-accounts.service';

/**
 * El camino de entrada de Instagram, de punta a punta por HTTP de verdad.
 *
 * La propiedad por la que existe este archivo es el enrutamiento: Meta entrega
 * UN webhook por app cubriendo todas las cuentas conectadas a ella, así que
 * esta única URL recibe el tráfico de todos los inquilinos y el único
 * discriminante es un valor dentro de un payload sin autenticar. Equivocarse
 * ahí no es un 500 — es los clientes de una tienda hablando con el agente de
 * otra.
 *
 * Lo segundo que se prueba aquí, y que no tiene equivalente en WhatsApp, es la
 * ventana de 24 horas: fuera de ella Meta rechaza el envío, así que responder
 * es pagarle al modelo un texto que nadie va a leer.
 */

const APP_SECRET = 'meta-app-secret';
const IG_ACCOUNT_ID = '17841405793187218';
const OTHER_IG_ACCOUNT_ID = '17800000000009999';
const PAGE_ID = '102290129340398';
const SHOPPER_IGSID = '6123456789012345';

let db: Awaited<ReturnType<typeof startTestDb>>;
let prisma: PrismaClientType;
let app: INestApplication;
let accounts: InstagramAccountsServiceType;

let tenantId: string;
let otherTenantId: string;

/** Sustituye la llamada real a Anthropic para que una entrega recorra toda la
 * ruta sin modelo. */
let scripted: unknown[] = [];

/** Cuánto tarda el modelo falso en contestar. Cero salvo en la prueba que
 * necesita que la ventana de 24 horas se cierre DURANTE el turno, que es la
 * única forma honesta de provocar ese caso sin manipular el reloj. */
let modelDelayMs = 0;

/** Los envíos salientes que el canal intentó hacer contra la Graph API. */
let sent: { url: string; body: unknown }[] = [];

beforeAll(async () => {
  db = await startTestDb();
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.ANTHROPIC_API_KEY ??= 'sk-ant-test-not-used';
  process.env.PAYMENTS_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');

  const { ANTHROPIC_CLIENT } = await import('../src/agent/agent.service');
  const { Test } = await import('@nestjs/testing');
  const { AppModule } = await import('../src/app.module');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ANTHROPIC_CLIENT)
    .useValue({
      messages: {
        create: vi.fn(async () => {
          if (modelDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, modelDelayMs));
          const next = scripted.shift();
          if (!next) throw new Error('cliente anthropic falso: no queda respuesta guionizada');
          return next;
        }),
      },
    })
    .compile();

  app = moduleRef.createNestApplication();
  // El middleware de cuerpo crudo que `main.ts` monta para /webhooks es lo que
  // necesita la verificación de firma; un módulo de pruebas no lo trae, así que
  // se aplica aquí por el mismo motivo y con la misma forma.
  const express = (await import('express')).default;
  app.use('/webhooks', express.raw({ type: '*/*', limit: '1mb' }));
  await app.init();

  ({ platformDb: prisma } = (await import('@ventia/db')) as unknown as { platformDb: PrismaClientType });
  const { InstagramAccountsService } = await import('../src/instagram/instagram-accounts.service');
  accounts = app.get(InstagramAccountsService);

  const tenant = await prisma.tenant.create({
    data: {
      slug: `ig-${Date.now()}`,
      name: 'Tienda Instagram',
      status: 'live',
      limits: { create: { productsMax: 100, aiCreditsMonth: 500, staffSeats: 2, instagramChannel: true } },
    },
  });
  tenantId = tenant.id;
  await prisma.tenantDomain.create({ data: { tenantId, domain: 'ig-tienda.ventia.localhost', isPrimary: true } });

  const other = await prisma.tenant.create({
    data: {
      slug: `ig-other-${Date.now()}`,
      name: 'Otra Tienda',
      status: 'live',
      limits: { create: { productsMax: 100, aiCreditsMonth: 500, staffSeats: 2, instagramChannel: true } },
    },
  });
  otherTenantId = other.id;
  await prisma.tenantDomain.create({
    data: { tenantId: otherTenantId, domain: 'ig-otra.ventia.localhost', isPrimary: true },
  });

  await accounts.connect({
    tenantId,
    provider: 'graph',
    igAccountId: IG_ACCOUNT_ID,
    pageId: PAGE_ID,
    username: 'mitienda',
    credentials: { token: 'page-token', appSecret: APP_SECRET, verifyToken: 'verificame' },
  });
  await accounts.connect({
    tenantId: otherTenantId,
    provider: 'graph',
    igAccountId: OTHER_IG_ACCOUNT_ID,
    pageId: '999888777666555',
    username: 'otratienda',
    credentials: { token: 'other-token', appSecret: 'other-secret', verifyToken: 'otra-verificacion' },
  });
}, 240_000);

afterAll(async () => {
  await app.close();
  await db.stop();
});

beforeEach(() => {
  scripted = [];
  sent = [];
  modelDelayMs = 0;
  // El proveedor falso: `GraphProvider.sendText` usa el `fetch` global por
  // defecto, así que sustituirlo es todo lo que hace falta para ver qué se
  // manda de verdad sin tocar la red — el mismo tipo de costura que el
  // `fetchImpl` de los adaptadores de pago.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response('{"message_id":"mid.enviado"}', { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function textResponse(text: string) {
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: 5, output_tokens: 5 },
    stop_reason: 'end_turn',
  };
}

function igPayload(
  opts: {
    igAccountId?: string;
    text?: string;
    mid?: string;
    timestamp?: number;
    senderId?: string;
    extraMessage?: Record<string, unknown>;
  } = {},
) {
  const timestamp = opts.timestamp ?? Date.now();
  return {
    object: 'instagram',
    entry: [
      {
        id: opts.igAccountId ?? IG_ACCOUNT_ID,
        time: timestamp,
        messaging: [
          {
            sender: { id: opts.senderId ?? SHOPPER_IGSID },
            recipient: { id: opts.igAccountId ?? IG_ACCOUNT_ID },
            timestamp,
            message: {
              mid: opts.mid ?? `mid.${Math.random().toString(36).slice(2)}`,
              text: opts.text ?? '¿tienen camisas?',
              ...opts.extraMessage,
            },
          },
        ],
      },
    ],
  };
}

/** Publica un payload firmado con `secret`, como haría Meta. */
function post(payload: unknown, secret = APP_SECRET) {
  const raw = JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', secret).update(raw, 'utf8').digest('hex')}`;
  return request(app.getHttpServer())
    .post('/webhooks/instagram/graph')
    .set('content-type', 'application/json')
    .set('x-hub-signature-256', signature)
    .send(raw);
}

/** El manejador de entrada es dispara-y-olvida, así que una prueba que mira sus
 * efectos tiene que dejarlo terminar. */
async function settle(ms = 400) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Borra las claves de enfriamiento del agente para mensajes idénticos
 * repetidos, para que una prueba pueda aislar el mecanismo que ese
 * enfriamiento taparía. */
async function clearThrottleCooldown(): Promise<void> {
  const Redis = (await import('ioredis')).default;
  const redis = new Redis(process.env.REDIS_URL!);
  const keys = await redis.keys('agent:dup:*');
  if (keys.length > 0) await redis.del(...keys);
  await redis.quit();
}

describe('POST /webhooks/instagram/graph — enrutamiento', () => {
  it('contesta al inquilino dueño de la cuenta de Instagram', async () => {
    scripted = [textResponse('¡Claro! Tenemos varias.')];

    const res = await post(igPayload());
    expect(res.status).toBe(200);
    await settle();

    const conversation = await prisma.conversation.findFirst({
      where: { tenantId, channel: 'instagram', shopperRef: SHOPPER_IGSID },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    expect(conversation).not.toBeNull();
    expect(conversation!.messages.map((m) => m.content)).toContain('¿tienen camisas?');

    // Y la respuesta salió de verdad hacia la cuenta correcta.
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(`https://graph.facebook.com/v21.0/${IG_ACCOUNT_ID}/messages`);
    expect(sent[0].body).toEqual({
      recipient: { id: SHOPPER_IGSID },
      message: { text: '¡Claro! Tenemos varias.' },
    });
  });

  it('NUNCA enruta una entrega a un inquilino que no es dueño de la cuenta', async () => {
    // El fallo que existe para evitar todo este diseño. El payload nombra la
    // cuenta de la otra tienda y va firmado con SU secreto — o sea, es una
    // entrega perfectamente válida, solo que no es nuestra.
    scripted = [textResponse('no debería usarse')];

    await post(igPayload({ igAccountId: OTHER_IG_ACCOUNT_ID, text: 'mensaje ajeno' }), 'other-secret');
    await settle();

    expect(await prisma.message.findFirst({ where: { tenantId, content: 'mensaje ajeno' } })).toBeNull();
    expect(
      await prisma.message.findFirst({ where: { tenantId: otherTenantId, content: 'mensaje ajeno' } }),
    ).not.toBeNull();
  });

  it('tira un payload firmado con el secreto EQUIVOCADO, sin contestar', async () => {
    scripted = [textResponse('no debería enviarse')];

    const res = await post(igPayload({ text: 'firma falsa' }), 'secreto-falsificado');
    expect(res.status).toBe(200);
    await settle();

    expect(await prisma.message.findFirst({ where: { content: 'firma falsa' } })).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('responde 200 a una cuenta desconocida en vez de revelar que lo es', async () => {
    const res = await post(igPayload({ igAccountId: '17800000000000001' }));
    expect(res.status).toBe(200);
    await settle();
    expect(sent).toHaveLength(0);
  });

  it('responde 200 a cuerpos rotos y vacíos', async () => {
    const res = await request(app.getHttpServer())
      .post('/webhooks/instagram/graph')
      .set('content-type', 'application/json')
      .send('esto no es json');
    expect(res.status).toBe(200);
  });

  it('responde 404 a un proveedor desconocido', async () => {
    const res = await request(app.getHttpServer()).post('/webhooks/instagram/instagram_login').send({});
    expect(res.status).toBe(404);
  });

  it('no contesta el eco de nuestra propia respuesta', async () => {
    // Sin esto el agente se contesta a sí mismo, para siempre, pagando.
    scripted = [textResponse('no debería enviarse')];

    await post(igPayload({ text: 'eco nuestro', extraMessage: { is_echo: true } }));
    await settle();

    expect(await prisma.message.findFirst({ where: { tenantId, content: 'eco nuestro' } })).toBeNull();
    expect(sent).toHaveLength(0);
  });
});

describe('POST /webhooks/instagram/graph — ventana de 24 horas', () => {
  it('no responde a un mensaje de hace más de 24 horas', async () => {
    // Fuera de la ventana Meta rechaza el envío: generar la respuesta sería
    // cobrarle créditos al comerciante por un texto que nadie va a leer.
    scripted = [textResponse('esto no debe generarse')];

    await post(igPayload({ text: 'entrega represada', timestamp: Date.now() - 25 * 60 * 60 * 1000 }));
    await settle();

    // Ni turno de modelo, ni fila, ni envío.
    expect(scripted).toHaveLength(1);
    expect(await prisma.message.findFirst({ where: { tenantId, content: 'entrega represada' } })).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('sí responde a un mensaje de hace 23 horas', async () => {
    // El otro lado de la misma frontera: cerrar la ventana antes de tiempo
    // dejaría muda a la tienda con mensajes que todavía se pueden contestar.
    scripted = [textResponse('perdón por la demora, sí tenemos')];

    await post(igPayload({ text: 'llegó tarde pero a tiempo', timestamp: Date.now() - 23 * 60 * 60 * 1000 }));
    await settle();

    expect(scripted).toHaveLength(0);
    expect(sent).toHaveLength(1);
  });

  it('no envía si la ventana se cerró MIENTRAS el modelo pensaba', async () => {
    // El caso que la comprobación de dentro del bucle existe para atajar, y la
    // única forma honesta de provocarlo sin tocar el reloj: un mensaje a dos
    // segundos de cumplir las 24 horas y un modelo que tarda tres. La
    // comprobación previa al turno lo deja pasar (todavía queda ventana) y la
    // de antes de enviar ya no.
    modelDelayMs = 3_000;
    scripted = [textResponse('esta respuesta llega tarde')];

    await post(igPayload({ text: 'justo en el borde', timestamp: Date.now() - (24 * 60 * 60 * 1000 - 2_000) }));
    await settle(6_000);

    // El turno SÍ se generó — la ventana estaba abierta cuando se decidió —,
    // pero no se manda nada: Meta lo rechazaría y sería medio mensaje suelto.
    expect(scripted).toHaveLength(0);
    expect(await prisma.message.findFirst({ where: { tenantId, content: 'justo en el borde' } })).not.toBeNull();
    expect(sent).toHaveLength(0);
  });
});

describe('POST /webhooks/instagram/graph — reintentos y plan', () => {
  it('contesta una entrega reintentada exactamente una vez, y llama al modelo una vez', async () => {
    // Meta reintenta con el MISMO mid. Sin deduplicación se le factura dos
    // veces al comerciante y se le contesta dos veces al comprador.
    //
    // La prueba afirma que NO se volvió a llamar al modelo, y no solo que hay
    // una fila: el índice único rechazaría la segunda inserción de todas
    // formas, pero DESPUÉS de una llamada al modelo ya pagada. Y se limpia el
    // enfriamiento de mensajes repetidos del agente entre las dos entregas,
    // porque si no es él quien se traga la segunda y la prueba pasaría con la
    // deduplicación quitada.
    const mid = `mid.REINTENTO-${Date.now()}`;
    scripted = [textResponse('primera y única'), textResponse('esto no debe enviarse')];

    await post(igPayload({ mid, text: 'reintento' }));
    await settle();
    expect(scripted).toHaveLength(1);

    await clearThrottleCooldown();
    await post(igPayload({ mid, text: 'reintento' }));
    await settle();

    expect(scripted).toHaveLength(1);
    const stored = await prisma.message.findMany({ where: { tenantId, content: 'reintento' } });
    expect(stored).toHaveLength(1);
    expect(stored[0].externalId).toBe(mid);
  });

  it('deja pasar un mensaje realmente NUEVO después de haber tirado un reintento', async () => {
    scripted = [textResponse('respuesta al seguimiento')];

    await post(igPayload({ mid: `mid.NUEVO-${Date.now()}`, text: 'otra pregunta distinta' }));
    await settle();

    expect(scripted).toHaveLength(0);
    expect(await prisma.message.findMany({ where: { tenantId, content: 'otra pregunta distinta' } })).toHaveLength(1);
  });

  it('no contesta a una tienda cuyo plan ya no incluye Instagram', async () => {
    // Emprende no lo incluye. Una tienda que baje de plan conserva su cuenta
    // registrada y Meta sigue entregando; sin esta comprobación seguiría
    // gastando presupuesto de IA por un canal que ya no paga.
    await prisma.tenantLimits.update({ where: { tenantId }, data: { instagramChannel: false } });
    scripted = [textResponse('no debería enviarse')];

    await post(igPayload({ text: 'plan revocado' }));
    await settle();

    expect(await prisma.message.findFirst({ where: { tenantId, content: 'plan revocado' } })).toBeNull();
    expect(sent).toHaveLength(0);
    await prisma.tenantLimits.update({ where: { tenantId }, data: { instagramChannel: true } });
  });

  it('no contesta por una cuenta DESACTIVADA', async () => {
    const [account] = await accounts.listForTenant(tenantId);
    await accounts.setStatus(tenantId, account.id, 'disabled');
    scripted = [textResponse('no debería enviarse')];

    await post(igPayload({ text: 'cuenta apagada' }));
    await settle();

    expect(await prisma.message.findFirst({ where: { tenantId, content: 'cuenta apagada' } })).toBeNull();
    await accounts.setStatus(tenantId, account.id, 'connected');
  });
});

describe('GET /webhooks/instagram/graph — saludo de Meta', () => {
  it('devuelve el challenge en texto plano con el token correcto', async () => {
    const res = await request(app.getHttpServer())
      .get('/webhooks/instagram/graph')
      .query({
        account: IG_ACCOUNT_ID,
        'hub.mode': 'subscribe',
        'hub.verify_token': 'verificame',
        'hub.challenge': '1158201444',
      });

    expect(res.status).toBe(200);
    // Texto plano, no JSON — Meta compara el cuerpo byte a byte.
    expect(res.text).toBe('1158201444');
  });

  it('responde 403 a un token de verificación equivocado', async () => {
    const res = await request(app.getHttpServer())
      .get('/webhooks/instagram/graph')
      .query({
        account: IG_ACCOUNT_ID,
        'hub.mode': 'subscribe',
        'hub.verify_token': 'adivinado',
        'hub.challenge': '1158201444',
      });

    expect(res.status).toBe(403);
  });

  it('responde 403 al token de OTRO inquilino contra esta cuenta', async () => {
    const res = await request(app.getHttpServer())
      .get('/webhooks/instagram/graph')
      .query({
        account: IG_ACCOUNT_ID,
        'hub.mode': 'subscribe',
        'hub.verify_token': 'otra-verificacion',
        'hub.challenge': '1',
      });

    expect(res.status).toBe(403);
  });

  it('responde 403 si falta el parámetro `account`', async () => {
    // Meta no dice qué cuenta está verificando, así que sin ese parámetro un
    // saludo no se puede atribuir a ningún inquilino.
    const res = await request(app.getHttpServer())
      .get('/webhooks/instagram/graph')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verificame', 'hub.challenge': '1' });

    expect(res.status).toBe(403);
  });
});

describe('InstagramAccountsService — propiedad de la cuenta', () => {
  it('se niega a que un inquilino reclame la cuenta de otro', async () => {
    // La restricción única es la garantía de enrutamiento: dos filas con el
    // mismo igAccountId harían ambigua cada entrega.
    await expect(
      accounts.connect({
        tenantId,
        provider: 'graph',
        igAccountId: OTHER_IG_ACCOUNT_ID,
        pageId: PAGE_ID,
        username: 'mitienda',
        credentials: { token: 'robado', appSecret: 'x' },
      }),
    ).rejects.toThrow();
  });

  it('deja que un inquilino reconecte su PROPIA cuenta, rotando el token', async () => {
    const before = await accounts.listForTenant(tenantId);
    await accounts.connect({
      tenantId,
      provider: 'graph',
      igAccountId: IG_ACCOUNT_ID,
      pageId: PAGE_ID,
      username: 'mitienda',
      credentials: { token: 'token-rotado', appSecret: APP_SECRET, verifyToken: 'verificame' },
    });
    const after = await accounts.listForTenant(tenantId);

    expect(after).toHaveLength(before.length);
    expect(after[0].status).toBe('connected');
  });

  it('nunca expone credenciales por la vista de lista', async () => {
    const view = await accounts.listForTenant(tenantId);
    expect(JSON.stringify(view)).not.toContain('token-rotado');
    expect(JSON.stringify(view)).not.toContain(APP_SECRET);
    expect(JSON.stringify(view)).not.toContain('verificame');
  });

  it('no puede desactivar la cuenta de otro inquilino', async () => {
    const [foreign] = await accounts.listForTenant(otherTenantId);
    const result = await accounts.setStatus(tenantId, foreign.id, 'disabled');

    expect(result).toBeNull();
    const [unchanged] = await accounts.listForTenant(otherTenantId);
    expect(unchanged.status).toBe('connected');
  });
});
