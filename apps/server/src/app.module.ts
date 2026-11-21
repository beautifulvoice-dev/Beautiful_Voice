import type { HealthResponse } from '@bv/contracts';
import { Controller, Get, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { DatabaseService } from './database.service';
import { OwnerAuthController } from './owner-auth.controller';
import { SettingsController } from './settings/settings.controller';
import { SettingsService } from './settings/settings.service';

@Controller('api/health')
class HealthController {
  @Get()
  health(): HealthResponse {
    return { status: 'ok' };
  }
}

@Module({
  controllers: [HealthController, OwnerAuthController, SettingsController],
  providers: [DatabaseService, SettingsService, { provide: APP_FILTER, useClass: ApiExceptionFilter }],
})
export class AppModule {}
