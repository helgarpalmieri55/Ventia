'use client';

// Explicit React import, like every component in `@ventia/ui`. The admin's
// tsconfig sets `jsx: "preserve"` and leaves the transform to Next, which uses
// the automatic runtime — but vitest compiles this file with esbuild's classic
// transform, where the bare JSX below becomes `React.createElement`. Without
// this line the component renders fine in the app and throws "React is not
// defined" the moment a test renders it.
import * as React from 'react';
import { Alert, type AlertVariant } from '@ventia/ui';
import {
  asistenteAviso,
  consumoBarras,
  consumoResumen,
  type ConsumoTono,
  type CreditsUsage,
} from '../lib/agent-usage-api';

/**
 * The consumption panel: the merchant's answer to "¿me estoy pasando?".
 *
 * Rendered on `/consumo` and reused, compact, inside Configuración →
 * Asistente IA, so the two surfaces cannot drift into telling a merchant two
 * different stories about the same month.
 *
 * All of the wording and every threshold live in `lib/agent-usage-api.ts`
 * (pure, tested). This file is layout and colour only, and the colour is the
 * part worth reading carefully: `excedente` is drawn in the informational
 * blue, never amber and never red. A store paying overage is a store selling
 * more than its plan assumed, with the agent still answering — the one thing
 * this screen must never do is make that look like a fault.
 */

const ALERT_VARIANT: Record<ConsumoTono, AlertVariant | null> = {
  // No box at all when everything is fine. A permanent green banner saying
  // "vas bien" is noise the merchant learns to skip, which is exactly the
  // habit that makes the amber one invisible when it finally appears.
  ok: null,
  info: 'info',
  warning: 'warning',
  error: 'error',
};

/** Fill colour of the allowance bar. Amber only at the 80% nudge: once the
 * allowance is spent the bar is simply full, and the overage bar beside it is
 * what carries the news. */
function cupoColor(tono: ConsumoTono): string {
  if (tono === 'warning') return 'bg-amber-500';
  if (tono === 'error') return 'bg-destructive';
  return 'bg-primary';
}

interface BarraProps {
  label: string;
  percent: number;
  color: string;
  detalle: string;
}

function Barra({ label, percent, color, detalle }: BarraProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-sm tabular-nums text-muted-foreground">{detalle}</span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
        className="h-2.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div className={`h-full rounded-full ${color}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

export interface ConsumoPanelProps {
  credits: CreditsUsage;
  /** When false, the merchant-assistant notice is left out — Configuración
   * renders the compact version next to the agent's settings, where that
   * paragraph is a digression. `/consumo` always shows it. */
  mostrarAsistente?: boolean;
}

export function ConsumoPanel({ credits, mostrarAsistente = true }: ConsumoPanelProps) {
  const resumen = consumoResumen(credits);
  const barras = consumoBarras(credits);
  const variant = ALERT_VARIANT[resumen.tono];
  const aviso = asistenteAviso(credits);
  const avisoVariant = ALERT_VARIANT[aviso.tono];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-4">
        <Barra
          label="Tu cupo del mes"
          percent={barras.cupoPercent}
          color={cupoColor(resumen.tono)}
          detalle={`${credits.used} de ${credits.limit} créditos`}
        />

        {/* Drawn only when there IS overage. An empty second bar sitting there
            every month would read as a second quota the merchant has to
            worry about, when for almost every store it is a thing that never
            happens. */}
        {credits.overage > 0 ? (
          <Barra
            label="Excedente"
            percent={barras.excedentePercent}
            color={resumen.estado === 'tope' ? 'bg-destructive' : 'bg-sky-500'}
            detalle={`${credits.overage} de ${barras.margenExcedente} créditos`}
          />
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        {variant ? (
          <Alert variant={variant}>
            <p className="font-medium">{resumen.titulo}</p>
            <p className="mt-1">{resumen.detalle}</p>
          </Alert>
        ) : (
          <div className="rounded-md border border-border p-4 text-sm">
            <p className="font-medium">{resumen.titulo}</p>
            <p className="mt-1 text-muted-foreground">{resumen.detalle}</p>
          </div>
        )}

        {mostrarAsistente ? (
          avisoVariant ? (
            <Alert variant={avisoVariant}>
              <p className="font-medium">{aviso.titulo}</p>
              <p className="mt-1">{aviso.detalle}</p>
            </Alert>
          ) : (
            <div className="rounded-md border border-border p-4 text-sm">
              <p className="font-medium">{aviso.titulo}</p>
              <p className="mt-1 text-muted-foreground">{aviso.detalle}</p>
            </div>
          )
        ) : null}
      </div>
    </div>
  );
}
