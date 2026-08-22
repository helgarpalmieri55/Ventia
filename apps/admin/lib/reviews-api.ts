import { ApiError, apiFetch } from './api';
import { errorMessage } from './errors';

/**
 * Client for `/v1/admin/reviews` — the Reseñas screen.
 *
 * ## What the merchant can and cannot do, and why the list is short
 *
 * Hide, unhide, reply, withdraw the reply. There is no approve action and no
 * pending queue, because reviews on this platform publish immediately: a review
 * requires a completed purchase, and that requirement is what replaces
 * moderation (see the `Review` model in `packages/db/prisma/schema.prisma`).
 * The merchant's remedy is after the fact, on purpose — a queue would silently
 * cost a small store every review it never got round to approving.
 *
 * The merchant also cannot edit a shopper's words. Nothing here sends a
 * `rating`, `title` or `bodyMd`, and the API's schema would refuse them: a
 * merchant who could rewrite reviews would make every review in the store
 * worthless, including the good ones they earned.
 *
 * Types are hand-written rather than imported — same reason as
 * `customers-api.ts`: this app cannot reach into `services/api/src`.
 */

export const REVIEWS_PATH = '/resenas';

export type ReviewStatus = 'published' | 'hidden';

export interface AdminReview {
  id: string;
  rating: number;
  title: string | null;
  bodyMd: string;
  status: ReviewStatus;
  replyMd: string | null;
  repliedAt: string | null;
  createdAt: string;
  /** The purchase this review rests on — surfaced so a merchant reading a
   * complaint can go and look at the actual order. */
  orderId: string;
  product: { id: string; name: string; slug: string };
  /** Full name and address, unlike the storefront's abbreviated `authorLabel`.
   * This person bought from this merchant; both are already in their orders
   * list, and answering a complaint often means writing to them. */
  author: { name: string | null; email: string };
}

export interface ReviewListResponse {
  items: AdminReview[];
  total: number;
  page: number;
  pageSize: number;
}

/** The filter the screen offers. `'all'` is the default view: moderation is a
 * "what came in since I last looked" job, and hiding the hidden ones by
 * default would make an already-hidden review very hard to find again. */
export type StatusFilter = 'all' | ReviewStatus;

export const STATUS_FILTERS: StatusFilter[] = ['all', 'published', 'hidden'];

export const STATUS_FILTER_LABELS: Record<StatusFilter, string> = {
  all: 'Todas',
  published: 'Publicadas',
  hidden: 'Ocultas',
};

export const STATUS_LABELS: Record<ReviewStatus, string> = {
  published: 'Publicada',
  hidden: 'Oculta',
};

/** `Badge` variants from `@ventia/ui`. A hidden review is not an error — the
 * merchant chose it — so it reads as a neutral state, not a red one. */
export function statusTone(status: ReviewStatus): 'default' | 'secondary' {
  return status === 'published' ? 'default' : 'secondary';
}

export async function listReviews(
  filter: StatusFilter,
  page: number,
  pageSize = 20,
): Promise<ReviewListResponse> {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  // `all` is this client's word, not the API's: the API filters when it is
  // given a status and returns everything when it is not.
  if (filter !== 'all') params.set('status', filter);
  return apiFetch<ReviewListResponse>(`/v1/admin/reviews?${params.toString()}`);
}

export async function setReviewStatus(id: string, status: ReviewStatus): Promise<AdminReview> {
  return apiFetch<AdminReview>(`/v1/admin/reviews/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

/** Writes or rewrites the public answer. */
export async function replyToReview(id: string, replyMd: string): Promise<AdminReview> {
  return apiFetch<AdminReview>(`/v1/admin/reviews/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ replyMd: replyMd.trim() }),
  });
}

/**
 * Withdraws the reply.
 *
 * `null`, explicitly — the API treats an absent `replyMd` as "don't touch it"
 * and `null` as "delete it", and it clears `repliedAt` at the same time. A
 * reply is the merchant's own public speech, often written at the moment they
 * were most annoyed by a complaint, and being able to take it back is the
 * point. The shopper's half stays immutable either way.
 */
export async function deleteReviewReply(id: string): Promise<AdminReview> {
  return apiFetch<AdminReview>(`/v1/admin/reviews/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ replyMd: null }),
  });
}

/** Mirrors `REVIEW_REPLY_MAX` in `@ventia/core`. A local copy so the textarea
 * can bound itself; `replyError` keeps it honest and the API refuses anything
 * longer regardless. */
export const REPLY_MAX = 4000;

/** Validation before sending. Returns an es-CO message or `null`. An empty
 * reply is a mis-click rather than a deletion — deleting is its own button,
 * because "clear the box and save" is far too easy to do by accident to a
 * paragraph that is publicly visible. */
export function replyError(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 'Escribe tu respuesta.';
  if (trimmed.length > REPLY_MAX) return `La respuesta no puede pasar de ${REPLY_MAX} caracteres.`;
  return null;
}

/** A rating as filled/empty stars, for a table cell where a number alone is
 * hard to scan. Kept a pure string so it can be tested without a DOM. */
export function starsLabel(rating: number): string {
  const filled = Math.max(0, Math.min(5, Math.round(rating)));
  return '★'.repeat(filled) + '☆'.repeat(5 - filled);
}

/** How the reviewer is named in the admin table. The email is the fallback
 * because it is how the merchant will actually find this person in their own
 * orders list — not a privacy leak here, since they already have it. */
export function reviewerLabel(author: AdminReview['author']): string {
  return author.name?.trim() || author.email;
}

/** The one-line preview in the table. Falls back to saying there is no text,
 * rather than rendering an empty cell that looks like a loading bug — a rating
 * with no words is a perfectly normal review. */
export function reviewExcerpt(review: AdminReview, maxLength = 120): string {
  const text = review.title?.trim() || review.bodyMd.trim();
  if (text.length === 0) return 'Sin texto';
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * es-CO copy for a failure on this screen.
 *
 * Delegates to the shared `errorMessage` for every code it already knows, and
 * adds the one this feature introduced. `REVIEW_NOT_FOUND` is the answer for a
 * review that was deleted underneath the merchant (the shopper's account being
 * removed cascades it away) AND for one belonging to another store — the API
 * says the same thing to both on purpose, so the copy has to work for both.
 */
export function reviewErrorMessage(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Ocurrió un error inesperado. Intenta de nuevo.';
  if (e.code === 'REVIEW_NOT_FOUND') return 'Esta reseña ya no existe. Actualiza la página.';
  return errorMessage(e);
}
