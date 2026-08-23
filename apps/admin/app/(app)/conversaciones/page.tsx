'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Alert,
  Badge,
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
import { formatDateCO } from '../../../lib/format';
import { ConversacionPanel } from '../../../components/conversacion-panel';
import {
  CHANNEL_LABEL,
  listConversations,
  STATUS_BADGE_VARIANT,
  STATUS_LABEL,
  type ConversationFilter,
  type ConversationListResponse,
} from '../../../lib/conversations-api';
import { INTERVALO_LISTA_MS, conversacionesConNovedad } from '../../../lib/conversations-live';

/**
 * "Conversaciones" — la bandeja de atención: qué ha dicho el asistente, qué
 * conversaciones necesitan a una persona, y el sitio desde el que esa persona
 * contesta.
 *
 * Empezó siendo solo lectura porque `escalate_to_human` la necesitaba: el
 * correo de traspaso enlaza a una fila de aquí, y para un comprador del widget
 * web que nunca dejó un teléfono este transcripto es lo ÚNICO que tiene el
 * comerciante. Pero leer no es atender, y contestar vive ahora en
 * `components/conversacion-panel.tsx`.
 *
 * ## Está VIVA
 *
 * La lista se vuelve a pedir sola cada {@link INTERVALO_LISTA_MS} ms. Antes se
 * cargaba una vez y ya: un mensaje que llegaba por Instagram no aparecía hasta
 * que alguien recargaba a mano, lo que convierte una bandeja de atención en una
 * captura de pantalla. El porqué del sondeo (y no SSE) está en
 * `lib/conversations-live.ts`.
 *
 * Dos cuidados que no se ven en el diff y que son la diferencia entre que se
 * pueda usar y que no: la tabla NO se vacía entre sondeos (nada parpadea, y el
 * `Spinner` es solo de la primera carga) y las filas con novedad se resaltan en
 * vez de reordenarse debajo del cursor.
 *
 * Structure follows `/pedidos` and `/pagos-por-revisar`: a `Card`, a
 * client-side fetch in a `useCallback` + `useEffect`, an `ApiError` failure
 * state with "Reintentar", a dashed empty state, a `Table`, and the same
 * pagination footer.
 */

const FILTERS: { key: ConversationFilter; label: string }[] = [
  { key: 'escalated', label: 'Necesitan atención' },
  { key: 'human', label: 'Las atiendes tú' },
  { key: 'todas', label: 'Todas' },
  { key: 'open', label: 'Abiertas' },
];

/** `useSearchParams` (for the handoff email's `?c=` deep link) opts the route
 * into dynamic rendering, and Next refuses to prerender a client component
 * that calls it outside a Suspense boundary. */
export default function ConversacionesPage() {
  return (
    <Suspense
      fallback={
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Cargando conversaciones…
        </p>
      }
    >
      <ConversacionesContent />
    </Suspense>
  );
}

function ConversacionesContent() {
  // Defaults to the escalated view: a merchant opening this page has almost
  // always arrived from a handoff email, and the full list is noise at that
  // moment.
  const [filter, setFilter] = useState<ConversationFilter>('escalated');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ConversationListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Las filas cuyo último mensaje cambió en el último sondeo. */
  const [conNovedad, setConNovedad] = useState<Set<string>>(new Set());
  // The handoff email links to `?c=<id>`, so a merchant lands on the exact
  // conversation rather than on a list they then have to search. Seeded as
  // initial state rather than synced in an effect: this is a starting point,
  // and re-applying it would fight the merchant every time they close the
  // panel.
  const deepLinkId = useSearchParams().get('c');
  const [openId, setOpenId] = useState<string | null>(deepLinkId);

  /** Lo que se está mirando ahora, para que el sondeo pueda comparar sin
   * volverse a sí mismo una dependencia del `useCallback` (que reiniciaría el
   * intervalo en cada respuesta). */
  const ultimo = useRef<ConversationListResponse | null>(null);

  /**
   * Una pasada.
   *
   * `silencioso` es lo que hace que esto no parpadee: solo la carga de la
   * primera vez (o un "Reintentar" explícito) enciende el `Spinner` y pinta un
   * error. Un sondeo que falla se calla y deja en pantalla lo último bueno —
   * el siguiente llega en cinco segundos y lo arregla solo, mientras que
   * vaciar la tabla por un corte de red de dos segundos es perder el sitio
   * donde el comerciante estaba mirando.
   */
  const cargar = useCallback(
    async (silencioso: boolean) => {
      if (!silencioso) {
        setLoading(true);
        setLoadError(null);
      }
      try {
        const resultado = await listConversations(filter, page);
        setConNovedad(conversacionesConNovedad(ultimo.current?.items ?? [], resultado.items));
        ultimo.current = resultado;
        setData(resultado);
        setLoadError(null);
      } catch (e) {
        if (silencioso) return;
        setLoadError(
          e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.',
        );
      } finally {
        if (!silencioso) setLoading(false);
      }
    },
    [filter, page],
  );

  useEffect(() => {
    // Cambiar de filtro o de página es una lista distinta: nada de lo anterior
    // sirve para decidir qué es novedad.
    ultimo.current = null;
    setConNovedad(new Set());
    void cargar(false);

    const id = setInterval(() => {
      // Una pestaña de fondo no sondea. Al volver, el primer sondeo trae el
      // estado completo igual — no hay nada que recuperar.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void cargar(true);
    }, INTERVALO_LISTA_MS);
    return () => clearInterval(id);
  }, [cargar]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <Card className="w-full max-w-4xl">
      <CardHeader>
        <CardTitle>Conversaciones</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2" role="tablist">
            {FILTERS.map((f) => (
              <Button
                key={f.key}
                type="button"
                role="tab"
                aria-selected={filter === f.key}
                variant={filter === f.key ? 'default' : 'ghost'}
                size="sm"
                onClick={() => {
                  setFilter(f.key);
                  setPage(1);
                }}
              >
                {f.label}
              </Button>
            ))}
          </div>
          {/* The unfiltered count, so this stays truthful while a filtered
              list is on screen. */}
          {data && data.escalatedCount > 0 ? (
            <span className="text-sm text-muted-foreground">{data.escalatedCount} sin atender</span>
          ) : null}
        </div>

        {loadError ? (
          <div className="flex flex-col gap-3">
            <Alert variant="error">{loadError}</Alert>
            <Button variant="secondary" size="sm" className="self-start" onClick={() => void cargar(false)}>
              Reintentar
            </Button>
          </div>
        ) : loading && !data ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Cargando conversaciones…
          </p>
        ) : !data || data.items.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            {filter === 'escalated'
              ? 'Ninguna conversación necesita atención ahora mismo.'
              : filter === 'human'
                ? 'No estás atendiendo ninguna conversación ahora mismo.'
                : 'Tu asistente todavía no ha tenido conversaciones.'}
          </div>
        ) : (
          <>
            <Table>
              <Thead>
                <Tr>
                  <Th>Estado</Th>
                  <Th>Cliente</Th>
                  <Th>Canal</Th>
                  <Th>Último mensaje</Th>
                  <Th>Inicio</Th>
                  <Th />
                </Tr>
              </Thead>
              <Tbody>
                {data.items.map((conversation) => (
                  <Tr
                    key={conversation.id}
                    // Que se NOTE que llegó algo. Un borde a la izquierda y no
                    // un fondo entero: marca la fila sin repintar la tabla, que
                    // es lo que hay que evitar cuando esto se refresca solo.
                    className={
                      conNovedad.has(conversation.id) ? 'border-l-4 border-l-primary bg-primary/5' : undefined
                    }
                  >
                    <Td>
                      <Badge variant={STATUS_BADGE_VARIANT[conversation.status]}>
                        {STATUS_LABEL[conversation.status]}
                      </Badge>
                    </Td>
                    <Td>
                      {conversation.shopperRef ?? (
                        <span className="text-muted-foreground">Sin datos de contacto</span>
                      )}
                    </Td>
                    <Td>{CHANNEL_LABEL[conversation.channel] ?? conversation.channel}</Td>
                    <Td className="max-w-xs truncate">
                      {/* Quién lo dijo, no solo qué: distingue «el cliente
                          escribió y nadie ha contestado» de «ya le
                          contestamos». */}
                      {conversation.lastMessage ? (
                        <>
                          {conversation.lastMessageRole === 'user' ? null : (
                            <span className="text-muted-foreground">
                              {conversation.lastMessageRole === 'human' ? 'Tú: ' : 'Asistente: '}
                            </span>
                          )}
                          {conversation.lastMessage}
                        </>
                      ) : (
                        '—'
                      )}
                    </Td>
                    <Td>{formatDateCO(conversation.startedAt)}</Td>
                    <Td>
                      <Button variant="ghost" size="sm" onClick={() => setOpenId(conversation.id)}>
                        {conversation.status === 'escalated' ? 'Atender' : 'Ver'}
                      </Button>
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>

            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>
                Página {data.page} de {totalPages}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={data.page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Anterior
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={data.page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Siguiente
                </Button>
              </div>
            </div>
          </>
        )}

        {openId ? (
          <ConversacionPanel
            conversationId={openId}
            onClose={() => setOpenId(null)}
            // La lista se refresca sola cada pocos segundos, pero un cambio que
            // acaba de hacer el comerciante tiene que verse YA: esperar al
            // siguiente sondeo después de pulsar un botón se lee como que el
            // botón no hizo nada.
            onChanged={() => void cargar(true)}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
