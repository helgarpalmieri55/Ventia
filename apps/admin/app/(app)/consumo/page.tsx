'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Spinner,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from '@ventia/ui';
import { ApiError } from '../../../lib/api';
import { errorMessage } from '../../../lib/errors';
import { formatCOP } from '../../../lib/format';
import { ASSISTANT_PATH } from '../../../lib/assistant-api';
import {
  consumoResumen,
  fetchAgentUsage,
  lineasConsumo,
  mesLargo,
  reglaTope,
  type AgentUsageResponse,
} from '../../../lib/agent-usage-api';
import { ConsumoPanel } from '../../../components/consumo-panel';

/**
 * "Consumo de IA" — how many credits this store has spent this month, how many
 * are left, whether it is already paying overage, and what happens when the
 * credits run out.
 *
 * ## Why this is its own page and not a tab
 *
 * Until now the only place a merchant could see any of this was a small panel
 * inside Configuración → Asistente IA: owner-only, three clicks deep, and
 * findable only by someone who already suspected there was something to look
 * for. That was survivable while reaching the allowance simply switched the
 * agent off — the merchant found out because the agent went quiet.
 *
 * It is not survivable now. Credits past the allowance are BILLED rather than
 * refused, so the merchant who never opens this can be spending money nobody
 * told them about, and the state they most need to see (overage) is the one
 * with no symptom at all. A number that can grow a bill needs a permanent
 * route with the merchant's own word on it — "Consumo" — the same reasoning
 * that gave "Pagos por revisar" and "Dominios" their own items rather than
 * burying them in Configuración.
 *
 * It is deliberately NOT inside "Asistente" either: that page is where the
 * merchant ASKS questions, and questions cost two credits each. Putting the
 * consumption screen behind an action that consumes the thing being measured
 * is a trap, and the merchant most in need of this page is the one whose
 * assistant has just stopped answering.
 *
 * ## Both roles
 *
 * `GET /v1/admin/agent/usage` sits behind `AdminSessionGuard` with no
 * `@Roles()`, so the nav mirrors it (see `lib/nav.ts`). A staff member
 * watching the store go quiet mid-shift is exactly the person who needs to
 * read "tus clientes siguen atendidos" without hunting for the owner.
 *
 * ## What is deliberately absent
 *
 * Prices, IVA, and any peso figure for the overage. This screen answers "¿me
 * estoy pasando?", and the honest answer is a credit count; a peso estimate
 * assembled client-side would be the number the merchant remembers and the
 * one the invoice then contradicts. The one peso figure on the page is what
 * the agent SOLD, which is measured, not estimated.
 */

export default function ConsumoPage() {
  const [usage, setUsage] = useState<AgentUsageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setUsage(await fetchAgentUsage());
    } catch (e) {
      setError(e instanceof ApiError ? errorMessage(e) : 'No pudimos cargar tu consumo.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Cargando tu consumo…
      </p>
    );
  }

  if (error || !usage) {
    return (
      <div className="flex max-w-3xl flex-col gap-3">
        <Alert variant="error">{error ?? 'No pudimos cargar tu consumo.'}</Alert>
        <Button className="self-start" onClick={() => void load()}>
          Reintentar
        </Button>
      </div>
    );
  }

  const { credits, assistedSales, month } = usage;
  const resumen = consumoResumen(credits);
  const lineas = lineasConsumo(credits);
  const totalCreditos = lineas.reduce((sum, linea) => sum + linea.creditos, 0);

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Consumo de IA</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <p className="text-sm text-muted-foreground">
            Lo que lleva gastado tu asistente en {mesLargo(month)}. El contador vuelve a cero el primer día de cada
            mes.
          </p>

          <ConsumoPanel credits={credits} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>En qué se fueron tus créditos</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Table>
            <Thead>
              <Tr>
                <Th>Concepto</Th>
                <Th>Cantidad</Th>
                <Th>Cada uno</Th>
                <Th>Créditos</Th>
              </Tr>
            </Thead>
            <Tbody>
              {lineas.map((linea) => (
                <Tr key={linea.concepto}>
                  <Td>
                    <span className="font-medium">{linea.concepto}</span>
                    <span className="block text-xs text-muted-foreground">{linea.nota}</span>
                  </Td>
                  <Td className="tabular-nums">{linea.cantidad}</Td>
                  <Td className="tabular-nums">{linea.precio}</Td>
                  <Td className="tabular-nums font-medium">{linea.creditos}</Td>
                </Tr>
              ))}
              <Tr>
                <Td colSpan={3} className="font-medium">
                  Total del mes
                </Td>
                <Td className="tabular-nums font-medium">{totalCreditos}</Td>
              </Tr>
            </Tbody>
          </Table>

          <p className="text-xs text-muted-foreground">
            Tus preguntas salen del mismo cupo que atiende a tus clientes. Puedes hacerlas desde{' '}
            <Link href={ASSISTANT_PATH} className="underline">
              Asistente
            </Link>
            .
          </p>
        </CardContent>
      </Card>

      {/* The counterweight, and the reason this card is on THIS page rather
          than only in Configuración: a merchant reading "llevas 140 créditos
          de más" needs the other half of the sentence in the same glance. */}
      <Card>
        <CardHeader>
          <CardTitle>Lo que vendió tu asistente este mes</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          <p className="text-2xl font-semibold">{formatCOP(assistedSales.revenueCents)}</p>
          <p className="text-sm text-muted-foreground">
            {assistedSales.orders} de {assistedSales.totalOrders}{' '}
            {assistedSales.totalOrders === 1 ? 'pedido' : 'pedidos'} de este mes los armó tu asistente.
          </p>
        </CardContent>
      </Card>

      {/* Only worth saying once there is a plan to be three times of, and only
          worth saying at all before the merchant hits it. */}
      {credits.limit > 0 && resumen.estado !== 'tope' ? (
        <p className="text-xs text-muted-foreground">{reglaTope(credits.limit)}</p>
      ) : null}
    </div>
  );
}
