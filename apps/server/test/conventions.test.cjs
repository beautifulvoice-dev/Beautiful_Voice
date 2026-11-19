// F-05 공통 API 규약 — DB 없이 도는 테스트. 수용 기준은 PR 본문과 같다.
require('reflect-metadata');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Controller, Get, Module, BadRequestException } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/app.module.js');
const { ApiError } = require('../dist/common/api-error.js');
const { ApiExceptionFilter } = require('../dist/common/api-exception.filter.js');
const { parseIdempotencyKey, requestFingerprint } = require('../dist/common/idempotency.js');
const {
  DEFAULT_LIMIT, MAX_LIMIT, parseLimit, encodeCursor, decodeCursor, toPage,
} = require('../dist/common/pagination.js');

async function withApp(module, run) {
  const app = await NestFactory.create(module, { logger: false });
  try {
    await app.listen(0, '127.0.0.1');
    await run(await app.getUrl());
  } finally {
    await app.close();
  }
}

function rejectsWith(fn, code, status) {
  assert.throws(fn, (error) => error instanceof ApiError && error.code === code && error.status === status);
}

// ── 오류 형식 { code, message, details } ──────────────────────────────

test('AppModule: 없는 주소는 404 NOT_FOUND 형식으로 답한다', async () => {
  await withApp(AppModule, async (url) => {
    const response = await fetch(url + '/api/nope');
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.code, 'NOT_FOUND');
    assert.equal(typeof body.message, 'string');
    assert.deepEqual(body.details, {});
  });
});

test('AppModule: 깨진 JSON 본문은 400 BAD_REQUEST 형식으로 답한다', async () => {
  await withApp(AppModule, async (url) => {
    const response = await fetch(url + '/api/health', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":',
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.code, 'BAD_REQUEST');
    assert.deepEqual(Object.keys(body).sort(), ['code', 'details', 'message']);
  });
});

// .cjs에서는 데코레이터 문법을 쓸 수 없어 함수로 직접 적용한다.
class ThrowingController {
  domain() {
    throw new ApiError(409, 'APPOINTMENT_CONFLICT', 'The time slot is full', { maxConcurrent: 2 });
  }
  http() {
    throw new BadRequestException('limit must be a number');
  }
  crash() {
    throw new Error('synthetic failure with 010-0000-0000');
  }
}
for (const name of ['domain', 'http', 'crash']) {
  const proto = ThrowingController.prototype;
  Get(name)(proto, name, Object.getOwnPropertyDescriptor(proto, name));
}
Controller('t')(ThrowingController);
class ThrowingModule {}
Module({ controllers: [ThrowingController] })(ThrowingModule);

async function withThrowingApp(run) {
  const app = await NestFactory.create(ThrowingModule, { logger: false });
  app.useGlobalFilters(new ApiExceptionFilter());
  try {
    await app.listen(0, '127.0.0.1');
    await run(await app.getUrl());
  } finally {
    await app.close();
  }
}

test('도메인 오류는 상태·코드·details를 그대로 전달한다', async () => {
  await withThrowingApp(async (url) => {
    const response = await fetch(url + '/t/domain');
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      code: 'APPOINTMENT_CONFLICT',
      message: 'The time slot is full',
      details: { maxConcurrent: 2 },
    });
  });
});

test('Nest 기본 HTTP 예외도 같은 형식으로 바뀐다', async () => {
  await withThrowingApp(async (url) => {
    const response = await fetch(url + '/t/http');
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      code: 'BAD_REQUEST', message: 'limit must be a number', details: {},
    });
  });
});

test('예상 못 한 오류는 500 INTERNAL_ERROR, 내부 메시지를 밖으로 내보내지 않는다', async () => {
  await withThrowingApp(async (url) => {
    const response = await fetch(url + '/t/crash');
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.code, 'INTERNAL_ERROR');
    assert.ok(!JSON.stringify(body).includes('010-0000-0000'));
  });
});

// ── Idempotency-Key 헤더 ──────────────────────────────────────────────

test('Idempotency-Key: 없으면 null, 형식이 맞으면 그대로', () => {
  assert.equal(parseIdempotencyKey(undefined), null);
  const key = '6f1c2b0e-3a4d-4e5f-8a9b-0c1d2e3f4a5b';
  assert.equal(parseIdempotencyKey(key), key);
  assert.equal(parseIdempotencyKey('x'.repeat(255)).length, 255);
});

test('Idempotency-Key: 빈 값·256자 이상·제어 문자·여러 값은 400 INVALID_IDEMPOTENCY_KEY', () => {
  for (const bad of ['', '   ', 'x'.repeat(256), 'a\nb', 'a\u0000b', ['a', 'b']]) {
    rejectsWith(() => parseIdempotencyKey(bad), 'INVALID_IDEMPOTENCY_KEY', 400);
  }
});

test('요청 지문: 본문 키 순서는 무시하고 메서드·경로·본문이 다르면 달라진다', () => {
  const a = requestFingerprint('POST', '/v1/customers', { name: '합성 고객', phone: null });
  assert.equal(a, requestFingerprint('post', '/v1/customers', { phone: null, name: '합성 고객' }));
  assert.notEqual(a, requestFingerprint('POST', '/v1/customers', { name: '합성 고객2', phone: null }));
  assert.notEqual(a, requestFingerprint('PATCH', '/v1/customers', { name: '합성 고객', phone: null }));
  assert.notEqual(a, requestFingerprint('POST', '/v1/appointments', { name: '합성 고객', phone: null }));
  assert.equal(
    requestFingerprint('POST', '/v1/x', { a: { c: 1, b: [2, { e: 3, d: 4 }] } }),
    requestFingerprint('POST', '/v1/x', { a: { b: [2, { d: 4, e: 3 }], c: 1 } }),
  );
});

// ── cursor 페이지네이션 ─────────────────────────────────────────────

test('limit: 기본 20, 1~100만 허용', () => {
  assert.equal(DEFAULT_LIMIT, 20);
  assert.equal(MAX_LIMIT, 100);
  assert.equal(parseLimit(undefined), 20);
  assert.equal(parseLimit('1'), 1);
  assert.equal(parseLimit('100'), 100);
  for (const bad of ['0', '101', '-1', '1.5', 'abc', '', ['1', '2']]) {
    rejectsWith(() => parseLimit(bad), 'INVALID_LIMIT', 400);
  }
});

test('cursor: 인코딩·디코딩이 왕복되고, 깨지거나 조작된 값은 400 INVALID_CURSOR', () => {
  const position = { v: '2026-11-19T01:00:00.000Z', id: '6f1c2b0e-3a4d-4e5f-8a9b-0c1d2e3f4a5b' };
  assert.deepEqual(decodeCursor(encodeCursor(position)), position);
  assert.deepEqual(decodeCursor(encodeCursor({ v: 3, id: 'a' })), { v: 3, id: 'a' });
  assert.equal(decodeCursor(undefined), null);
  const forged = Buffer.from(JSON.stringify({ v: {}, id: 'a' })).toString('base64url');
  for (const bad of ['', 'not-base64!', 'e30', forged, Buffer.from('[1]').toString('base64url')]) {
    rejectsWith(() => decodeCursor(bad), 'INVALID_CURSOR', 400);
  }
});

test('toPage: limit+1개를 받아 다음 페이지 여부를 정한다', () => {
  const rows = [1, 2, 3].map((n) => ({ id: `id-${n}`, createdAt: `2026-11-1${n}` }));
  const positionOf = (row) => ({ v: row.createdAt, id: row.id });

  const first = toPage(rows, 2, positionOf);
  assert.deepEqual(first.items.map((r) => r.id), ['id-1', 'id-2']);
  assert.deepEqual(decodeCursor(first.nextCursor), { v: '2026-11-12', id: 'id-2' });

  const last = toPage(rows.slice(2), 2, positionOf);
  assert.deepEqual(last, { items: [rows[2]], nextCursor: null });
  assert.deepEqual(toPage([], 2, positionOf), { items: [], nextCursor: null });
});
