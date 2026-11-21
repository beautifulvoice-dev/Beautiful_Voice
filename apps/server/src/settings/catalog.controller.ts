import type { Menu, Staff } from '@bv/contracts';
import { Body, Controller, Get, Header, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { idempotentWrite, type WriteRequest, type WriteResponse } from '../common/idempotent-write';
import { OwnerShopGuard } from '../common/owner-shop.guard';
import { DatabaseService } from '../database.service';
import { CatalogService } from './catalog.service';

// 계약 #42 "설정" 묶음 중 BEA-167(메뉴·담당자). version과 숨김(active)이 있어 영업시간·휴무와 따로 둔다(설계 D2).
@Controller('api/shops/:shopId')
@UseGuards(OwnerShopGuard)
export class CatalogController {
  constructor(private readonly database: DatabaseService, private readonly catalog: CatalogService) {}

  @Get('menus')
  @Header('Cache-Control', 'no-store')
  menus(@Param('shopId') shopId: string, @Query('includeInactive') includeInactive?: string): Promise<{ items: Menu[] }> {
    return this.database.withShop(shopId, (client) => this.catalog.menus(client, shopId, includeInactive === 'true'));
  }

  @Post('menus')
  addMenu(
    @Param('shopId') shopId: string, @Body() body: unknown,
    @Req() request: WriteRequest, @Res({ passthrough: true }) response: WriteResponse,
  ): Promise<Menu> {
    return idempotentWrite(this.database, shopId, request, response, 201, (client) => this.catalog.addMenu(client, shopId, body));
  }

  @Patch('menus/:menuId')
  updateMenu(
    @Param('shopId') shopId: string, @Param('menuId') menuId: string, @Body() body: unknown,
    @Req() request: WriteRequest, @Res({ passthrough: true }) response: WriteResponse,
  ): Promise<Menu> {
    return idempotentWrite(this.database, shopId, request, response, 200,
      (client) => this.catalog.updateMenu(client, shopId, menuId, body));
  }

  @Get('staff')
  @Header('Cache-Control', 'no-store')
  staff(@Param('shopId') shopId: string, @Query('includeInactive') includeInactive?: string): Promise<{ items: Staff[] }> {
    return this.database.withShop(shopId, (client) => this.catalog.staff(client, shopId, includeInactive === 'true'));
  }

  @Post('staff')
  addStaff(
    @Param('shopId') shopId: string, @Body() body: unknown,
    @Req() request: WriteRequest, @Res({ passthrough: true }) response: WriteResponse,
  ): Promise<Staff> {
    return idempotentWrite(this.database, shopId, request, response, 201, (client) => this.catalog.addStaff(client, shopId, body));
  }

  @Patch('staff/:staffId')
  updateStaff(
    @Param('shopId') shopId: string, @Param('staffId') staffId: string, @Body() body: unknown,
    @Req() request: WriteRequest, @Res({ passthrough: true }) response: WriteResponse,
  ): Promise<Staff> {
    return idempotentWrite(this.database, shopId, request, response, 200,
      (client) => this.catalog.updateStaff(client, shopId, staffId, body));
  }
}
