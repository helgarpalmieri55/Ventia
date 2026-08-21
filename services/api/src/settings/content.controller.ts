import { Body, Controller, Get, HttpCode, HttpException, Inject, NotFoundException, Param, Post, Put, UseGuards } from '@nestjs/common';
import { tenantDb, type TenantContentType } from '@ventia/db';
import { AdminSessionGuard } from '../admin/admin-session.guard';
import { AdminSession, Roles, type AdminSessionContext } from '../admin/roles.decorator';
import { parseOr400, type ParsableSchema } from '../catalog/parse';
import { writeAudit } from '../catalog/audit';
import { PrivacyPolicyService } from './privacy-policy.service';
import { TermsService } from './terms.service';

/** Mirrors the `TenantContentType` enum in packages/db/prisma/schema.prisma
 * and the identical list in storefront/content.controller.ts — the storefront
 * READS these, this controller is where a merchant WRITES them. */
const VALID_TYPES = ['faq', 'policy_shipping', 'policy_returns', 'policy_privacy', 'policy_terms', 'about'] as const;

function parseType(type: string): TenantContentType {
  if (!(VALID_TYPES as readonly string[]).includes(type)) {
    throw new HttpException({ error: 'VALIDATION_FAILED', details: { type: 'tipo inválido' } }, 400);
  }
  return type as TenantContentType;
}

interface ContentInput {
  title: string;
  bodyMd: string;
}

/**
 * Hand-rolled `ParsableSchema` rather than a Zod schema, for the reason
 * spelled out in catalog/parse.ts: this package deliberately has no direct
 * `zod` dependency (adding one shifts pnpm's resolution of better-auth's zod
 * peer), and the schema that would otherwise live in `@ventia/core` cannot be
 * added there from this change. Shape and error contract are identical to what
 * `parseOr400` gets from a real Zod schema — `{ formErrors, fieldErrors }`
 * from `flatten()` — so the 400 body is indistinguishable to callers.
 *
 * Limits chosen to match their neighbours: `title` like
 * `storeSettingsSchema.name` (80), `bodyMd` generous but bounded — a generated
 * policy is roughly 8 KB, and an unbounded text column reachable from an
 * authenticated endpoint is an easy way to fill a disk.
 */
const contentInputSchema: ParsableSchema<ContentInput> = {
  safeParse(data: unknown) {
    const b = (data ?? {}) as Record<string, unknown>;
    const fieldErrors: Record<string, string[]> = {};

    const title = typeof b.title === 'string' ? b.title.trim() : '';
    if (title.length < 2 || title.length > 80) {
      fieldErrors.title = ['El título debe tener entre 2 y 80 caracteres'];
    }

    const bodyMd = typeof b.bodyMd === 'string' ? b.bodyMd : '';
    if (typeof b.bodyMd !== 'string') {
      fieldErrors.bodyMd = ['bodyMd es requerido'];
    } else if (bodyMd.length > 50_000) {
      fieldErrors.bodyMd = ['El contenido no puede superar 50.000 caracteres'];
    }

    if (Object.keys(fieldErrors).length > 0) {
      return { success: false, error: { flatten: () => ({ formErrors: [], fieldErrors }) } };
    }
    return { success: true, data: { title, bodyMd } };
  },
};

/**
 * The merchant's editor for the storefront's content pages (docs/SPEC.md §6
 * M8, "policy pages editor") plus the Ley 1581 privacy-policy generator
 * required by §9.
 *
 * Until this controller existed there was no write path to `TenantContent` at
 * all: the storefront read it (storefront/content.controller.ts) and the agent
 * read it (agent/agent-tools.service.ts's `get_store_info`), but nothing could
 * put anything there, so every store's /privacidad page necessarily showed the
 * "esta tienda aún no ha configurado…" fallback forever. Generating a policy
 * the merchant cannot save would have been the same dead end.
 *
 * Lives under `settings/` rather than a module of its own because these are
 * store-level settings the owner configures once, and because `SettingsModule`
 * is already wired into `AppModule` (which this change does not touch).
 */
@Controller('v1/admin/content')
@UseGuards(AdminSessionGuard)
// Reads are open to staff — the agent answers shoppers out of this same
// content, and a staff member handling orders has a legitimate reason to look
// at what the store promises. Writes are owner-only (see the per-handler
// @Roles below): a política de tratamiento is a legal statement BY the
// merchant, and §3 of the spec puts settings-shaped decisions with the owner.
@Roles('owner', 'staff')
export class AdminContentController {
  // Explicit @Inject: esbuild (vitest's default TS transform) does not emit
  // `design:paramtypes`, so implicit constructor injection resolves to
  // `undefined` and fails at call time rather than at boot — same caution as
  // every other controller here (see settings.controller.ts).
  constructor(
    @Inject(PrivacyPolicyService) private readonly privacyPolicy: PrivacyPolicyService,
    @Inject(TermsService) private readonly terms: TermsService,
  ) {}

  @Get()
  async list(@AdminSession() session: AdminSessionContext) {
    const rows = await tenantDb(session.tenantId).tenantContent.findMany({});
    return {
      items: VALID_TYPES.map((type) => {
        const row = rows.find((r) => r.type === type);
        return { type, title: row?.title ?? null, bodyMd: row?.bodyMd ?? null };
      }),
    };
  }

  @Get(':type')
  async get(@AdminSession() session: AdminSessionContext, @Param('type') type: string) {
    const contentType = parseType(type);
    const row = await tenantDb(session.tenantId).tenantContent.findUnique({
      where: { tenantId_type: { tenantId: session.tenantId, type: contentType } },
    });
    if (!row) throw new NotFoundException({ error: 'CONTENT_NOT_FOUND' });
    return { type: row.type, title: row.title, bodyMd: row.bodyMd };
  }

  /**
   * Upsert, because `TenantContent` has one row per (tenant, type) and the
   * merchant does not care whether they are creating or editing.
   *
   * A PUT, not a PATCH: the editor always submits both fields, and a partial
   * merge of a policy document has no meaning — half a title on top of a whole
   * body is not a state anyone wants to be able to reach.
   */
  @Put(':type')
  @Roles('owner')
  async replace(
    @AdminSession() session: AdminSessionContext,
    @Param('type') type: string,
    @Body() body: unknown,
  ) {
    const contentType = parseType(type);
    const input = parseOr400(contentInputSchema, body);

    const row = await tenantDb(session.tenantId).tenantContent.upsert({
      where: { tenantId_type: { tenantId: session.tenantId, type: contentType } },
      create: { tenantId: session.tenantId, type: contentType, title: input.title, bodyMd: input.bodyMd },
      update: { title: input.title, bodyMd: input.bodyMd },
    });

    // Audit the SHAPE, not the whole document: `AuditLog.data` would otherwise
    // grow a full copy of an 8 KB policy on every keystroke-save, and the
    // interesting fact for an audit trail is "the owner replaced the privacy
    // policy at 14:03", not its 12th revision verbatim.
    await writeAudit(session, 'content.update', 'TenantContent', row.id, {
      type: contentType,
      title: input.title,
      bodyLength: input.bodyMd.length,
    });

    return { type: row.type, title: row.title, bodyMd: row.bodyMd };
  }

  /**
   * Fills the Ley 1581 privacy-policy template with THIS store's data and
   * returns it for review (docs/SPEC.md §9). Writes nothing — see
   * `PrivacyPolicyService.generate`'s doc comment: the merchant reads it,
   * edits it, and saves it through `PUT /v1/admin/content/policy_privacy`,
   * so no request can silently replace text they wrote themselves.
   *
   * `@HttpCode(200)`: a POST that creates nothing should not answer 201. It is
   * a POST rather than a GET because it is a generation with a body-shaped
   * result, matching `POST settings/payments/:provider/test-connection`'s
   * precedent in this module for "an action with no side effect on our data".
   */
  @Post('policy_privacy/generate')
  @Roles('owner')
  @HttpCode(200)
  async generatePrivacyPolicy(@AdminSession() session: AdminSessionContext) {
    return this.privacyPolicy.generate(session.tenantId);
  }

  /**
   * Fills the Ley 1480 términos y condiciones template with THIS store's data
   * and returns it for review. Same contract as the privacy generator above,
   * for the same reasons: writes nothing, owner-only, `@HttpCode(200)`
   * because a POST that creates nothing should not answer 201, and the
   * merchant-facing disclaimer travels in the RESPONSE rather than inside
   * `bodyMd` so it can never reach a shopper.
   *
   * A second endpoint rather than `POST :type/generate` with a switch: the
   * two generators return different disclaimers and take different store
   * facts, `:type` would accept `faq`/`about`/`policy_shipping` and have to
   * 400 them back, and `impersonation-policy.ts` already reasons about these
   * routes by their literal last segment.
   */
  @Post('policy_terms/generate')
  @Roles('owner')
  @HttpCode(200)
  async generateTerms(@AdminSession() session: AdminSessionContext) {
    return this.terms.generate(session.tenantId);
  }
}
