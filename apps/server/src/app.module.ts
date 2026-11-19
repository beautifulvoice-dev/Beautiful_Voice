import type { HealthResponse } from '@bv/contracts';
import { Controller, Get, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { OwnerAuthController } from './owner-auth.controller';

@Controller('api/health')
class HealthController {
  @Get()
  health(): HealthResponse {
    return { status: 'ok' };
  }
}

@Module({ controllers: [HealthController, OwnerAuthController], providers: [DatabaseService] })
export class AppModule {}
