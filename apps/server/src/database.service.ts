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
    if (!this.pool) throw new Error('DATABASE_URL is required');
    const client = await this.pool.connect();
    let discardClient = false;
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.shop_id', $1::uuid::text, true)`, [shopId]);
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
