import type { Appointment, AppointmentSaved, BookingWarning, CalendarResponse } from '@bv/contracts';
import { Body, Controller, Get, Header, HttpCode, Param, Patch, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import { idempotentWrite, type WriteRequest, type WriteResponse } from '../common/idempotent-write';
import { OwnerShopGuard } from '../common/owner-shop.guard';
import { DatabaseService } from '../database.service';
import { AppointmentM1Service } from './appointment-m1.service';

// 계약 #42 예약 등록·상세·변경(BEA-176)과 상태 바꾸기(/status — 취소 BEA-176, 완료·노쇼·정정 BEA-178).
// OwnerShopGuard가 경로의 shopId = 로그인한 원장의 매장임을 확인한 뒤에만 들어온다.
@Controller('api/shops/:shopId/appointments')
@UseGuards(OwnerShopGuard)
export class AppointmentM1Controller {
  constructor(private readonly database: DatabaseService, private readonly appointments: AppointmentM1Service) {}

  @Post()
  create(
    @Param('shopId') shopId: string, @Body() body: unknown,
    @Req() request: WriteRequest, @Res({ passthrough: true }) response: WriteResponse,
  ): Promise<AppointmentSaved> {
    return idempotentWrite(this.database, shopId, request, response, 201,
      (client) => this.appointments.create(client, shopId, body));
  }

  /** 저장 전 경고 미리 보기(설계 12 D4) — 쓰지 않으므로 Idempotency-Key 없음. 200 { warnings }. */
  @Post('preview-warnings')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  previewWarnings(@Param('shopId') shopId: string, @Body() body: unknown): Promise<{ warnings: BookingWarning[] }> {
    return this.database.withShop(shopId, (client) => this.appointments.previewWarnings(client, shopId, body));
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
  ): Promise<AppointmentSaved> {
    return idempotentWrite(this.database, shopId, request, response, 200,
      (client) => this.appointments.update(client, shopId, id, body));
  }

  @Put(':appointmentId/status')
  setStatus(
    @Param('shopId') shopId: string, @Param('appointmentId') id: string, @Body() body: unknown,
    @Req() request: WriteRequest, @Res({ passthrough: true }) response: WriteResponse,
  ): Promise<AppointmentSaved> {
    return idempotentWrite(this.database, shopId, request, response, 200,
      (client) => this.appointments.setStatus(client, shopId, id, body));
  }
}

// 계약 #42 캘린더 조회(BEA-175). 읽기라 Idempotency-Key 없음.
@Controller('api/shops/:shopId/calendar')
@UseGuards(OwnerShopGuard)
export class CalendarM1Controller {
  constructor(private readonly database: DatabaseService, private readonly appointments: AppointmentM1Service) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  calendar(@Param('shopId') shopId: string, @Query('from') from: unknown, @Query('to') to: unknown): Promise<CalendarResponse> {
    // 예약·차단·담당자를 한 읽기 스냅샷에서 조립한다(설계 09 D5).
    return this.database.withShopSnapshot(shopId, (client) => this.appointments.calendar(client, shopId, { from, to }));
  }
}
