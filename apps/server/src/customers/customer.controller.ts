import type { Customer, Page, SameNameCheckResponse } from '@bv/contracts';
import { Body, Controller, Get, Header, HttpCode, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { idempotentWrite, type WriteRequest, type WriteResponse } from '../common/idempotent-write';
import { OwnerShopGuard } from '../common/owner-shop.guard';
import { DatabaseService } from '../database.service';
import { CustomerService } from './customer.service';

// 계약 #42 "고객" 묶음 중 BEA-172(등록·검색·수정·동명이인). 비활성화(BEA-173)는 다음 PR.
// 검색어 q에 전화번호가 들어갈 수 있다 — 이 경로의 URL을 로그에 남기지 않는다(절대 규칙 8, 설계 D4).
@Controller('api/shops/:shopId/customers')
@UseGuards(OwnerShopGuard)
export class CustomerController {
  constructor(private readonly database: DatabaseService, private readonly customers: CustomerService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @Param('shopId') shopId: string,
    @Query() query: { q?: string; includeInactive?: string; cursor?: string; limit?: string },
  ): Promise<Page<Customer>> {
    return this.database.withShop(shopId, (client) => this.customers.list(client, shopId, query));
  }

  @Post()
  create(
    @Param('shopId') shopId: string, @Body() body: unknown,
    @Req() request: WriteRequest, @Res({ passthrough: true }) response: WriteResponse,
  ): Promise<Customer> {
    return idempotentWrite(this.database, shopId, request, response, 201, (client) => this.customers.create(client, shopId, body));
  }

  // 저장하지 않는 조회라 POST지만 Idempotency-Key가 없다(계약 #42).
  @Post('same-name-check')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  sameNameCheck(@Param('shopId') shopId: string, @Body() body: unknown): Promise<SameNameCheckResponse> {
    return this.database.withShop(shopId, (client) => this.customers.sameNameCheck(client, shopId, body));
  }

  @Get(':customerId')
  @Header('Cache-Control', 'no-store')
  get(@Param('shopId') shopId: string, @Param('customerId') customerId: string): Promise<Customer> {
    return this.database.withShop(shopId, (client) => this.customers.get(client, shopId, customerId));
  }

  @Patch(':customerId')
  update(
    @Param('shopId') shopId: string, @Param('customerId') customerId: string, @Body() body: unknown,
    @Req() request: WriteRequest, @Res({ passthrough: true }) response: WriteResponse,
  ): Promise<Customer> {
    return idempotentWrite(this.database, shopId, request, response, 200,
      (client) => this.customers.update(client, shopId, customerId, body));
  }
}
