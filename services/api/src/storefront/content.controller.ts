import { Controller, Get, HttpException, NotFoundException, Param, UseGuards } from '@nestjs/common';
import { tenantDb } from '@ventia/db';
import { PublicTenantGuard } from './public-tenant.guard';
import { StorefrontTenantId } from './storefront-tenant.decorator';

const VALID_TYPES = ['faq', 'policy_shipping', 'policy_returns', 'policy_privacy', 'about'] as const;
type ContentType = (typeof VALID_TYPES)[number];

@Controller('v1/storefront/content')
@UseGuards(PublicTenantGuard)
export class StorefrontContentController {
  @Get(':type')
  async get(@StorefrontTenantId() tenantId: string, @Param('type') type: string) {
    if (!VALID_TYPES.includes(type as ContentType)) {
      throw new HttpException({ error: 'VALIDATION_FAILED', details: { type: 'tipo inválido' } }, 400);
    }
    const content = await tenantDb(tenantId).tenantContent.findUnique({
      where: { tenantId_type: { tenantId, type: type as ContentType } },
    });
    if (!content) throw new NotFoundException({ error: 'CONTENT_NOT_FOUND' });
    return { title: content.title, bodyMd: content.bodyMd };
  }
}
