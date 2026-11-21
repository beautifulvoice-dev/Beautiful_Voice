import type { Appointment } from '@bv/contracts';
import { Body, Controller, Get, Header, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import { idempotentWrite, type WriteRequest, type WriteResponse } from '../common/idempotent-write';
import { OwnerShopGuard } from '../common/owner-shop.guard';
import { DatabaseService } from '../database.service';
import { AppointmentM1Service, withOverlapIds } from './appointment-m1.service';

// 계약 #42 예약 등록·상세·변경(BEA-176). 취소·상태(/status, BEA-178)와 캘린더 조회는 다음 PR.
// OwnerShopGuard가 경로의 shopId = 로그인한 원장의 매장임을 확인한 뒤에만 들어온다.
@Controller('api/shops/:shopId/appointments')
@UseGuards(OwnerShopGuard)
export class AppointmentM1Controller {
  constructor(private readonly database: DatabaseService, private readonly appointments: AppointmentM1Service) {}

  @Post()
  create(
    @Param('shopId') shopId: string, @Body() body: unknown,
    @Req() request: WriteRequest, @Res({ passthrough: true }) response: WriteResponse,
  ): Promise<Appointment> {
    return withOverlapIds(this.database, shopId, () => idempotentWrite(this.database, shopId, request, response, 201,
      (client) => this.appointments.create(client, shopId, body)));
  }

  @Get(':appointmentId')
  @Header('Cache-Control', 'no-store')
  find(@Param('shopId') shopId: string, @Param('appointmentId') id: string): Promise<Appointment> {
    return this.database.withShop(shopId, (client) => this.appointments.find(client, shopId, id));
  }

  @Patch(':appointmentId')
  update(
    @Param('shopId') shopId: string, @Param('appointmentId') id: string, @Body() body: unknown,
    @Req() request: WriteRequest, @Res({ passthrough: true }) response: WriteResponse,
  ): Promise<Appointment> {
    return withOverlapIds(this.database, shopId, () => idempotentWrite(this.database, shopId, request, response, 200,
      (client) => this.appointments.update(client, shopId, id, body)));
  }
}
