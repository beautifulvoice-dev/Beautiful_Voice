const assert = require('node:assert/strict');
const { test } = require('node:test');
const { renderSmsTemplate, validateSmsTemplate } = require('../dist/sms/sms-template.js');

test('validates the four template slots and reports editor offsets', () => {
  for (const slot of ['pre_visit', 'post_session', 'post_amount', 'post_general']) {
    assert.equal(validateSmsTemplate(slot, '{고객 이름} {매장 이름} {매장 위치·링크} {예약 날짜·시간} {메뉴}').ok, true);
  }
  assert.equal(validateSmsTemplate('pre_visit', '{횟수권 이름} {지갑 잔액} {남은 횟수}').ok, true);
  assert.equal(validateSmsTemplate('post_amount', '{오늘 차감 금액}').ok, true);
  assert.equal(validateSmsTemplate('post_session', '{오늘 차감 횟수}').ok, true);
  assert.deepEqual(validateSmsTemplate('post_general', '문자 {지갑 잔액}').error,
    { code: 'DISALLOWED_VARIABLE', variable: '지갑 잔액', index: 3 });
  assert.deepEqual(validateSmsTemplate('post_amount', '{오늘 차감 횟수}').error,
    { code: 'DISALLOWED_VARIABLE', variable: '오늘 차감 횟수', index: 0 });
  assert.deepEqual(validateSmsTemplate('pre_visit', '안녕 {모르는 값}').error,
    { code: 'UNKNOWN_VARIABLE', variable: '모르는 값', index: 3 });
  assert.deepEqual(validateSmsTemplate('pre_visit', '문자 {고객 이름').error,
    { code: 'INVALID_BRACES', index: 3, field: 'body' });
  assert.deepEqual(validateSmsTemplate('pre_visit', ' \n ').error, { code: 'EMPTY_BODY' });
});

test('renders braces once, formats KST time, and keeps replacement values literal', () => {
  const text = '{{고객 이름}} / {고객 이름} / {예약 날짜·시간}';
  const result = renderSmsTemplate('pre_visit', text, {
    customerName: '{별명}',
    appointmentStart: new Date('2026-11-26T05:30:00Z'),
    shopName: '합성 매장',
  });
  assert.equal(result.value.body, '{고객 이름} / {별명} / 11월 26일(목) 오후 2시 30분');
  assert.equal(renderSmsTemplate('pre_visit', '{예약 날짜·시간}', {
    appointmentStart: new Date('2026-11-26T05:00:00Z'),
  }).value.body, '11월 26일(목) 오후 2시');
});

test('requires nonempty values and positive deductions while returning negative balance warnings', () => {
  assert.deepEqual(renderSmsTemplate('pre_visit', '{고객 이름}', { customerName: '  ' }).error,
    { code: 'MISSING_VARIABLE', variable: '고객 이름', index: 0 });
  for (const deductedAmount of [-1, 0, 2.5]) {
    assert.equal(renderSmsTemplate('post_amount', '{오늘 차감 금액}', { deductedAmount }).error.code, 'INVALID_VARIABLE_VALUE');
  }
  assert.equal(renderSmsTemplate('post_session', '{오늘 차감 횟수}', { deductedSessions: 0 }).error.code, 'INVALID_VARIABLE_VALUE');
  const result = renderSmsTemplate('post_amount', '{오늘 차감 금액} / {지갑 잔액} / {남은 횟수} / {지갑 잔액}', {
    deductedAmount: 50000, walletBalance: -30000, remainingSessions: -1,
  });
  assert.equal(result.value.body, '50,000원 / -30,000원 / -1회 / -30,000원');
  assert.deepEqual(result.value.negativeBalances, ['walletBalance', 'remainingSessions']);
});

test('enforces KS X 1001 and checks the rendered result again', () => {
  assert.equal(validateSmsTemplate('pre_visit', '가A').value.byteLength, 3);
  for (const character of ['😀', '힣', '\0']) {
    assert.deepEqual(validateSmsTemplate('pre_visit', '가' + character).error,
      { code: 'UNSUPPORTED_CHAR', field: 'body', index: 1 });
  }
  assert.deepEqual(renderSmsTemplate('pre_visit', '안녕 {고객 이름}', { customerName: '고객😀' }).error,
    { code: 'UNSUPPORTED_CHAR', field: 'body', index: 5 });
  assert.equal(renderSmsTemplate('pre_visit', '{고객 이름}', { customerName: '가'.repeat(1001) }).error.code, 'BODY_TOO_LONG');
});

test('uses 90B for SMS, 2000B as the body ceiling, and limits LMS titles to 40 bytes', () => {
  const shopName = '가'.repeat(41);
  const ninety = renderSmsTemplate('post_general', '가'.repeat(45), { shopName });
  assert.deepEqual([ninety.value.byteLength, ninety.value.messageType], [90, 'SMS']);
  const ninetyOne = renderSmsTemplate('post_general', '가'.repeat(45) + 'A', { shopName });
  assert.deepEqual([ninetyOne.value.byteLength, ninetyOne.value.messageType, ninetyOne.value.title], [91, 'LMS', '가'.repeat(20)]);
  assert.equal(renderSmsTemplate('post_general', 'A'.repeat(91), {}).error.code, 'MISSING_TITLE');
  assert.deepEqual(renderSmsTemplate('post_general', 'A'.repeat(91), { shopName: '합성😀' }).error,
    { code: 'UNSUPPORTED_CHAR', field: 'title', index: 2 });
  assert.equal(renderSmsTemplate('post_general', '가'.repeat(1000), { shopName }).value.byteLength, 2000);
  assert.deepEqual(validateSmsTemplate('post_general', '가'.repeat(1000) + 'A').error,
    { code: 'BODY_TOO_LONG', maxBytes: 2000 });
});
