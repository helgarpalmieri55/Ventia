import { Body, Controller, Delete, Get, HttpException, Inject, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { whatsappConnectSchema, whatsappNumberUpdateSchema, type WhatsAppConnectInput } from '@ventia/core';
import { AdminSessionGuard } from '../admin/admin-session.guard';
import { AdminSession, Roles, type AdminSessionContext } from '../admin/roles.decorator';
import { parseOr400 } from '../catalog/parse';
import { writeAudit } from '../catalog/audit';
import { assertPlanFeature, isPlanFeatureEnabled } from '../common/plan-limits';
import { WhatsAppNumbersService } from './whatsapp-numbers.service';

/**
 * The merchant's WhatsApp connection flow (docs/SPEC.md §11 P5: "number
 * connection flow in admin").
 *
 * Owner-only, like every other credential surface: connecting a number means
 * pasting a Meta access token, and a staff seat is a fulfilment role, not an
 * account-administration one. Same posture as `SettingsController`.
 */
@Controller('v1/admin/whatsapp/numbers')
@UseGuards(AdminSessionGuard)
@Roles('owner')
export class WhatsAppAdminController {
  // Explicit @Inject, matching every controller here — esbuild does not emit
  // `design:paramtypes`.
  constructor(@Inject(WhatsAppNumbersService) private readonly numbers: WhatsAppNumbersService) {}

  @Get()
  async list(@AdminSession() session: AdminSessionContext) {
    const [items, channelEnabled] = await Promise.all([
      this.numbers.listForTenant(session.tenantId),
      isPlanFeatureEnabled(session.tenantId, 'whatsappChannel'),
    ]);
    return {
      items,
      // So the page can render an upgrade prompt rather than a form that will
      // 402 on submit. Same source of truth as the gate on `connect` below —
      // the read and the enforcement must never be able to disagree.
      channelEnabled,
      // The URL the merchant pastes into the Meta dashboard. Built here rather
      // than in the client because only the server knows the API's public
      // origin, and a merchant copying a wrong callback URL is a support
      // ticket that looks like "WhatsApp doesn't work".
      callbackBaseUrl: `${apiPublicUrl()}/webhooks/whatsapp`,
    };
  }

  @Post()
  async connect(@AdminSession() session: AdminSessionContext, @Body() body: unknown) {
    const input = parseOr400<WhatsAppConnectInput>(whatsappConnectSchema, body);

    // The plan gate. Checked BEFORE the write, so a store without the channel
    // never ends up with a half-configured number it cannot use — and checked
    // again on every inbound message, because a plan can be downgraded after
    // this succeeded.
    await assertPlanFeature(session.tenantId, 'whatsappChannel');

    const { externalId, credentials } =
      input.provider === 'cloud'
        ? {
            externalId: input.phoneNumberId,
            credentials: {
              token: input.accessToken,
              appSecret: input.appSecret,
              verifyToken: input.verifyToken,
            },
          }
        : {
            externalId: input.instanceName,
            credentials: { token: input.apiKey, baseUrl: input.baseUrl },
          };

    try {
      const number = await this.numbers.connect({
        tenantId: session.tenantId,
        provider: input.provider,
        externalId,
        displayPhone: input.displayPhone,
        credentials,
      });
      // Deliberately logs the routing key and NOT the credentials — an audit
      // trail that records secrets is a second place they leak from.
      await writeAudit(session, 'whatsapp.connect', 'WhatsAppNumber', number.id, {
        provider: input.provider,
        externalId,
      });
      return number;
    } catch (err) {
      // The `externalId` unique constraint. Surfaced as a 409 a human can act
      // on rather than a 500: the honest answer is "another store already
      // registered this number", and silently taking it over would break
      // their routing.
      if (isUniqueViolation(err)) {
        throw new HttpException({ error: 'WHATSAPP_NUMBER_ALREADY_CONNECTED' }, 409);
      }
      throw err;
    }
  }

  @Patch(':id')
  async update(
    @AdminSession() session: AdminSessionContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parseOr400(whatsappNumberUpdateSchema, body);

    // Re-enabling a number is the same entitlement as connecting one, and it
    // was the hole this endpoint left open: a store downgraded off the channel
    // could not `connect` a number but could still flip an existing one back
    // to `connected`. DISABLING stays ungated on purpose — a merchant must
    // always be able to turn a channel off, plan or no plan, and gating the
    // off-switch behind an upgrade prompt would be indefensible.
    if (input.status === 'connected') {
      await assertPlanFeature(session.tenantId, 'whatsappChannel');
    }

    const updated = await this.numbers.setStatus(session.tenantId, id, input.status);
    if (!updated) throw new HttpException({ error: 'WHATSAPP_NUMBER_NOT_FOUND' }, 404);
    await writeAudit(session, 'whatsapp.status', 'WhatsAppNumber', id, input);
    return updated;
  }

  @Delete(':id')
  async remove(@AdminSession() session: AdminSessionContext, @Param('id') id: string) {
    const removed = await this.numbers.deleteForTenant(session.tenantId, id);
    if (!removed) throw new HttpException({ error: 'WHATSAPP_NUMBER_NOT_FOUND' }, 404);
    await writeAudit(session, 'whatsapp.disconnect', 'WhatsAppNumber', id, {});
    return { ok: true };
  }
}

/** The API's own public origin, for the callback URL a merchant pastes into
 * Meta. Falls back to the dev hostname the compose stack serves, matching how
 * `ADMIN_URL` is defaulted elsewhere in this codebase. */
function apiPublicUrl(): string {
  return (process.env.API_PUBLIC_URL ?? 'http://api.ventia.localhost').replace(/\/+$/, '');
}

/** Prisma's unique-constraint error, identified by code rather than by message
 * so a Prisma upgrade that rewords it does not turn a 409 into a 500. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}
