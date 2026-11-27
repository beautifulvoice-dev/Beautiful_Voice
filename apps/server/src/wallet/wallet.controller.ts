import type { CustomerPass, Page, WalletEntry, WalletEntryRecorded, WalletSummary } from '@bv/contracts';
import { Body, Controller, Get, Header, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { idempotentWrite, type WriteRequest, type WriteResponse } from '../common/idempotent-write';
import { OwnerSessionGuard, type OwnerSessionRequest } from '../common/owner-shop.guard';
import { DatabaseService } from '../database.service';
import { walletEntries, walletSummary } from './wallet-queries';
import { WalletService, type CustomerPassRecord, type WalletEntryRecord } from './wallet.service';

// 지갑 API(설계 13 §3·§4, wallet.openapi.yaml). ADR-0009 A단계 새 리소스 — 매장은 OwnerSessionGuard가 확인한
// 세션에서만 정한다. 주소·본문에 매장 ID를 받지 않는다. 쓰기는 idempotentWrite → 공통 지갑 함수(매장 잠금 먼저).
@Controller('api')
@UseGuards(OwnerSessionGuard)
export class WalletController {
  constructor(private readonly database: DatabaseService, private readonly wallet: WalletService) {}

  @Get('wallets/:customerId')
  @Header('Cache-Control', 'no-store')
  summary(@Req() session: OwnerSessionRequest, @Param('customerId') customerId: string): Promise<WalletSummary> {
    const { shopId } = session.ownerSession;
    return this.database.withShop(shopId, (client) => walletSummary(client, shopId, customerId));
  }

  @Get('wallet-entries')
  @Header('Cache-Control', 'no-store')
  entries(@Req() session: OwnerSessionRequest, @Query() query: Record<string, string | string[] | undefined>): Promise<Page<WalletEntry>> {
    const { shopId } = session.ownerSession;
    return this.database.withShop(shopId, (client) => walletEntries(client, shopId, query));
  }

  @Post('wallet-entries')
  async record(
    @Req() session: OwnerSessionRequest, @Body() body: unknown,
    @Req() request: WriteRequest, @Res({ passthrough: true }) response: WriteResponse,
  ): Promise<WalletEntryRecorded> {
    const { shopId } = session.ownerSession;
    return idempotentWrite(this.database, shopId, request, response, 201,
      async (client) => toRecorded(await this.wallet.recordManual(client, shopId, body)));
  }

  @Post('passes')
  async issue(
    @Req() session: OwnerSessionRequest, @Body() body: unknown,
    @Req() request: WriteRequest, @Res({ passthrough: true }) response: WriteResponse,
  ): Promise<CustomerPass> {
    const { shopId } = session.ownerSession;
    return idempotentWrite(this.database, shopId, request, response, 201,
      async (client) => toPass(await this.wallet.issuePassFromWeb(client, shopId, body)));
  }
}

function toRecorded({ balanceAfter, ...entry }: WalletEntryRecord): WalletEntryRecorded {
  return {
    ...entry,
    prepaidBalance: entry.unitType === 'amount' ? balanceAfter : null,
    remainingSessions: entry.unitType === 'sessions' ? balanceAfter : null,
  };
}

function toPass(pass: CustomerPassRecord): CustomerPass {
  const { id, customerId, name, menuId, menuName, remainingSessions, isPrimary, version } = pass;
  return { id, customerId, name, menuId, menuName, remainingSessions, isPrimary, version };
}
