import { decode, encode } from 'iconv-lite';

export type SmsTemplateSlot = 'pre_visit' | 'post_session' | 'post_amount' | 'post_general';

const VARIABLE_KEYS = {
  '고객 이름': 'customerName',
  '매장 이름': 'shopName',
  '예약 날짜·시간': 'appointmentStart',
  '메뉴': 'menuName',
  '매장 위치·링크': 'shopLocation',
  '횟수권 이름': 'passName',
  '오늘 차감 금액': 'deductedAmount',
  '지갑 잔액': 'walletBalance',
  '오늘 차감 횟수': 'deductedSessions',
  '남은 횟수': 'remainingSessions',
} as const;
type VariableName = keyof typeof VARIABLE_KEYS;
type VariableKey = (typeof VARIABLE_KEYS)[VariableName];
type NumericKey = 'deductedAmount' | 'walletBalance' | 'deductedSessions' | 'remainingSessions';
export type SmsTemplateValues = Partial<
  Record<Exclude<VariableKey, NumericKey | 'appointmentStart'>, string | null>
  & Record<NumericKey, number | null>
  & { appointmentStart: Date | null }
>;

const COMMON: readonly VariableKey[] = ['customerName', 'shopName', 'shopLocation', 'appointmentStart', 'menuName'];
const BALANCES: readonly VariableKey[] = ['passName', 'walletBalance', 'remainingSessions'];
const ALLOWED: Record<SmsTemplateSlot, readonly VariableKey[]> = {
  pre_visit: [...COMMON, ...BALANCES],
  post_session: [...COMMON, ...BALANCES, 'deductedSessions'],
  post_amount: [...COMMON, ...BALANCES, 'deductedAmount'],
  post_general: COMMON,
};

const SMS_MAX_BYTES = 90;
const BODY_MAX_BYTES = 2000;
const LMS_TITLE_MAX_BYTES = 40;
const NUMBER = new Intl.NumberFormat('ko-KR');
const APPOINTMENT_TIME = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', weekday: 'short',
  hour: 'numeric', minute: 'numeric', hour12: true,
});

type TemplateError =
  | { code: 'EMPTY_BODY' | 'MISSING_TITLE' }
  | { code: 'INVALID_BRACES' | 'UNSUPPORTED_CHAR'; index: number; field: 'body' | 'title' }
  | { code: 'UNKNOWN_VARIABLE' | 'DISALLOWED_VARIABLE' | 'MISSING_VARIABLE' | 'INVALID_VARIABLE_VALUE'; variable: string; index: number }
  | { code: 'BODY_TOO_LONG'; maxBytes: number };
type Result<T> = { ok: true; value: T } | { ok: false; error: TemplateError };
type Token = { literal: string } | { key: VariableKey; name: VariableName; index: number };

/** Errors identify UTF-16 offsets in the text the editor or preview displays. */
export function validateSmsTemplate(slot: SmsTemplateSlot, body: string): Result<{ byteLength: number }> {
  const parsed = readTemplate(slot, body);
  return parsed.ok ? { ok: true, value: { byteLength: parsed.value.byteLength } } : parsed;
}

type RenderedSms = {
  body: string;
  byteLength: number;
  negativeBalances: ('walletBalance' | 'remainingSessions')[];
} & ({ messageType: 'SMS' } | { messageType: 'LMS'; title: string });

/** Use the same renderer for a preview and for rendering immediately before queueing. */
export function renderSmsTemplate(slot: SmsTemplateSlot, body: string, values: SmsTemplateValues): Result<RenderedSms> {
  const parsed = readTemplate(slot, body);
  if (!parsed.ok) return parsed;
  let rendered = '';
  const negativeBalances = new Set<'walletBalance' | 'remainingSessions'>();
  for (const token of parsed.value.tokens) {
    if ('literal' in token) {
      rendered += token.literal;
      continue;
    }
    const value = values[token.key];
    if (value == null || (typeof value === 'string' && !value.trim())) {
      return { ok: false, error: { code: 'MISSING_VARIABLE', variable: token.name, index: token.index } };
    }
    const formatted = formatValue(token.key, value);
    if (formatted === null) {
      return { ok: false, error: { code: 'INVALID_VARIABLE_VALUE', variable: token.name, index: token.index } };
    }
    if ((token.key === 'walletBalance' || token.key === 'remainingSessions') && typeof value === 'number' && value < 0) {
      negativeBalances.add(token.key);
    }
    rendered += formatted;
  }
  const measured = measureText(rendered, 'body', BODY_MAX_BYTES);
  if (!measured.ok) return measured;
  const result = { body: rendered, byteLength: measured.value, negativeBalances: [...negativeBalances] };
  if (result.byteLength <= SMS_MAX_BYTES) return { ok: true, value: { ...result, messageType: 'SMS' } };

  // The provider's LMS title is the shop name, limited to 40 encoded bytes.
  const shopName = values.shopName?.trim();
  if (!shopName) {
    return { ok: false, error: { code: 'MISSING_TITLE' } };
  }
  let title = Array.from(shopName).slice(0, LMS_TITLE_MAX_BYTES).join('');
  const measuredTitle = measureText(title, 'title', BODY_MAX_BYTES);
  if (!measuredTitle.ok) return measuredTitle;
  while (encode(title, 'euc-kr').length > LMS_TITLE_MAX_BYTES) title = title.slice(0, -1);
  return { ok: true, value: { ...result, messageType: 'LMS', title } };
}

function readTemplate(slot: SmsTemplateSlot, body: string): Result<{ tokens: Token[]; byteLength: number }> {
  if (!body.trim()) return { ok: false, error: { code: 'EMPTY_BODY' } };
  const measured = measureText(body, 'body', BODY_MAX_BYTES);
  if (!measured.ok) return measured;
  const tokens: Token[] = [];
  let offset = 0;
  for (const match of body.matchAll(/\{\{|\}\}|\{[^{}]*\}|[{}]/gu)) {
    const index = match.index;
    const [text] = match;
    if (index > offset) tokens.push({ literal: body.slice(offset, index) });
    offset = index + text.length;
    if (text === '{{' || text === '}}') {
      tokens.push({ literal: text[0]! });
      continue;
    }
    if (text.length === 1) return { ok: false, error: { code: 'INVALID_BRACES', field: 'body', index } };
    const name = text.slice(1, -1);
    if (!Object.hasOwn(VARIABLE_KEYS, name)) return { ok: false, error: { code: 'UNKNOWN_VARIABLE', variable: name, index } };
    const key = VARIABLE_KEYS[name as VariableName];
    if (!ALLOWED[slot].includes(key)) {
      return { ok: false, error: { code: 'DISALLOWED_VARIABLE', variable: name, index } };
    }
    tokens.push({ key, name: name as VariableName, index });
  }
  if (offset < body.length) tokens.push({ literal: body.slice(offset) });
  return { ok: true, value: { tokens, byteLength: measured.value } };
}

function formatValue(key: VariableKey, value: string | number | Date): string | null {
  switch (key) {
    case 'appointmentStart': {
      if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return null;
      const parts = Object.fromEntries(APPOINTMENT_TIME.formatToParts(value).map(({ type, value: part }) => [type, part]));
      return `${parts.month}월 ${parts.day}일(${parts.weekday}) ${parts.dayPeriod} ${parts.hour}시${Number(parts.minute) ? ` ${Number(parts.minute)}분` : ''}`;
    }
    case 'deductedAmount':
    case 'walletBalance':
    case 'deductedSessions':
    case 'remainingSessions': {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
      if ((key === 'deductedAmount' || key === 'deductedSessions') && value <= 0) return null;
      return NUMBER.format(value) + (key === 'deductedAmount' || key === 'walletBalance' ? '원' : '회');
    }
    default:
      return typeof value === 'string' ? value : null;
  }
}

function measureText(text: string, field: 'body' | 'title', maxBytes: number): Result<number> {
  let index = 0;
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code > 0 && code <= 0x7f) {
      bytes += 1;
    } else {
      // iconv-lite's Korean codec includes CP949. Keep ASCII and the KS X 1001 plane,
      // and reject substitutions such as an unsupported character encoded as '?'.
      const encoded = encode(character, 'euc-kr');
      if (encoded.length !== 2 || !encoded.every((byte) => byte >= 0xa1 && byte <= 0xfe)
          || decode(encoded, 'euc-kr') !== character) {
        return { ok: false, error: { code: 'UNSUPPORTED_CHAR', index, field } };
      }
      bytes += 2;
    }
    if (bytes > maxBytes) return { ok: false, error: { code: 'BODY_TOO_LONG', maxBytes } };
    index += character.length;
  }
  return { ok: true, value: bytes };
}
