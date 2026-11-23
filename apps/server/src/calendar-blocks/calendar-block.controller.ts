import type { CalendarBlock } from '@bv/contracts';
import { Body, Controller, Delete, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { idempotentWrite, type WriteRequest, type WriteResponse } from '../common/idempotent-write';
import { OwnerShopGuard } from '../common/owner-shop.guard';
import { DatabaseService } from '../database.service';
import { CalendarBlockService } from './calendar-block.service';

// 계약 #42 캘린더 차단 등록·수정·제거(BEA-179, 설계 09 D2).
@Controller('api/shops/:shopId/calendar-blocks')
@UseGuards(OwnerShopGuard)
export class CalendarBlockController {
  constructor(private readonly database: DatabaseService, private readonly blocks: CalendarBlockService) {}

  @Post()
  create(
    @Param('shopId') shopId: string, @Body() body: unknown,
    @Req() request: WriteRequest, @Res({ passthrough: true }) response: WriteResponse,
  ): Promise<CalendarBlock> {
    return idempotentWrite(this.database, shopId, request, response, 201, (client) => this.blocks.create(client, shopId, body));
  }

  @Patch(':blockId')
  update(
    @Param('shopId') shopId: string, @Param('blockId') id: string, @Body() body: unknown,
    @Req() request: WriteRequest, @Res({ passthrough: true }) response: WriteResponse,
  ): Promise<CalendarBlock> {
    return idempotentWrite(this.database, shopId, request, response, 200, (client) => this.blocks.update(client, shopId, id, body));
  }

  @Delete(':blockId')
  async remove(
    @Param('shopId') shopId: string, @Param('blockId') id: string, @Query('version') version: unknown,
    @Req() request: WriteRequest, @Res({ passthrough: true }) response: WriteResponse,
  ): Promise<void> {
    await idempotentWrite(this.database, shopId, request, response, 204,
      async (client) => { await this.blocks.remove(client, shopId, id, version); return null; });
  }
}
