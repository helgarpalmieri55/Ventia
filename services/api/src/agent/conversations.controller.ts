import { Controller, Get, HttpException, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { tenantDb } from '@ventia/db';
import { AdminSessionGuard } from '../admin/admin-session.guard';
import { AdminSession, type AdminSessionContext } from '../admin/roles.decorator';

/**
 * What the merchant reads when their agent hands a conversation over.
 *
 * `escalate_to_human` emails the merchant "un cliente necesita ayuda" — and
 * for a web-widget shopper who never left a phone number, that email is
 * useless without somewhere to go and read what actually happened. This is
 * that somewhere. Without it the escalation tool is a promise the product
 * does not keep.
 *
 * Not owner-only, matching orders and payment alerts: answering an escalated
 * shopper is fulfilment work, not account administration.
 */

/** Newest first, and bounded — a busy store accumulates thousands of these and
 * nothing here needs to load them all. */
const PAGE_SIZE = 30;
/** How much of a conversation a transcript view returns. Well past any real
 * shopper chat; the cap exists so one pathological conversation cannot become
 * a slow query. */
const TRANSCRIPT_LIMIT = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('v1/admin/conversations')
@UseGuards(AdminSessionGuard)
export class ConversationsController {
  @Get()
  async list(
    @AdminSession() session: AdminSessionContext,
    @Query('status') status: string | undefined,
    @Query('page') page: string | undefined,
  ) {
    const { tenantId } = session;
    const db = tenantDb(tenantId);
    // Only the two statuses this product writes are accepted as a filter, so a
    // typo returns everything rather than silently matching nothing and
    // reading as "you have no escalations".
    const statusFilter = status === 'escalated' || status === 'open' ? { status } : {};
    const pageNumber = Math.max(1, Number(page) || 1);

    const where = { tenantId, ...statusFilter };
    const [rows, total, escalatedCount] = await Promise.all([
      db.conversation.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        skip: (pageNumber - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: {
          // The last thing said, so the list is scannable without opening
          // every row.
          messages: { orderBy: { createdAt: 'desc' }, take: 1, where: { role: { in: ['user', 'assistant'] } } },
          _count: { select: { messages: true } },
        },
      }),
      db.conversation.count({ where }),
      // Always the unfiltered escalated count, so the page can show "3 sin
      // atender" even while the merchant is looking at a filtered list.
      db.conversation.count({ where: { tenantId, status: 'escalated' } }),
    ]);

    return {
      items: rows.map((row) => ({
        id: row.id,
        channel: row.channel,
        status: row.status,
        shopperRef: row.shopperRef,
        startedAt: row.startedAt,
        messageCount: row._count.messages,
        lastMessage: row.messages[0]?.content ?? null,
      })),
      total,
      page: pageNumber,
      pageSize: PAGE_SIZE,
      escalatedCount,
    };
  }

  @Get(':id')
  async findOne(@AdminSession() session: AdminSessionContext, @Param('id') id: string) {
    if (!UUID.test(id)) throw new HttpException({ error: 'CONVERSATION_NOT_FOUND' }, 404);
    const { tenantId } = session;
    const db = tenantDb(tenantId);

    const conversation = await db.conversation.findFirst({ where: { id, tenantId } });
    if (!conversation) throw new HttpException({ error: 'CONVERSATION_NOT_FOUND' }, 404);

    const messages = await db.message.findMany({
      where: { tenantId, conversationId: id, role: { in: ['user', 'assistant'] } },
      orderBy: { createdAt: 'asc' },
      take: TRANSCRIPT_LIMIT,
    });

    return {
      id: conversation.id,
      channel: conversation.channel,
      status: conversation.status,
      shopperRef: conversation.shopperRef,
      startedAt: conversation.startedAt,
      // `tool` rows are deliberately excluded. They are a debugging record of
      // which tools ran, not something a merchant reading "what did my agent
      // say to this customer" needs — and they carry raw tool output that
      // would bury the actual conversation.
      messages: messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
      })),
    };
  }

  /**
   * Marks an escalated conversation as handled.
   *
   * Without it the escalated list only ever grows, and a merchant cannot tell
   * yesterday's answered case from this morning's unanswered one — which makes
   * the list useless exactly as it gets long enough to matter.
   */
  @Patch(':id/resolve')
  async resolve(@AdminSession() session: AdminSessionContext, @Param('id') id: string) {
    if (!UUID.test(id)) throw new HttpException({ error: 'CONVERSATION_NOT_FOUND' }, 404);
    const db = tenantDb(session.tenantId);

    const conversation = await db.conversation.findFirst({ where: { id, tenantId: session.tenantId } });
    if (!conversation) throw new HttpException({ error: 'CONVERSATION_NOT_FOUND' }, 404);

    const updated = await db.conversation.update({ where: { id }, data: { status: 'resolved' } });
    return { id: updated.id, status: updated.status };
  }
}
