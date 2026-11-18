import type { HealthResponse } from '@bv/contracts';
import { Controller, Get, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';

@Controller('api/health')
class HealthController {
  @Get()
  health(): HealthResponse {
    return { status: 'ok' };
  }
}

@Module({ controllers: [HealthController], providers: [DatabaseService] })
export class AppModule {}
