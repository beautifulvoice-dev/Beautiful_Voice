import type { HealthResponse } from '@bv/contracts';
import { Controller, Get, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AppointmentM1Controller, CalendarM1Controller } from './appointments-m1/appointment-m1.controller';
import { CalendarBlockController } from './calendar-blocks/calendar-block.controller';
import { CalendarBlockService } from './calendar-blocks/calendar-block.service';
import { AppointmentM1Service } from './appointments-m1/appointment-m1.service';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { CustomerController } from './customers/customer.controller';
import { CustomerService } from './customers/customer.service';
import { DatabaseService } from './database.service';
import { OwnerAuthController } from './owner-auth.controller';
import { CatalogController } from './settings/catalog.controller';
import { CatalogService } from './settings/catalog.service';
import { SettingsController } from './settings/settings.controller';
import { SettingsService } from './settings/settings.service';
import { WalletController } from './wallet/wallet.controller';
import { WalletService } from './wallet/wallet.service';

@Controller('api/health')
class HealthController {
  @Get()
  health(): HealthResponse {
    return { status: 'ok' };
  }
}

@Module({
  controllers: [HealthController, OwnerAuthController, SettingsController, CatalogController, CustomerController, AppointmentM1Controller, CalendarM1Controller, CalendarBlockController, WalletController],
  providers: [
    DatabaseService, SettingsService, CatalogService, CustomerService, AppointmentM1Service, CalendarBlockService, WalletService,
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule {}
