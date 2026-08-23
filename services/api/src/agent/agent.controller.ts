import { Body, Controller, Get, HttpException, Inject, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { agentMessageInput, type AgentMessageInput } from '@ventia/core';
import { parseOr400 } from '../catalog/parse';
import { PublicTenantGuard } from '../storefront/public-tenant.guard';
import { StorefrontTenantId } from '../storefront/storefront-tenant.decorator';
import { tenantDb } from '@ventia/db';
import { AgentService, type AgentEvent, type AgentReply } from './agent.service';
import { HUMAN_MESSAGE_ROLE } from './human-takeover';

/**
 * The storefront's public entry point to the AI sales agent (docs/SPEC.md §7).
 *
 * ## Two routes, one code path
 *
 * `POST messages` answers with JSON; `POST stream` answers with Server-Sent
 * Events. Both call the same `AgentService.respond` — the streaming route just
 * passes an `onEvent` callback — so there is exactly one place where tenant
 * scoping, throttling and the budget cap are decided. The widget uses the SSE
 * route (a shopper should see "Buscando productos…" rather than a spinner);
 * the JSON route exists for callers that cannot consume a stream, and is what
 * most of this surface's tests drive because a single response body is a much
 * sharper thing to assert on.
 *
 * ## Why POST for the streaming route
 *
 * `EventSource` is GET-only, which would put the shopper's message in a query
 * string — logged by every proxy in the path. `fetch` + a `ReadableStream`
 * reader consumes an SSE body over POST perfectly well and is what the widget
 * does.
 *
 * ## What guards this
 *
 * `PublicTenantGuard` resolves the tenant from the request's domain and
 * refuses draft or suspended stores — the tenant is NEVER taken from the body,
 * so a caller cannot address another merchant's agent or budget. Beyond that
 * the endpoint is deliberately anonymous: it is a storefront chat widget, and
 * requiring an account to ask "¿tienen esta camisa en talla M?" would defeat
 * it. Abuse is bounded by the IP limiter in main.ts and the per-conversation
 * throttle inside the service.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Cuántas respuestas humanas devuelve un sondeo. Muy por encima de lo que una
 * persona escribe entre dos sondeos; el tope existe para que una conversación
 * patológica no se convierta en una consulta lenta. */
const REPLIES_LIMIT = 50;

@Controller('v1/storefront/agent')
@UseGuards(PublicTenantGuard)
export class AgentController {
  // Explicit @Inject, matching every other controller here: esbuild (vitest's
  // TS transform) doesn't emit `design:paramtypes`, so injection by type alone
  // can't resolve.
  constructor(@Inject(AgentService) private readonly agent: AgentService) {}

  /**
   * Lo que una PERSONA de la tienda le escribió a este comprador desde el
   * panel, para que el widget lo enseñe sin que el comprador tenga que volver
   * a escribir.
   *
   * ## Por qué existe
   *
   * Los otros dos canales tienen entrega propia: una respuesta humana sale por
   * la Graph API y le llega al comprador esté donde esté. El widget no tiene
   * nada parecido — solo abre un stream MIENTRAS dura un turno—, así que sin
   * esto el comerciante escribiría en el panel, vería un «enviado», y el
   * comprador no recibiría nunca nada. Un fallo silencioso, que es justo lo que
   * este producto no puede permitirse en la función de atención.
   *
   * ## Por qué SOLO los mensajes de la persona, y solo del canal `web`
   *
   * Lo mínimo que resuelve el problema. Los mensajes del agente ya llegan por
   * el stream del turno, así que devolverlos aquí solo crearía duplicados que
   * el widget tendría que deduplicar. Y limitarlo a `channel = 'web'` cierra la
   * única pregunta incómoda que abre un endpoint anónimo por id: un id de
   * conversación de Instagram —que un comerciante puede tener a la vista en el
   * panel— no puede convertirse en una forma de leer ese hilo desde fuera.
   *
   * El id no es un secreto (es un UUID v4 en `sessionStorage`, y el propio
   * widget ya lo usa para continuar la conversación), pero no hace falta que lo
   * sea: lo que devuelve esto es exactamente lo que la tienda acaba de decidir
   * enviarle a quien tenga ese id.
   */
  @Get('conversations/:id/replies')
  async replies(
    @StorefrontTenantId() tenantId: string,
    @Param('id') id: string,
    @Query('after') after: string | undefined,
  ) {
    if (!UUID.test(id)) throw new HttpException({ error: 'CONVERSATION_NOT_FOUND' }, 404);
    const db = tenantDb(tenantId);
    const conversation = await db.conversation.findFirst({
      where: { id, tenantId, channel: 'web' },
      select: { id: true, status: true },
    });
    if (!conversation) throw new HttpException({ error: 'CONVERSATION_NOT_FOUND' }, 404);

    // `after` es la marca del último mensaje que el widget ya pintó. Una fecha
    // ilegible se ignora en vez de rechazarse: quien llama es un widget cuyo
    // peor caso aceptable es repetir mensajes, no quedarse sin ellos.
    const since = after ? new Date(after) : null;
    const messages = await db.message.findMany({
      where: {
        tenantId,
        conversationId: id,
        role: HUMAN_MESSAGE_ROLE,
        ...(since && Number.isFinite(since.getTime()) ? { createdAt: { gt: since } } : {}),
      },
      orderBy: { createdAt: 'asc' },
      take: REPLIES_LIMIT,
      select: { id: true, content: true, createdAt: true },
    });

    return {
      // Para que el widget pueda decir «te está atendiendo una persona» en vez
      // de dejar al comprador esperando una respuesta automática que no va a
      // llegar.
      status: conversation.status,
      messages,
    };
  }

  @Post('messages')
  async message(@StorefrontTenantId() tenantId: string, @Body() body: unknown): Promise<AgentReply> {
    const input = parseOr400<AgentMessageInput>(agentMessageInput, body);
    return this.agent.respond({ tenantId, ...input });
  }

  @Post('stream')
  async stream(
    @StorefrontTenantId() tenantId: string,
    @Body() body: unknown,
    @Res() res: Response,
  ): Promise<void> {
    // Validated BEFORE any header is written: once the stream is open the
    // status code is spent, and a validation failure would have to be
    // delivered as an SSE `error` event that a fetch caller has to hand-parse.
    // Throwing here still produces an ordinary 400.
    const input = parseOr400<AgentMessageInput>(agentMessageInput, body);

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Caddy buffers proxied responses by default, which would hold every event
    // until the turn finished and make the stream pointless.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (event: AgentEvent | { type: 'done' } | { type: 'error'; message: string }) => {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    try {
      const reply = await this.agent.respond({ tenantId, ...input, onEvent: send });
      // A terminal event carrying the same fields the JSON route returns, so a
      // widget that reconnects mid-turn has one thing to look for and does not
      // have to reassemble state from the progress events.
      send({ type: 'done', ...reply } as unknown as { type: 'done' });
    } catch (err) {
      // The status is already 200 by now, so a failure has to arrive in-band.
      // The shopper-facing text is generic on purpose — this body renders in a
      // chat window.
      console.error('[agent] turn failed', { error: err instanceof Error ? err.message : String(err) });
      send({ type: 'error', message: 'No pude responderte en este momento. Intenta de nuevo.' });
    } finally {
      res.end();
    }
  }
}
