const { readFile, readdir } = require('node:fs/promises');
const { join } = require('node:path');
const { Client } = require('pg');

async function migrate() {
  const connectionString = process.env.DATABASE_MIGRATION_URL;
  if (!connectionString) throw new Error('DATABASE_MIGRATION_URL is required');

  const dir = join(__dirname, 'migrations');
  const files = (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort();
  const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('beautifulvoice:crm:migrations'))`);
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS crm;
      CREATE TABLE IF NOT EXISTS crm.schema_migration (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    const { rows } = await client.query('SELECT name FROM crm.schema_migration');
    const applied = new Set(rows.map((row) => row.name));
    for (const file of files) {
      if (applied.has(file)) continue;
      await client.query(await readFile(join(dir, file), 'utf8'));
      await client.query('INSERT INTO crm.schema_migration (name) VALUES ($1)', [file]);
    }
    await client.query('COMMIT');
  } finally {
    await client.end();
  }
}

migrate().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
