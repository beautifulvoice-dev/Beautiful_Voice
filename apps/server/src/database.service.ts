import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';

const roleUrls = {
  bv_app: 'DATABASE_URL',
  bv_ai_executor: 'DATABASE_AI_EXECUTOR_URL',
  bv_ops: 'DATABASE_SUPERVISION_URL',
  bv_provision: 'DATABASE_PROVISION_URL',
  bv_system: 'DATABASE_SYSTEM_URL',
} as const;
type CrmRole = keyof typeof roleUrls;

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly pools = new Map<CrmRole, Pool>();

  constructor() {
    for (const role of Object.keys(roleUrls) as CrmRole[]) {
      const connectionString = process.env[roleUrls[role]];
      if (connectionString) this.pools.set(role, new Pool({ connectionString, connectionTimeoutMillis: 5000 }));
    }
  }

  async onModuleInit(): Promise<void> {
    if (!this.pools.has('bv_app') && process.env.NODE_ENV === 'production') {
      throw new Error('DATABASE_URL is required');
    }

    try {
      for (const [role, pool] of this.pools) {
        pool.on('error', () => new Logger(DatabaseService.name).warn('An idle database connection failed'));
        const { rows: [result] } = await pool.query<{ allowed: boolean }>(`
        SELECT pg_has_role(current_user, $1::name, 'USAGE')
          AND NOT pg_has_role(current_user, n.nspowner, 'MEMBER')
          AND NOT EXISTS (
            SELECT FROM pg_roles AS r
            WHERE (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication
                OR r.rolname IN ('rds_superuser', 'pg_read_all_data', 'pg_write_all_data')
                OR (r.rolname = ANY ($2::name[]) AND r.rolname <> $1::name))
              AND pg_has_role(current_user, r.oid, 'MEMBER')
          ) AS allowed
        FROM pg_namespace AS n
        WHERE n.nspname = 'crm'
        `, [role, Object.keys(roleUrls)]);
        if (!result?.allowed) throw new Error('An unprivileged CRM application role is required');
      }
    } catch (error) {
      await this.onModuleDestroy();
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    const pools = [...this.pools.values()];
    this.pools.clear();
    await Promise.all(pools.map((pool) => pool.end()));
  }

  // shopId comes from authenticated membership, never directly from request input.
  async withShop<T>(shopId: string, run: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.withScopedRole('bv_app', shopId, run);
  }

  async withAiExecutor<T>(assignedShopId: string, run: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.withScopedRole('bv_ai_executor', assignedShopId, run);
  }

  async withSupervisor<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.inTransaction(run, 'bv_ops');
  }

  async withProvisioner<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.inTransaction(run, 'bv_provision');
  }

  async withSystem<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.inTransaction(run, 'bv_system');
  }

  private async withScopedRole<T>(
    role: 'bv_app' | 'bv_ai_executor', shopId: string, run: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.inTransaction(async (client) => {
      await client.query("SELECT set_config('app.shop_id', $1::uuid::text, true)", [shopId]);
      return run(client);
    }, role);
  }

  // Use only the internal user ID obtained after verifying the caller's identity.
  async findOwnerShop(authenticatedUserId: string): Promise<string | null> {
    return this.inTransaction(async (client) => {
      await client.query(`SELECT set_config('app.authenticated_user_id', $1::uuid::text, true)`, [authenticatedUserId]);
      const { rows } = await client.query<{ shop_id: string }>(
        `SELECT shop_id FROM crm.user_membership WHERE user_id = $1::uuid LIMIT 2`,
        [authenticatedUserId],
      );
      return rows.length === 1 ? rows[0].shop_id : null;
    });
  }

  // Use the ID returned by Kakao, never one supplied in a browser request.
  async findKakaoOwner(kakaoId: string): Promise<{ userId: string; shopId: string } | null> {
    return this.inTransaction(async (client) => {
      await client.query(`SELECT set_config('app.authenticated_kakao_id', $1, true)`, [kakaoId]);
      const { rows: [owner] } = await client.query<{ user_id: string; shop_id: string }>(
        'SELECT user_id, shop_id FROM crm.user_membership WHERE kakao_user_id = $1',
        [kakaoId],
      );
      return owner ? { userId: owner.user_id, shopId: owner.shop_id } : null;
    });
  }

  async ownerConsentAccepted(userId: string, version: string): Promise<boolean> {
    return this.inTransaction(async (client) => {
      await client.query("SELECT set_config('app.authenticated_user_id', $1::uuid::text, true)", [userId]);
      const { rowCount } = await client.query(
        'SELECT 1 FROM crm.owner_consent WHERE user_id = $1 AND version = $2', [userId, version],
      );
      return rowCount === 1;
    });
  }

  async recordOwnerConsent(userId: string, consent: { version: string; text: string }): Promise<void> {
    await this.inTransaction(async (client) => {
      await client.query("SELECT set_config('app.authenticated_user_id', $1::uuid::text, true)", [userId]);
      await client.query(
        'INSERT INTO crm.owner_consent (user_id, version, consent_text) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [userId, consent.version, consent.text],
      );
    });
  }

  private async inTransaction<T>(
    run: (client: PoolClient) => Promise<T>, role: CrmRole = 'bv_app',
  ): Promise<T> {
    const pool = this.pools.get(role);
    if (!pool) throw new Error(`${roleUrls[role]} is required`);
    const client = await pool.connect();
    let discardClient = false;
    try {
      await client.query('BEGIN');
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        discardClient = true;
      }
      throw error;
    } finally {
      client.release(discardClient);
    }
  }
}
