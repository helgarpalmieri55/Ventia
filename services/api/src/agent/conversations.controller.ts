import { Body, Controller, Get, HttpException, Inject, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { tenantDb } from '@ventia/db';
import { AdminSessionGuard } from '../admin/admin-session.guard';
import { AdminSession, type AdminSessionContext } from '../admin/roles.decorator';
import { HumanReplyService, type ReplyableConversation } from './human-reply.service';
import { HUMAN_ATTENDED_STATUS, TRANSCRIPT_ROLES } from './human-takeover';

/**
 * La bandeja de atención del comerciante: lo que ha dicho su agente, y el sitio
 * desde el que una persona toma el relevo.
 *
 * Empezó siendo solo lectura, porque `escalate_to_human` no significaba nada
 * sin un sitio donde leer el traspaso — el correo de aviso enlaza a una fila de
 * aquí, y para un comprador del widget web que nunca dejó un teléfono este
 * transcripto es lo ÚNICO que tiene el comerciante. Pero leer no es atender: la
 * herramienta prometía «te paso con una persona» y esa persona no tenía por
 * dónde contestar. `POST :id/reply` es esa mitad que faltaba.
 *
 * No es solo del propietario, igual que pedidos y avisos de pago: contestarle a
 * un cliente es trabajo de tienda, no de administración de la cuenta.
 */

/** Newest first, and bounded — a busy store accumulates thousands of these and
 * nothing here needs to load them all. */
const PAGE_SIZE = 30;
/** How much of a conversation a transcript view returns. Well past any real
 * shopper chat; the cap exists so one pathological conversation cannot become
 * a slow query. */
const TRANSCRIPT_LIMIT = 200;

/** Los estados que este producto escribe y que por tanto se aceptan como
 * filtro. Un valor que no esté aquí devuelve todo, en vez de una lista vacía
 * que se leería como «no tienes nada». */
const FILTERABLE_STATUSES = new Set(['escalated', 'open', 'human']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** El tope duro del cuerpo de una respuesta humana.
 *
 * Es el mayor de los topes de canal (WhatsApp, 4096) y no el de cada canal: el
 * troceo por canal lo hace `HumanReplyService`, y este número solo existe para
 * que un cliente roto no pueda mandar un megabyte. El tope REAL que ve el
 * comerciante viaja en `replyMaxChars` del detalle. */
const REPLY_MAX_CHARS = 4096;

/** Los campos de `Conversation` que necesita el camino de respuesta. Un select
 * explícito para que añadir una columna a la tabla no la publique sin querer
 * por esta API. */
const REPLYABLE_SELECT = {
  id: true,
  channel: true,
  status: true,
  shopperRef: true,
  startedAt: true,
  lastInboundAt: true,
  channelAccountId: true,
} as const;

@Controller('v1/admin/conversations')
@UseGuards(AdminSessionGuard)
export class ConversationsController {
  // @Inject explícito como en el resto de controladores de este repositorio:
  // esbuild (la transformación de TS de vitest) no emite `design:paramtypes`,
  // así que la inyección por tipo no resuelve.
  constructor(@Inject(HumanReplyService) private readonly humanReply: HumanReplyService) {}

  @Get()
  async list(
    @AdminSession() session: AdminSessionContext,
    @Query('status') status: string | undefined,
    @Query('page') page: string | undefined,
  ) {
    const { tenantId } = session;
    const db = tenantDb(tenantId);
    const statusFilter = status && FILTERABLE_STATUSES.has(status) ? { status } : {};
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
          // every row. Incluye `human`: si lo último que se dijo lo escribió el
          // comerciante, la lista tiene que enseñar eso y no el mensaje del
          // agente de antes.
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            where: { role: { in: [...TRANSCRIPT_ROLES] } },
          },
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
        // Cuándo se dijo, no solo qué. Es lo que le permite al panel darse
        // cuenta de que llegó algo nuevo entre dos sondeos sin comparar textos
        // —dos mensajes iguales seguidos son perfectamente normales— y sin
        // depender del número de mensajes, que no cambia cuando el retentor
        // borra los viejos.
        lastMessageAt: row.messages[0]?.createdAt ?? null,
        // El rol de lo último dicho, para que la lista distinga «el cliente
        // escribió y nadie ha contestado» de «ya le contestamos».
        lastMessageRole: row.messages[0]?.role ?? null,
      })),
      total,
      page: pageNumber,
      pageSize: PAGE_SIZE,
      escalatedCount,
    };
  }

  @Get(':id')
  async findOne(@AdminSession() session: AdminSessionContext, @Param('id') id: string) {
    const { tenantId } = session;
    const conversation = await this.findOr404(tenantId, id);

    const messages = await tenantDb(tenantId).message.findMany({
      where: { tenantId, conversationId: id, role: { in: [...TRANSCRIPT_ROLES] } },
      orderBy: { createdAt: 'asc' },
      take: TRANSCRIPT_LIMIT,
    });

    // Se calcula al ABRIR, no al enviar: el panel tiene que poder decir «esta
    // conversación ya no admite respuesta» antes de que el comerciante escriba.
    const reply = await this.humanReply.replyState(tenantId, conversation);

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
      canReply: reply.canReply,
      replyBlockedReason: reply.blockedReason,
      replyWindowClosesAt: reply.windowClosesAt,
      replyMaxChars: reply.maxChars,
    };
  }

  /**
   * El comerciante contesta, como persona.
   *
   * El cuerpo sale por el canal de esta conversación TAL CUAL: sin revelación
   * de experiencia automatizada, porque no la escribe una máquina. Ver
   * `human-reply.service.ts`.
   *
   * Y deja la conversación en `human`, que es lo que calla al agente mientras
   * la atiende una persona.
   */
  @Post(':id/reply')
  async reply(
    @AdminSession() session: AdminSessionContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const { tenantId } = session;
    const text = replyTextOr400(body);
    const conversation = await this.findOr404(tenantId, id);

    const message = await this.humanReply.send(tenantId, conversation, text);
    return {
      id: conversation.id,
      status: HUMAN_ATTENDED_STATUS,
      message: {
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
      },
    };
  }

  /**
   * Le devuelve la conversación al asistente.
   *
   * Es la salida de `human`, y tiene que existir por la misma razón por la que
   * existe la entrada: sin ella, contestar una vez dejaría esa conversación
   * muda para siempre y el comerciante acabaría no contestando nunca desde
   * aquí. El siguiente mensaje del agente vuelve a revelar que es automatizado
   * —el comprador acaba de hablar con una persona y cree que sigue hablando con
   * ella—, y de eso se encarga `needsDisclosureAfter`.
   */
  @Patch(':id/handback')
  async handback(@AdminSession() session: AdminSessionContext, @Param('id') id: string) {
    const { tenantId } = session;
    const conversation = await this.findOr404(tenantId, id);

    const updated = await tenantDb(tenantId).conversation.update({
      where: { id: conversation.id },
      // A `open` y no a `escalated`: devolverla al asistente es decir «ya está,
      // el bot puede seguir», y dejarla marcada como pendiente de atención
      // volvería a llenar de ruido la lista que existe para lo contrario.
      data: { status: 'open' },
    });
    return { id: updated.id, status: updated.status };
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
    const { tenantId } = session;
    const conversation = await this.findOr404(tenantId, id);

    const updated = await tenantDb(tenantId).conversation.update({
      where: { id: conversation.id },
      data: { status: 'resolved' },
    });
    return { id: updated.id, status: updated.status };
  }

  /** La conversación de ESTE inquilino, o un 404. El filtro por `tenantId` es
   * lo que impide que un id de fuera llegue al transcripto de otra tienda, y un
   * id mal formado se responde 404 aquí en vez de reventar la consulta. */
  private async findOr404(tenantId: string, id: string): Promise<ReplyableConversation & { startedAt: Date }> {
    if (!UUID.test(id)) throw new HttpException({ error: 'CONVERSATION_NOT_FOUND' }, 404);
    const conversation = await tenantDb(tenantId).conversation.findFirst({
      where: { id, tenantId },
      select: REPLYABLE_SELECT,
    });
    if (!conversation) throw new HttpException({ error: 'CONVERSATION_NOT_FOUND' }, 404);
    return conversation;
  }
}

/**
 * El texto de una respuesta humana, validado.
 *
 * A mano y no con un esquema de `@ventia/core` porque es un solo campo y
 * porque el tope de verdad es del canal, no de la API: aquí solo se corta lo
 * absurdo. Se recorta antes de medir, así que una caja de texto con espacios no
 * cuenta como mensaje — mandar un mensaje en blanco por Instagram es un error
 * del proveedor y una conversación con un hueco en el transcripto.
 */
function replyTextOr400(body: unknown): string {
  const raw = (body as { text?: unknown } | null)?.text;
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text.length === 0 || text.length > REPLY_MAX_CHARS) {
    throw new HttpException(
      { error: 'VALIDATION_FAILED', details: { fieldErrors: { text: ['Escribe un mensaje.'] } } },
      400,
    );
  }
  return text;
}
