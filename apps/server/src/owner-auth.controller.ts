import type { OwnerSessionResponse, OwnerShopResponse } from '@bv/contracts';
import {
  Controller, Get, Header, HttpException, Param, Query, Redirect, Req, Res,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DatabaseService } from './database.service';
import { authenticateKakaoOwner, KakaoLoginError, kakaoAuthorizationUrl } from './kakao-login';
import {
  authConfig, CALLBACK_PATH, makeCookie, readCookie, SESSION_COOKIE,
  SESSION_SECONDS, signCookie, STATE_COOKIE, STATE_SECONDS, verifyCookie,
} from './owner-session';

@Controller('api')
export class OwnerAuthController {
  constructor(private readonly database: DatabaseService) {}

  @Get('auth/kakao/start')
  @Redirect()
  @Header('Cache-Control', 'no-store')
  start(@Res({ passthrough: true }) response: ServerResponse): { url: string } {
    const config = requireConfig();
    const state = randomBytes(32).toString('base64url');
    const cookie = signCookie(config.key, 'oauth-state', state, STATE_SECONDS);
    response.setHeader('Set-Cookie', makeCookie(STATE_COOKIE, cookie, STATE_SECONDS, CALLBACK_PATH, config.secure));
    return { url: kakaoAuthorizationUrl(config, state).href };
  }

  @Get('auth/kakao/callback')
  @Redirect('/')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async callback(
    @Req() request: IncomingMessage,
    @Res({ passthrough: true }) response: ServerResponse,
    @Query('code') code: unknown,
    @Query('state') state: unknown,
  ): Promise<void> {
    const config = requireConfig();
    const clearState = makeCookie(STATE_COOKIE, '', 0, CALLBACK_PATH, config.secure);
    response.setHeader('Set-Cookie', clearState);
    const stateCookie = readCookie(request.headers.cookie, STATE_COOKIE);
    const expected = verifyCookie(config.key, 'oauth-state', stateCookie);
    if (!expected || typeof code !== 'string' || typeof state !== 'string') throw unauthorized();
    const owner = await authenticateKakaoOwner(config, { code, state }, expected, this.database).catch((error: unknown) => {
      if (!(error instanceof KakaoLoginError)) throw error;
      if (error.reason === 'unavailable') throw new HttpException({
        code: 'KAKAO_UNAVAILABLE', message: '카카오 로그인에 연결할 수 없습니다.',
      }, 503);
      throw unauthorized();
    });
    if (!owner) throw new HttpException({ code: 'OWNER_NOT_REGISTERED', message: '등록된 원장 계정이 아닙니다.' }, 403);
    const session = signCookie(config.key, 'owner-session', owner.userId + ':' + owner.shopId, SESSION_SECONDS);
    response.setHeader('Set-Cookie', [clearState, makeCookie(SESSION_COOKIE, session, SESSION_SECONDS, '/api', config.secure)]);
  }

  @Get('auth/session')
  @Header('Cache-Control', 'no-store')
  async session(@Req() request: IncomingMessage): Promise<OwnerSessionResponse> {
    return { shopId: await this.requireShop(request) };
  }

  @Get('shops/:shopId')
  @Header('Cache-Control', 'no-store')
  async shop(@Req() request: IncomingMessage, @Param('shopId') requested: string): Promise<OwnerShopResponse> {
    const shopId = await this.requireShop(request);
    if (shopId !== requested) throw shopNotFound();
    const shop = await this.database.withShop(shopId, async (client) => {
      const { rows: [row] } = await client.query<OwnerShopResponse>('SELECT id, name FROM crm.shop WHERE id = $1', [shopId]);
      return row;
    });
    if (!shop) throw shopNotFound();
    return shop;
  }

  private async requireShop(request: IncomingMessage): Promise<string> {
    const cookie = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (!cookie) throw unauthorized();
    const { key } = requireConfig();
    const session = verifyCookie(key, 'owner-session', cookie);
    if (!session) throw unauthorized();
    const [userId, shopId] = session.split(':');
    if (!userId || !shopId || await this.database.findOwnerShop(userId) !== shopId) throw unauthorized();
    return shopId;
  }
}

function requireConfig() {
  const config = authConfig();
  if (!config) throw new HttpException({ code: 'AUTH_UNAVAILABLE', message: '로그인을 사용할 수 없습니다.' }, 503);
  return config;
}

function unauthorized(): HttpException {
  return new HttpException({ code: 'UNAUTHENTICATED', message: '다시 로그인해 주세요.' }, 401);
}

function shopNotFound(): HttpException {
  return new HttpException({ code: 'SHOP_NOT_FOUND', message: '매장을 찾을 수 없습니다.' }, 404);
}
