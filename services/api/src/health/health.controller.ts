import { Controller, Get } from '@nestjs/common';

@Controller('v1/health')
export class HealthController {
  @Get()
  health() {
    return { status: 'ok' };
  }
}
