import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private pool = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 })
    : undefined;

  async onModuleInit(): Promise<void> {
    if (!this.pool) {
      if (process.env.NODE_ENV === 'production') throw new Error('DATABASE_URL is required');
      return;
    }

    this.pool.on('error', () => new Logger(DatabaseService.name).warn('An idle database connection failed'));
    try {
      const { rows: [role] } = await this.pool.query<{ allowed: boolean }>(`
        SELECT pg_has_role(current_user, 'bv_app', 'USAGE')
          AND NOT pg_has_role(current_user, n.nspowner, 'MEMBER')
          AND NOT EXISTS (
            SELECT FROM pg_roles AS r
            WHERE (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication
                OR r.rolname IN ('rds_superuser', 'pg_read_all_data', 'pg_write_all_data'))
              AND pg_has_role(current_user, r.oid, 'MEMBER')
          ) AS allowed
        FROM pg_namespace AS n
        WHERE n.nspname = 'crm'
      `);
      if (!role?.allowed) throw new Error('An unprivileged CRM application role is required');
    } catch (error) {
      await this.onModuleDestroy();
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    const pool = this.pool;
    this.pool = undefined;
    await pool?.end();
  }

  // shopId comes from authenticated membership, never directly from request input.
  async withShop<T>(shopId: string, run: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.inTransaction(async (client) => {
      await client.query(`SELECT set_config('app.shop_id', $1::uuid::text, true)`, [shopId]);
      return run(client);
    });
  }

  /** 읽기 전용 한 스냅샷(REPEATABLE READ). 캘린더처럼 여러 조회를 한 시점으로 묶을 때 쓴다(설계 09 D5). */
  async withShopSnapshot<T>(shopId: string, run: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.inTransaction(async (client) => {
      await client.query(`SELECT set_config('app.shop_id', $1::uuid::text, true)`, [shopId]);
      return run(client);
    }, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
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

  private async inTransaction<T>(run: (client: PoolClient) => Promise<T>, begin = 'BEGIN'): Promise<T> {
    if (!this.pool) throw new Error('DATABASE_URL is required');
    const client = await this.pool.connect();
    let discardClient = false;
    try {
      await client.query(begin);
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
