import { normalizePhone } from '@bv/customers';
import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import { dispatchSmsForShop } from './sms-dispatch';
import { createSolapiSender } from './solapi-sender';

@Injectable()
export class SmsDispatchScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SmsDispatchScheduler.name);
  private timer?: ReturnType<typeof setInterval>;
  private stopping = false;

  constructor(private readonly db: DatabaseService) {}

  onApplicationBootstrap(): void {
    if (process.env.BV_SMS_DISPATCH_ENABLED !== 'true') return;

    const { BV_SMS_DISPATCH_SHOP_ID: shopId, BV_SMS_DISPATCH_TEST_RECIPIENT: recipient, BV_SOLAPI_API_KEY: apiKey,
      BV_SOLAPI_API_SECRET: apiSecret, BV_SOLAPI_SENDER: from, DATABASE_SYSTEM_URL: systemUrl } = process.env;
    if (!shopId || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(shopId) ||
        !apiKey || !apiSecret || !from || !/^\d{8,11}$/.test(from) || !systemUrl) {
      throw new Error('Enabled SMS dispatch requires a dev shop ID, SOLAPI sender and credentials, and DATABASE_SYSTEM_URL');
    }

    const normalized = recipient ? normalizePhone(recipient) : null;
    if (!normalized?.ok || normalized.kind !== 'mobile') {
      throw new Error('Enabled dev SMS dispatch requires BV_SMS_DISPATCH_TEST_RECIPIENT to be a valid mobile number');
    }
    const testRecipient = normalized.phone;
    const deliver = createSolapiSender({ apiKey, apiSecret, from });
    let running = false;
    const tick = async () => {
      if (running || this.stopping) return;
      running = true;
      try {
        const result = await dispatchSmsForShop(this.db, shopId, deliver, { testRecipient, shouldContinue: () => !this.stopping });
        if (result === 'halt') {
          this.logger.error('SMS dispatch paused after SOLAPI rejected the account or sender');
        }
      } catch {
        this.logger.error('SMS dispatch tick failed');
      } finally {
        running = false;
      }
    };
    this.timer = setInterval(() => { void tick(); }, 60_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    this.stopping = true;
    clearInterval(this.timer);
  }
}
