import { Body, Controller, Get, HttpException, Inject, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { REVIEW_STATUSES, reviewModerationSchema, type ReviewStatusValue } from '@ventia/core';
import { AdminSessionGuard } from '../admin/admin-session.guard';
import { AdminSession, type AdminSessionContext } from '../admin/roles.decorator';
import { writeAudit } from '../catalog/audit';
import { parseOr400 } from '../catalog/parse';
import { assertUuidOr404 } from '../catalog/uuid';
import { ReviewsService } from './reviews.service';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function parsePositiveIntOr400(raw: string | undefined, field: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new HttpException({ error: 'VALIDATION_FAILED', details: { [field]: 'debe ser un número válido' } }, 400);
  }
  return value;
}

function parseStatusOr400(raw: string | undefined): ReviewStatusValue | undefined {
  if (raw === undefined || raw === '' || raw === 'all') return undefined;
  if ((REVIEW_STATUSES as readonly string[]).includes(raw)) return raw as ReviewStatusValue;
  throw new HttpException({ error: 'VALIDATION_FAILED', details: { status: 'estado desconocido' } }, 400);
}

/**
 * Moderation, after the fact.
 *
 * The merchant can HIDE a review and REPLY to one. There is deliberately no
 * approve, no pending queue and no way to edit what the shopper wrote — the
 * `Review` model's doc comment explains the trade that buys: reviews publish
 * immediately, because a queue on this platform means a merchant who opens
 * their admin twice a week silently loses every review they never got round
 * to, and the sabotage a queue guards against costs an attacker a completed
 * purchase per review here.
 *
 * No `@Roles()`: both `owner` and `staff` may moderate, matching the orders
 * and conversations controllers. Answering the shopper who wrote "llegó rota"
 * is fulfilment work, not account administration, and a store where only the
 * owner can reply is a store that replies days late.
 */
@Controller('v1/admin/reviews')
@UseGuards(AdminSessionGuard)
export class AdminReviewsController {
  // Explicit @Inject: esbuild (vitest's transform) emits no `design:paramtypes`.
  constructor(@Inject(ReviewsService) private readonly reviews: ReviewsService) {}

  @Get()
  async list(
    @AdminSession() session: AdminSessionContext,
    @Query('status') status?: string,
    @Query('productId') productId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    if (productId !== undefined) assertUuidOr404(productId);
    return this.reviews.listForAdmin(session.tenantId, {
      status: parseStatusOr400(status),
      productId,
      page: parsePositiveIntOr400(page, 'page', 1),
      pageSize: Math.min(parsePositiveIntOr400(pageSize, 'pageSize', DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE),
    });
  }

  /**
   * Hide/unhide, and write or withdraw a reply.
   *
   * Audited. Hiding a review changes what every future shopper sees AND the
   * average printed above it, and "who took this down, and when" is the first
   * question anyone asks afterwards — including the shopper who wrote it, who
   * is told on the product page that their review is not visible.
   */
  @Patch(':id')
  async moderate(@AdminSession() session: AdminSessionContext, @Param('id') id: string, @Body() body: unknown) {
    assertUuidOr404(id);
    const input = parseOr400(reviewModerationSchema, body);
    const review = await this.reviews.moderate(session.tenantId, id, input);

    // The audit payload names the ACTION rather than echoing the review's
    // text: an audit row is not the place to duplicate a shopper's words, and
    // the review itself is still in the table to read.
    await writeAudit(session, 'review.moderate', 'Review', review.id, {
      status: input.status,
      reply: input.replyMd === undefined ? undefined : input.replyMd === null ? 'deleted' : 'written',
    });
    return review;
  }
}
