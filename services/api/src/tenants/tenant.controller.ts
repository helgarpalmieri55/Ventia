import { Controller, Get, NotFoundException, Req } from '@nestjs/common';
import type { Request } from 'express';

@Controller('v1/tenant')
export class TenantController {
  @Get()
  current(@Req() req: Request) {
    if (!req.tenant) throw new NotFoundException({ error: 'TENANT_NOT_FOUND' });
    return req.tenant;
  }
}
