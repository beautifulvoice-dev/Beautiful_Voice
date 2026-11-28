import { createHmac, randomBytes } from 'node:crypto';
import type { Deliver } from './sms-dispatch';

export function createSolapiSender(
  { apiKey, apiSecret, from }: { apiKey: string; apiSecret: string; from: string },
  request: typeof fetch = fetch,
): Deliver {
  return async ({ id, recipient, body, type, title }) => {
    const date = new Date().toISOString();
    const salt = randomBytes(16).toString('hex');
    const signature = createHmac('sha256', apiSecret).update(date + salt).digest('hex');
    const response = await request('https://api.solapi.com/messages/v4/send-many/detail', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        showMessageList: true,
        messages: [{
          from, to: recipient, text: body, type,
          ...(type === 'LMS' && title ? { subject: title } : {}),
          customFields: { bvIdempotencyKey: id },
        }],
      }),
    });

    if (response.status === 429) return { status: 'not_accepted' };
    if (response.status === 401 || response.status === 403) return { status: 'halt' };
    if (response.status >= 500) return { status: 'unknown' };
    const data = await response.json() as {
      messageList?: Array<{ statusCode?: string; messageId?: string }>;
      failedMessageList?: Array<{ statusCode?: string }>;
    };
    const rejection = data?.failedMessageList?.[0]?.statusCode;
    if (rejection === '1030' || rejection === '3040') return { status: 'halt' };
    if (response.status >= 400 || rejection) return { status: 'failed' };
    const message = data?.messageList?.[0];
    if (message?.statusCode === '2000' && typeof message.messageId === 'string' && message.messageId) {
      return { status: 'sent', providerId: message.messageId };
    }
    return { status: 'unknown' };
  };
}
