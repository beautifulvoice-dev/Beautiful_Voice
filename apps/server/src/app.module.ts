import type { HealthResponse } from '@bv/contracts';
import { Controller, Get, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AppointmentM1Controller } from './appointments-m1/appointment-m1.controller';
import { AppointmentM1Service } from './appointments-m1/appointment-m1.service';
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
  controllers: [HealthController, OwnerAuthController, SettingsController, AppointmentM1Controller],
  providers: [DatabaseService, SettingsService, AppointmentM1Service, { provide: APP_FILTER, useClass: ApiExceptionFilter }],
})
export class AppModule {}
