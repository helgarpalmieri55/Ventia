'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  Spinner,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from '@ventia/ui';
import { formatDateCO } from '../../../lib/format';
import {
  REPLY_MAX,
  STATUS_FILTERS,
  STATUS_FILTER_LABELS,
  STATUS_LABELS,
  deleteReviewReply,
  listReviews,
  replyError,
  replyToReview,
  reviewErrorMessage,
  reviewExcerpt,
  reviewerLabel,
  setReviewStatus,
  starsLabel,
  statusTone,
  type AdminReview,
  type ReviewListResponse,
  type StatusFilter,
} from '../../../lib/reviews-api';

const PAGE_SIZE = 20;

/**
 * Reseñas — what customers said, and the two things the merchant can do about
 * it.
 *
 * ## There is nothing to approve here, deliberately
 *
 * A review on this platform is already live by the time the merchant sees it.
 * Only someone with a completed purchase can write one, and that requirement
 * is what replaces a moderation queue (see the `Review` model's doc comment):
 * a queue would mean a merchant who opens this screen twice a week silently
 * loses every review they never got round to approving, while the sabotage a
 * queue defends against costs an attacker a real purchase per review here.
 *
 * So this screen has two verbs — ocultar and responder — and the more useful
 * of the two is the second one. Answering a bad review in public is worth more
 * to a small store than hiding it, and the layout says so: replying is the
 * primary action on every row, hiding is the quiet one.
 */
export default function ResenasPage() {
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<ReviewListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setResult(await listReviews(filter, page, PAGE_SIZE));
    } catch (e) {
      setLoadError(reviewErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [filter, page]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Applies one review's new state in place instead of refetching the page.
   * Hiding a review from the "Publicadas" filter would otherwise make the row
   * vanish mid-click, which reads as "something went wrong" rather than "done"
   * — and the merchant usually wants to reply to the same review next. */
  function applyUpdate(updated: AdminReview) {
    setResult((current) =>
      current ? { ...current, items: current.items.map((r) => (r.id === updated.id ? updated : r)) } : current,
    );
  }

  async function run(action: () => Promise<AdminReview>) {
    setActionError(null);
    try {
      applyUpdate(await action());
      return true;
    } catch (e) {
      setActionError(reviewErrorMessage(e));
      return false;
    }
  }

  // --- reply dialog ---
  const [replyTarget, setReplyTarget] = useState<AdminReview | null>(null);
  const [replyText, setReplyText] = useState('');
  const [replyValidation, setReplyValidation] = useState<string | null>(null);
  const [replySaving, setReplySaving] = useState(false);

  function openReply(review: AdminReview) {
    setReplyTarget(review);
    // Pre-filled with the existing reply so "responder" doubles as "editar":
    // a reply the merchant regrets is far more common than one they never
    // wrote, and making them retype it invites a worse second version.
    setReplyText(review.replyMd ?? '');
    setReplyValidation(null);
  }

  async function saveReply() {
    if (!replyTarget) return;
    const invalid = replyError(replyText);
    if (invalid) {
      setReplyValidation(invalid);
      return;
    }
    setReplySaving(true);
    const ok = await run(() => replyToReview(replyTarget.id, replyText));
    setReplySaving(false);
    if (ok) setReplyTarget(null);
  }

  return (
    <main className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Reseñas</h1>
          <p className="text-sm text-muted-foreground">
            Solo pueden reseñar quienes compraron el producto, y las reseñas se publican de inmediato. Puedes
            responderlas o, si es necesario, ocultarlas.
          </p>
        </div>
        <div className="flex gap-2">
          {STATUS_FILTERS.map((option) => (
            <Button
              key={option}
              size="sm"
              variant={filter === option ? 'default' : 'secondary'}
              onClick={() => {
                setFilter(option);
                setPage(1);
              }}
            >
              {STATUS_FILTER_LABELS[option]}
            </Button>
          ))}
        </div>
      </div>

      {actionError ? <Alert variant="error">{actionError}</Alert> : null}
      {loadError ? <Alert variant="error">{loadError}</Alert> : null}

      <Card>
        <CardHeader>
          <CardTitle>{result ? `${result.total} en total` : 'Reseñas'}</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> Cargando…
            </p>
          ) : result && result.items.length > 0 ? (
            <Table>
              <Thead>
                <Tr>
                  <Th>Producto</Th>
                  <Th>Calificación</Th>
                  <Th>Reseña</Th>
                  <Th>Cliente</Th>
                  <Th>Fecha</Th>
                  <Th>Estado</Th>
                  <Th>Acciones</Th>
                </Tr>
              </Thead>
              <Tbody>
                {result.items.map((review) => (
                  <Tr key={review.id}>
                    <Td>{review.product.name}</Td>
                    <Td>
                      <span title={`${review.rating} de 5`} className="text-amber-500">
                        {starsLabel(review.rating)}
                      </span>
                    </Td>
                    <Td>
                      <span className="block max-w-md">{reviewExcerpt(review)}</span>
                      {review.replyMd ? (
                        <span className="mt-1 block max-w-md text-xs text-muted-foreground">
                          Respondida: {review.replyMd}
                        </span>
                      ) : null}
                    </Td>
                    <Td>{reviewerLabel(review.author)}</Td>
                    <Td>{formatDateCO(review.createdAt)}</Td>
                    <Td>
                      <Badge variant={statusTone(review.status)}>{STATUS_LABELS[review.status]}</Badge>
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" onClick={() => openReply(review)}>
                          {review.replyMd ? 'Editar respuesta' : 'Responder'}
                        </Button>
                        {review.replyMd ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void run(() => deleteReviewReply(review.id))}
                          >
                            Borrar respuesta
                          </Button>
                        ) : null}
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() =>
                            void run(() =>
                              setReviewStatus(review.id, review.status === 'hidden' ? 'published' : 'hidden'),
                            )
                          }
                        >
                          {review.status === 'hidden' ? 'Mostrar' : 'Ocultar'}
                        </Button>
                      </div>
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">
              {filter === 'hidden'
                ? 'No has ocultado ninguna reseña.'
                : 'Todavía no tienes reseñas. Aparecerán aquí apenas un cliente reseñe algo que compró.'}
            </p>
          )}
        </CardContent>
      </Card>

      {result && result.total > PAGE_SIZE ? (
        <div className="flex items-center gap-3">
          <Button size="sm" variant="secondary" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
            Anterior
          </Button>
          <span className="text-sm text-muted-foreground">
            Página {result.page} de {Math.max(1, Math.ceil(result.total / PAGE_SIZE))}
          </span>
          <Button
            size="sm"
            variant="secondary"
            disabled={page >= Math.ceil(result.total / PAGE_SIZE)}
            onClick={() => setPage((p) => p + 1)}
          >
            Siguiente
          </Button>
        </div>
      ) : null}

      <Dialog open={replyTarget !== null} onClose={() => setReplyTarget(null)}>
        <div className="flex w-full max-w-lg flex-col gap-4">
          <h2 className="text-lg font-semibold">Responder públicamente</h2>
          {replyTarget ? (
            <div className="rounded-md bg-muted/40 p-3 text-sm">
              <p className="text-amber-500">{starsLabel(replyTarget.rating)}</p>
              <p className="whitespace-pre-wrap">{reviewExcerpt(replyTarget, 400)}</p>
            </div>
          ) : null}
          <textarea
            value={replyText}
            maxLength={REPLY_MAX}
            rows={5}
            onChange={(e) => setReplyText(e.target.value)}
            aria-label="Tu respuesta"
            placeholder="Tu respuesta aparecerá debajo de la reseña, en la tienda."
            className="w-full rounded-md border border-border bg-background p-2 text-sm"
          />
          {replyValidation ? <Alert variant="error">{replyValidation}</Alert> : null}
          <p className="text-xs text-muted-foreground">
            Se publica de inmediato en la página del producto. Puedes editarla o borrarla después.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setReplyTarget(null)}>
              Cancelar
            </Button>
            <Button disabled={replySaving} onClick={() => void saveReply()}>
              {replySaving ? 'Publicando…' : 'Publicar respuesta'}
            </Button>
          </div>
        </div>
      </Dialog>
    </main>
  );
}
