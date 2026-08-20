'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
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
import {
  getConversation,
  listConversations,
  resolveConversation,
  STATUS_BADGE_VARIANT,
  STATUS_LABEL,
  type ConversationDetail,
  type ConversationFilter,
  type ConversationListResponse,
} from '../../../lib/conversations-api';

/**
 * "Conversaciones" — what the AI agent has been saying, and which chats it
 * handed to a person.
 *
 * This page exists because `escalate_to_human` needs it. The handoff email
 * links straight to a row here, and for a web-widget shopper who never left a
 * phone number this transcript is the merchant's ONLY way to find out who
 * needs help and what about. Without it the escalation tool is a promise the
 * product does not keep.
 *
 * Structure follows `/pedidos` and `/pagos-por-revisar`: a `Card`, a
 * client-side fetch in a `useCallback` + `useEffect`, an `ApiError` failure
 * state with "Reintentar", a dashed empty state, a `Table`, and the same
 * pagination footer.
 */

const FILTERS: { key: ConversationFilter; label: string }[] = [
  { key: 'escalated', label: 'Necesitan atención' },
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
  // The handoff email links to `?c=<id>`, so a merchant lands on the exact
  // conversation rather than on a list they then have to search. Seeded as
  // initial state rather than synced in an effect: this is a starting point,
  // and re-applying it would fight the merchant every time they close the
  // panel.
  const deepLinkId = useSearchParams().get('c');
  const [openId, setOpenId] = useState<string | null>(deepLinkId);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setData(await listConversations(filter, page));
    } catch (e) {
      setLoadError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setLoading(false);
    }
  }, [filter, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <Card className="w-full max-w-4xl">
      <CardHeader>
        <CardTitle>Conversaciones</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex gap-2" role="tablist">
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
            <span className="text-sm text-muted-foreground">
              {data.escalatedCount} sin atender
            </span>
          ) : null}
        </div>

        {loadError ? (
          <div className="flex flex-col gap-3">
            <Alert variant="error">{loadError}</Alert>
            <Button variant="secondary" size="sm" className="self-start" onClick={() => void load()}>
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
              : 'Tu asistente todavía no ha tenido conversaciones.'}
          </div>
        ) : (
          <>
            <Table>
              <Thead>
                <Tr>
                  <Th>Estado</Th>
                  <Th>Cliente</Th>
                  <Th>Último mensaje</Th>
                  <Th>Inicio</Th>
                  <Th />
                </Tr>
              </Thead>
              <Tbody>
                {data.items.map((conversation) => (
                  <Tr key={conversation.id}>
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
                    <Td className="max-w-xs truncate">{conversation.lastMessage ?? '—'}</Td>
                    <Td>{formatDateCO(conversation.startedAt)}</Td>
                    <Td>
                      <Button variant="ghost" size="sm" onClick={() => setOpenId(conversation.id)}>
                        Ver
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
          <TranscriptPanel
            conversationId={openId}
            onClose={() => setOpenId(null)}
            onResolved={() => {
              setOpenId(null);
              void load();
            }}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

/** The transcript, plus the one action a merchant can take on it. */
function TranscriptPanel({
  conversationId,
  onClose,
  onResolved,
}: {
  conversationId: string;
  onClose: () => void;
  onResolved: () => void;
}) {
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getConversation(conversationId)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof ApiError ? errorMessage(e) : 'No pudimos abrir la conversación.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  async function handleResolve() {
    setResolving(true);
    setError(null);
    try {
      await resolveConversation(conversationId);
      onResolved();
    } catch (e) {
      setError(e instanceof ApiError ? errorMessage(e) : 'No pudimos marcarla como atendida.');
      setResolving(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-md border border-border p-4" aria-label="Conversación">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">
          {detail?.shopperRef ?? 'Cliente sin datos de contacto'}
        </h3>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cerrar
        </Button>
      </div>

      {error ? <Alert variant="error">{error}</Alert> : null}

      {!detail ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Cargando…
        </p>
      ) : (
        <>
          <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto">
            {detail.messages.map((message) => (
              <li
                key={message.id}
                className={
                  message.role === 'user'
                    ? 'self-start rounded-lg bg-muted px-3 py-2 text-sm'
                    : 'self-end rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground'
                }
              >
                {message.content}
              </li>
            ))}
          </ul>

          {detail.status === 'escalated' ? (
            <Button size="sm" className="self-start" disabled={resolving} onClick={() => void handleResolve()}>
              {resolving ? 'Guardando…' : 'Marcar como atendida'}
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}
