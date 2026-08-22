import { Body, Controller, Delete, Get, HttpException, Inject, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { instagramAccountUpdateSchema, instagramConnectSchema, type InstagramConnectInput } from '@ventia/core';
import { AdminSessionGuard } from '../admin/admin-session.guard';
import { AdminSession, Roles, type AdminSessionContext } from '../admin/roles.decorator';
import { parseOr400 } from '../catalog/parse';
import { writeAudit } from '../catalog/audit';
import { assertPlanFeature, isPlanFeatureEnabled } from '../common/plan-limits';
import { InstagramAccountsService } from './instagram-accounts.service';

/**
 * El flujo con el que un comerciante conecta su cuenta de Instagram.
 *
 * Solo para el dueño, como cualquier otra superficie con credenciales:
 * conectar una cuenta es pegar un token de página de Meta, y un puesto de
 * personal es un rol de operación, no de administración de la cuenta. Misma
 * postura que `SettingsController` y que el controlador equivalente de
 * WhatsApp.
 */
@Controller('v1/admin/instagram/accounts')
@UseGuards(AdminSessionGuard)
@Roles('owner')
export class InstagramAdminController {
  // @Inject explícito, como en todos los controladores de aquí — esbuild no
  // emite `design:paramtypes`.
  constructor(@Inject(InstagramAccountsService) private readonly accounts: InstagramAccountsService) {}

  @Get()
  async list(@AdminSession() session: AdminSessionContext) {
    const [items, channelEnabled] = await Promise.all([
      this.accounts.listForTenant(session.tenantId),
      isPlanFeatureEnabled(session.tenantId, 'instagramChannel'),
    ]);
    return {
      items,
      // Para que la página pueda pintar una invitación a mejorar de plan en
      // lugar de un formulario que va a responder 402 al enviarlo. Misma
      // fuente de verdad que la puerta de `connect`: la lectura y la
      // aplicación no pueden poder contradecirse.
      channelEnabled,
      // La URL que el comerciante pega en el panel de Meta. Se construye aquí
      // y no en el cliente porque solo el servidor conoce el origen público de
      // la API, y un comerciante copiando una URL de callback equivocada es un
      // ticket de soporte que parece "Instagram no funciona".
      callbackBaseUrl: `${apiPublicUrl()}/webhooks/instagram`,
    };
  }

  @Post()
  async connect(@AdminSession() session: AdminSessionContext, @Body() body: unknown) {
    const input = parseOr400<InstagramConnectInput>(instagramConnectSchema, body);

    // La puerta de plan. Se comprueba ANTES de escribir, para que una tienda
    // sin el canal no acabe con una cuenta a medio configurar que no puede
    // usar — y se vuelve a comprobar en cada mensaje entrante, porque un plan
    // se puede bajar después de que esto saliera bien. Emprende no lo incluye.
    await assertPlanFeature(session.tenantId, 'instagramChannel');

    try {
      const account = await this.accounts.connect({
        tenantId: session.tenantId,
        provider: input.provider,
        igAccountId: input.igAccountId,
        pageId: input.pageId,
        username: input.username,
        credentials: {
          token: input.accessToken,
          appSecret: input.appSecret,
          verifyToken: input.verifyToken,
        },
      });
      // Registra a propósito la clave de enrutamiento y NO las credenciales: un
      // rastro de auditoría que guarda secretos es un segundo sitio por el que
      // se escapan.
      await writeAudit(session, 'instagram.connect', 'InstagramAccount', account.id, {
        provider: input.provider,
        igAccountId: input.igAccountId,
        pageId: input.pageId,
      });
      return account;
    } catch (err) {
      // La restricción UNIQUE de `igAccountId`. Se expone como un 409 sobre el
      // que una persona puede actuar y no como un 500: la respuesta honesta es
      // "otra tienda ya registró esta cuenta", y quedarnos con ella en silencio
      // rompería su enrutamiento.
      if (isUniqueViolation(err)) {
        throw new HttpException({ error: 'INSTAGRAM_ACCOUNT_ALREADY_CONNECTED' }, 409);
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
    const input = parseOr400(instagramAccountUpdateSchema, body);

    // Reactivar una cuenta es la misma prestación que conectarla. DESACTIVAR
    // se queda sin puerta a propósito: un comerciante siempre tiene que poder
    // apagar un canal, tenga el plan que tenga, y poner el interruptor de
    // apagado detrás de una invitación a pagar más sería indefendible.
    if (input.status === 'connected') {
      await assertPlanFeature(session.tenantId, 'instagramChannel');
    }

    const updated = await this.accounts.setStatus(session.tenantId, id, input.status);
    if (!updated) throw new HttpException({ error: 'INSTAGRAM_ACCOUNT_NOT_FOUND' }, 404);
    await writeAudit(session, 'instagram.status', 'InstagramAccount', id, input);
    return updated;
  }

  @Delete(':id')
  async remove(@AdminSession() session: AdminSessionContext, @Param('id') id: string) {
    const removed = await this.accounts.deleteForTenant(session.tenantId, id);
    if (!removed) throw new HttpException({ error: 'INSTAGRAM_ACCOUNT_NOT_FOUND' }, 404);
    await writeAudit(session, 'instagram.disconnect', 'InstagramAccount', id, {});
    return { ok: true };
  }
}

/** El origen público de la propia API, para la URL de callback que el
 * comerciante pega en Meta. Cae al nombre de host de desarrollo que sirve el
 * compose, igual que se hace con `ADMIN_URL` en el resto del código. */
function apiPublicUrl(): string {
  return (process.env.API_PUBLIC_URL ?? 'http://api.ventia.localhost').replace(/\/+$/, '');
}

/** El error de restricción única de Prisma, identificado por código y no por
 * mensaje, para que una actualización de Prisma que lo reescriba no convierta
 * un 409 en un 500. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}
