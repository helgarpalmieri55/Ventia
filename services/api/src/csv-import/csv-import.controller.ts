import { Body, Controller, Get, Header, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { AdminSessionGuard } from '../admin/admin-session.guard';
import { AdminSession, type AdminSessionContext } from '../admin/roles.decorator';
import { CsvImportService } from './csv-import.service';

// AdminSessionGuard rejects any session without a tenantId before a request
// reaches here (see admin-session.guard.ts: `!session.tenantId` -> 403), so
// tenantId is guaranteed non-null in every handler below. No @Roles() is set:
// both 'owner' and 'staff' may run a catalog import (same as products/categories).
@Controller('v1/admin/import')
@UseGuards(AdminSessionGuard)
export class CsvImportController {
  // Explicit @Inject: esbuild (vitest's default TS transform) does not emit
  // TypeScript's `design:paramtypes` decorator metadata, so Nest's implicit
  // constructor-injection cannot resolve CsvImportService by type alone (same
  // caution as admin-session.guard.ts's Reflector/AuthInstance injection).
  constructor(@Inject(CsvImportService) private readonly csvImport: CsvImportService) {}

  @Get('template')
  @Header('Content-Type', 'text/csv')
  template(): string {
    return this.csvImport.template();
  }

  @Post('dry-run')
  @HttpCode(200)
  async dryRun(@AdminSession() session: AdminSessionContext, @Body() body: unknown) {
    return this.csvImport.dryRun(session, body);
  }

  @Post('commit')
  @HttpCode(200)
  async commit(@AdminSession() session: AdminSessionContext, @Body() body: unknown) {
    return this.csvImport.commit(session, body);
  }
}
