import type { HealthResponse } from '@bv/contracts';
import { Controller, Get, Module } from '@nestjs/common';

@Controller('api/health')
class HealthController {
  @Get()
  health(): HealthResponse {
    return { status: 'ok' };
  }
}

@Module({ controllers: [HealthController] })
export class AppModule {}
