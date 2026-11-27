import type { AppointmentRules, BusinessHoursBody, Closure, ShopInfo } from '@bv/contracts';
import { Body, Controller, Delete, Get, Header, Param, Post, Put, Req, Res, UseGuards } from '@nestjs/common';
import { idempotentWrite, type WriteRequest, type WriteResponse } from '../common/idempotent-write';
import { OwnerShopGuard } from '../common/owner-shop.guard';
import { DatabaseService } from '../database.service';
import { SettingsService } from './settings.service';

// 계약 #42 "설정" 묶음 중 BEA-166(영업시간·매장 안내 정보·휴무). 메뉴·담당자(BEA-167)는 별도 컨트롤러.
// OwnerShopGuard가 경로의 shopId = 로그인한 원장의 매장임을 확인한 뒤에만 들어온다.
@Controller('api/shops/:shopId')
@UseGuards(OwnerShopGuard)
export class SettingsController {
  constructor(private readonly database: DatabaseService, private readonly settings: SettingsService) {}

  @Get('settings/business-hours')
  @Header('Cache-Control', 'no-store')
  businessHours(@Param('shopId') shopId: string): Promise<BusinessHoursBody> {
    return this.database.withShop(shopId, (client) => this.settings.businessHours(client, shopId));
  }

  @Put('settings/business-hours')
  saveBusinessHours(
    @Param('shopId') shopId: string, @Body() body: { businessHours?: unknown } | undefined,
    @Req() request: WriteRequest, @Res({ passthrough: true }) response: WriteResponse,
  ): Promise<BusinessHoursBody> {
    return idempotentWrite(this.database, shopId, request, response, 200,
      (client) => this.settings.saveBusinessHours(client, shopId, body?.businessHours));
  }

  @Get('settings/shop-info')
  @Header('Cache-Control', 'no-store')
  shopInfo(@Param('shopId') shopId: string): Promise<ShopInfo> {
    return this.database.withShop(shopId, (client) => this.settings.shopInfo(client, shopId));
  }

  @Put('settings/shop-info')
  saveShopInfo(
    @Param('shopId') shopId: string, @Body() body: unknown,
    @Req() request: WriteRequest, @Res({ passthrough: true }) response: WriteResponse,
  ): Promise<ShopInfo> {
    return idempotentWrite(this.database, shopId, request, response, 200,
      (client) => this.settings.saveShopInfo(client, shopId, body));
  }

  @Get('settings/appointment-rules')
  @Header('Cache-Control', 'no-store')
  appointmentRules(@Param('shopId') shopId: string): Promise<AppointmentRules> {
    return this.database.withShop(shopId, (client) => this.settings.appointmentRules(client, shopId));
  }

  @Put('settings/appointment-rules')
  saveAppointmentRules(
    @Param('shopId') shopId: string, @Body() body: unknown,
    @Req() request: WriteRequest, @Res({ passthrough: true }) response: WriteResponse,
  ): Promise<AppointmentRules> {
    return idempotentWrite(this.database, shopId, request, response, 200,
      (client) => this.settings.saveAppointmentRules(client, shopId, body));
  }

    @Get('closures')
  @Header('Cache-Control', 'no-store')
  closures(@Param('shopId') shopId: string): Promise<{ items: Closure[] }> {
    return this.database.withShop(shopId, (client) => this.settings.closures(client, shopId));
  }

  @Post('closures')
  addClosure(
    @Param('shopId') shopId: string, @Body() body: unknown,
    @Req() request: WriteRequest, @Res({ passthrough: true }) response: WriteResponse,
  ): Promise<Closure> {
    return idempotentWrite(this.database, shopId, request, response, 201,
      (client) => this.settings.addClosure(client, shopId, body ?? {}));
  }

  @Delete('closures/:closureId')
  async removeClosure(
    @Param('shopId') shopId: string, @Param('closureId') closureId: string,
    @Req() request: WriteRequest, @Res({ passthrough: true }) response: WriteResponse,
  ): Promise<void> {
    await idempotentWrite(this.database, shopId, request, response, 204,
      async (client) => { await this.settings.removeClosure(client, shopId, closureId); return null; });
  }
}
