import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { agentCommandInput, type AgentCommandInput, type AgentCommandResponse } from '@ventia/core';
import { AdminSessionGuard } from '../admin/admin-session.guard';
import { AdminSession, type AdminSessionContext } from '../admin/roles.decorator';
import { parseOr400 } from '../catalog/parse';
import { AgentCommandService } from './agent-command.service';

/**
 * `POST /v1/admin/ai/command` — the merchant asks about their own business
 * (docs/design-gap.md §7 item 6).
 *
 * ## The tenant comes from the session, and only from the session
 *
 * `AdminSessionGuard` rejects any session without a tenant before a request
 * reaches this handler, and {@link AdminSession} hands back that tenant id.
 * The body carries no tenant field and the schema forbids one. This is the
 * whole security story of the endpoint: everything downstream — every tool,
 * every query — is scoped to this one id, so there is no path by which a
 * question, however phrased, reaches another store's takings.
 *
 * ## Not owner-only
 *
 * Same posture as `/v1/admin/dashboard` and `AgentAdminController`, and for
 * the same reason: what this answers is a summary of orders, products and
 * conversations that a staff session can already page through one screen at a
 * time. Gating the summary while leaving the sources open would hide nothing.
 *
 * The line it does NOT cross is account administration — there is no write
 * tool here at all, so a staff member cannot use this to do anything they
 * could not already do.
 *
 * ## Why one JSON route and no stream
 *
 * The shopper agent streams because a customer watching a chat widget feels
 * every second. A merchant asking "¿cómo vamos?" is looking at a form on their
 * own admin screen and wants the finished answer; SSE would add a transport,
 * a reconnect story and an in-band error path to buy nothing. If this ever
 * grows a conversational UI, `agent.controller.ts` next door is the shape to
 * copy.
 */
@Controller('v1/admin/ai')
@UseGuards(AdminSessionGuard)
export class AgentCommandController {
  // Explicit @Inject, matching every other controller here: esbuild (vitest's
  // TS transform) emits no `design:paramtypes`, so injection by type alone
  // cannot resolve.
  constructor(@Inject(AgentCommandService) private readonly assistant: AgentCommandService) {}

  @Post('command')
  // 200, not Nest's default 201 for POST. Nothing is created: this is a QUERY
  // that has to be a POST because the question belongs in a body rather than
  // in a query string every proxy in the path would log. A 201 would tell a
  // caller a resource now exists at some location, and none does.
  @HttpCode(200)
  async command(
    @AdminSession() session: AdminSessionContext,
    @Body() body: unknown,
  ): Promise<AgentCommandResponse> {
    // Parsed, not read field by field: an empty or oversized question must be
    // a 400 rather than a model call billed against the plan the storefront
    // shares.
    const input = parseOr400<AgentCommandInput>(agentCommandInput, body);
    return this.assistant.ask({ tenantId: session.tenantId, question: input.question });
  }
}
