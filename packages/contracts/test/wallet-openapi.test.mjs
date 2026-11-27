// 지갑 계약(S4) 검사: 세션 기준 주소(매장 ID 없음), 쓰기 = Idempotency-Key, 공통 오류, 웹 본문은 부호·예약을 받지 않는다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import yaml from 'js-yaml';

const doc = yaml.load(readFileSync(new URL('../wallet.openapi.yaml', import.meta.url), 'utf8'));
const ops = Object.entries(doc.paths).flatMap(([path, item]) =>
  Object.entries(item).filter(([m]) => m !== 'parameters').map(([method, op]) => ({ path, method, op })));

test('지갑 주소는 세션 기준이다 — 경로·쿼리에 shopId가 없다(ADR-0009 A단계)', () => {
  for (const { path, op } of ops) {
    assert.doesNotMatch(path, /shop/i);
    assert.ok(!(op.parameters ?? []).some((p) => /shop/i.test(p.name ?? '')), path);
  }
});

test('쓰기는 Idempotency-Key를 받고, 모든 동작에 공통 오류 응답이 있다', () => {
  for (const { method, path, op } of ops) {
    assert.equal(op.responses.default?.$ref, '#/components/responses/Error', `${method} ${path}`);
    if (method === 'post') assert.ok(op.parameters.some((p) => p.$ref === '#/components/parameters/IdempotencyKey'), path);
  }
});

test('웹 기록 본문은 payment·deduct와 양수 value만 — signedDelta·예약·회차·opening_balance 없음', () => {
  const input = doc.components.schemas.WalletEntryInput;
  assert.equal(input.additionalProperties, false);
  assert.deepEqual(input.properties.label.enum, ['payment', 'deduct']);
  for (const field of ['signedDelta', 'appointmentId', 'cycleSeq', 'shopId']) assert.ok(!(field in input.properties), field);
  assert.equal(doc.components.schemas.Value.minimum, 1);
  assert.equal(doc.components.schemas.PassInput.additionalProperties, false);
});

test('응답 스키마는 모든 칸을 보낸다(값이 없으면 null)', () => {
  for (const name of ['PassSummary', 'WalletSummary', 'WalletEntry']) {
    const schema = doc.components.schemas[name];
    assert.deepEqual(Object.keys(schema.properties).filter((k) => !schema.required.includes(k)), [], name);
  }
});
