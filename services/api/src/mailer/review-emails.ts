import type { Mailer } from './mailer';

/**
 * The one email a review sends: a notice to the merchant that a shopper has
 * just published one.
 *
 * ## It is a NOTICE, not an approval request, and the copy has to say so
 *
 * There is no moderation queue in this product — see the `Review` model's doc
 * comment and `ReviewsService`, which have no code path that can create a
 * review in a pending state. The purchase requirement does the work a queue
 * would, precisely so that a small merchant's real reviews are not held
 * unpublished for the four days between admin logins.
 *
 * That makes the wording load-bearing rather than cosmetic. An email that read
 * "una reseña está esperando tu aprobación" would describe a screen that does
 * not exist, and a merchant who believed it would leave a 1-star review live
 * for a week waiting for a button to appear. So this says, in as many words,
 * that the review is already on the store — and then offers the two things
 * they can actually do about it (reply, or hide it).
 *
 * ## Why the merchant is told at all
 *
 * Because the review is already public. Reviews are the first thing a shopper
 * reads before deciding to spend money, and the merchant's window to answer a
 * complaint publicly — which is the only lever they have — starts the moment
 * it is posted, not the next time they happen to open the admin.
 *
 * ## What is deliberately NOT in it
 *
 * The shopper's email address. The merchant is entitled to it (they shipped
 * this person a parcel, and `GET /v1/admin/reviews` shows it), but an email
 * is forwarded, quoted and left open on shared screens far more readily than
 * an authenticated admin page. The name is enough to recognise the order, and
 * the link goes to where the rest of it lives.
 */

/** Five glyphs, filled to the rating: `★★★★☆`. Plain text email, so this is
 * the only "chart" available — and it is worth having, because the number a
 * merchant reacts to is the one they can see at a glance in a notification
 * preview. Clamped rather than trusted: `rating` is 1..5 by schema, and a
 * malformed value must not produce a negative `repeat` (a RangeError inside a
 * fire-and-forget send, which would be swallowed). */
export function ratingStars(rating: number): string {
  const filled = Math.max(0, Math.min(5, Math.round(rating)));
  return '★'.repeat(filled) + '☆'.repeat(5 - filled);
}

export interface NewReviewEmailContext {
  /** Where the notice goes — the merchant's `settings.storeInfo.contactEmail`.
   * The caller skips the send entirely when there isn't one; there is no
   * invented fallback address, same as the new-order alert. */
  merchantContactEmail: string;
  tenantName: string;
  productName: string;
  rating: number;
  title: string | null;
  bodyMd: string;
  /** How the review is signed on the storefront (`reviewAuthorLabel`), NOT the
   * shopper's full identity — see the module comment. */
  authorLabel: string;
}

/**
 * Fire-and-forget from `ReviewsService.create`, same posture as the order and
 * handoff emails: the review row is already written and already public, so a
 * mail transport that is briefly down must not turn a shopper's successful
 * POST into an error. The thing the merchant works from is the admin list, not
 * this message.
 */
export async function sendNewReviewEmail(mailer: Mailer, ctx: NewReviewEmailContext): Promise<void> {
  // Same `ADMIN_URL` fallback every other merchant-facing link in this
  // codebase uses (staff invites, email verification, the agent handoff).
  const adminUrl = (process.env.ADMIN_URL ?? 'http://admin.ventia.localhost').replace(/\/+$/, '');

  const lines = [
    'Hola,',
    '',
    `${ctx.authorLabel} escribió una reseña de ${ctx.productName}.`,
    '',
    `Calificación: ${ratingStars(ctx.rating)} (${ctx.rating} de 5)`,
  ];

  if (ctx.title) lines.push(`Título: ${ctx.title}`);

  lines.push('');
  // A rating with no words is an ordinary review, not a broken one: the form
  // makes the body optional on purpose. Saying so beats an empty gap the
  // merchant reads as a delivery failure.
  lines.push(ctx.bodyMd.trim().length > 0 ? ctx.bodyMd.trim() : '(La reseña no trae comentario, solo la calificación.)');
  lines.push('');
  lines.push('Esta reseña YA está publicada en tu tienda: en Ventia solo puede reseñar');
  lines.push('quien compró el producto, así que no hay nada que aprobar.');
  lines.push('');
  lines.push('Desde el admin puedes responderla en público u ocultarla:');
  lines.push(`${adminUrl}/resenas`);

  await mailer.send({
    to: ctx.merchantContactEmail,
    // The rating first, because it is the part that decides whether this gets
    // opened now or tonight — and the store name last, matching the handoff
    // notice, for a merchant who runs more than one.
    subject: `Nueva reseña de ${ctx.rating} estrellas: ${ctx.productName} — ${ctx.tenantName}`,
    text: lines.join('\n'),
  });
}
