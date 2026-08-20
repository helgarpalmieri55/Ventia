import { Body, Controller, Inject, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { agentMessageInput, type AgentMessageInput } from '@ventia/core';
import { parseOr400 } from '../catalog/parse';
import { PublicTenantGuard } from '../storefront/public-tenant.guard';
import { StorefrontTenantId } from '../storefront/storefront-tenant.decorator';
import { AgentService, type AgentEvent, type AgentReply } from './agent.service';

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

@Controller('v1/storefront/agent')
@UseGuards(PublicTenantGuard)
export class AgentController {
  // Explicit @Inject, matching every other controller here: esbuild (vitest's
  // TS transform) doesn't emit `design:paramtypes`, so injection by type alone
  // can't resolve.
  constructor(@Inject(AgentService) private readonly agent: AgentService) {}

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
