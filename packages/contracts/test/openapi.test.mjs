// 계약 파일 검사: yaml이 읽히고, $ref가 모두 풀리고, F-05 공통 규약(쓰기 = Idempotency-Key, 오류 응답, shop 범위)을 지키는지.
// 서버 구현 후에는 실제 요청·응답을 이 스키마로 검증하는 계약 테스트를 apps/server에 붙인다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import yaml from 'js-yaml';

const load = (f) => yaml.load(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'));
const crm = load('crm.openapi.yaml');
const resolve = (doc, ref) => ref.slice(2).split('/').reduce((o, k) => o?.[k], doc);
const ops = (doc) =>
  Object.entries(doc.paths).flatMap(([path, item]) =>
    Object.entries(item).filter(([m]) => m !== 'parameters').map(([method, op]) => ({ path, method, op })),
  );

test('모든 $ref가 풀린다', () => {
  for (const f of ['crm.openapi.yaml', 'auth.openapi.yaml']) {
    const doc = load(f);
    const refs = [];
    (function walk(o) {
      if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) k === '$ref' ? refs.push(v) : walk(v);
    })(doc);
    assert.deepEqual(refs.filter((r) => resolve(doc, r) === undefined), [], f);
  }
});

test('CRM 경로는 모두 /api/shops/{shopId} 아래다(매장 격리)', () => {
  for (const path of Object.keys(crm.paths)) assert.match(path, /^\/api\/shops\/\{shopId\}\//);
});

test('쓰기(POST·PUT·PATCH·DELETE)는 Idempotency-Key를 받는다 — 저장하지 않는 조회 same-name-check만 예외', () => {
  const missing = ops(crm)
    .filter(({ method }) => ['post', 'put', 'patch', 'delete'].includes(method))
    .filter(({ path }) => !path.endsWith('/same-name-check'))
    .filter(({ op }) => !(op.parameters ?? []).some((p) => p.$ref === '#/components/parameters/IdempotencyKey'))
    .map(({ method, path }) => `${method} ${path}`);
  assert.deepEqual(missing, []);
});

test('모든 동작에 공통 오류 응답이 있다', () => {
  const missing = ops(crm).filter(({ op }) => op.responses.default?.$ref !== '#/components/responses/Error');
  assert.deepEqual(missing.map(({ method, path }) => `${method} ${path}`), []);
  assert.deepEqual(crm.components.schemas.Error.required, ['code', 'message', 'details']);
});

test('수정 요청은 version이 필수다(동시 수정 거부)', () => {
  for (const name of ['MenuPatch', 'CustomerPatch', 'AppointmentPatch']) {
    const parts = crm.components.schemas[name].allOf;
    assert.ok(parts.some((p) => p.required?.includes('version')), name);
    // 수정은 보낸 필드만 — Input(필수 필드 있음)이 아니라 Fields를 쓴다
    assert.ok(parts.some((p) => p.$ref?.endsWith('Fields')), name);
  }
});

test('예약 상태 값은 명세 5종, 상태 바꾸기는 voided를 고를 수 없다', () => {
  assert.deepEqual(crm.components.schemas.AppointmentStatus.enum, ['scheduled', 'completed', 'cancelled', 'no_show', 'voided']);
  const body = crm.paths['/api/shops/{shopId}/appointments/{appointmentId}/status'].put.requestBody.content['application/json'].schema;
  assert.ok(!body.properties.status.enum.includes('voided'));
});
