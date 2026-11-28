import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { DatabaseService } from '../database.service';
import { APP_SESSION_PURPOSE, authConfig, ownerConsent, readCookie, SESSION_COOKIE, verifyCookie } from '../owner-session';
import { ApiError } from './api-error';

// 로그인한 원장의 매장을 확인한다. 쿠키 서명·만료를 보고, 지금도 그 매장 소속인지 DB에서 다시 확인한다.
export async function requireOwnerShop(database: DatabaseService, request: IncomingMessage): Promise<string> {
  const identity = await requireOwnerIdentity(database, request);
  await requireOwnerConsent(database, identity.userId);
  return identity.shopId;
}

async function requireOwnerConsent(database: DatabaseService, userId: string): Promise<void> {
  const consent = ownerConsent();
  if (consent && !await database.ownerConsentAccepted(userId, consent.version)) {
    throw new ApiError(403, 'OWNER_CONSENT_REQUIRED', '매장을 열려면 먼저 동의해 주세요.');
  }
}

interface OwnerIdentity {
  userId: string;
  shopId: string;
}

export type OwnerSessionRequest = IncomingMessage & { ownerSession: OwnerIdentity };

export function requireOwnerIdentity(database: DatabaseService, request: IncomingMessage): Promise<OwnerIdentity> {
  return verifyOwnerIdentity(database, readCookie(request.headers.cookie, SESSION_COOKIE), 'owner-session');
}

async function verifyOwnerIdentity(database: DatabaseService, token: string, purpose: string): Promise<OwnerIdentity> {
  if (!token) throw unauthorized();
  const config = authConfig();
  if (!config) throw new ApiError(503, 'AUTH_UNAVAILABLE', '로그인을 사용할 수 없습니다.');
  const session = verifyCookie(config.key, purpose, token);
  if (!session) throw unauthorized();
  const [userId, shopId] = session.split(':');
  if (!userId || !shopId || await database.findOwnerShop(userId) !== shopId) throw unauthorized();
  return { userId, shopId };
}

// ADR-0009 A단계의 새 경로에서만 사용한다. 컨트롤러는 검증된 req.ownerSession으로 매장을 정한다.
@Injectable()
export class OwnerSessionGuard implements CanActivate {
  constructor(private readonly database: DatabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<IncomingMessage & { ownerSession?: OwnerIdentity }>();
    const authorization = request.headers.authorization;
    if ((request.headersDistinct?.authorization?.length ?? 0) > 1) throw unauthorized();

    const identity = authorization === undefined
      ? await requireOwnerIdentity(this.database, request)
      : await verifyOwnerIdentity(this.database, /^Bearer ([^\s]+)$/i.exec(authorization)?.[1] ?? '', APP_SESSION_PURPOSE);
    await requireOwnerConsent(this.database, identity.userId);
    request.ownerSession = identity;
    return true;
  }
}

export function shopNotFound(): ApiError<'SHOP_NOT_FOUND'> {
  return new ApiError(404, 'SHOP_NOT_FOUND', '매장을 찾을 수 없습니다.');
}

function unauthorized(): ApiError<'UNAUTHENTICATED'> {
  return new ApiError(401, 'UNAUTHENTICATED', '다시 로그인해 주세요.');
}

// `/api/shops/:shopId/…` 경로 전용. 경로의 shopId가 로그인한 원장의 매장이 아니면 404 —
// 403이면 "그 매장이 있다"는 사실이 새므로 존재 여부까지 숨긴다(#42 계약).
// 이 가드를 통과한 뒤에는 컨트롤러가 경로의 shopId를 그대로 써도 된다.
@Injectable()
export class OwnerShopGuard implements CanActivate {
  constructor(private readonly database: DatabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<IncomingMessage & { params?: Record<string, string> }>();
    const shopId = await requireOwnerShop(this.database, request);
    if (request.params?.shopId !== shopId) throw shopNotFound();
    return true;
  }
}
