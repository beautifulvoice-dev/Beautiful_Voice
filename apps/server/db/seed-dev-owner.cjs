const { Client } = require('pg');

const SHOP_ID = 'c17ee3bd-402c-400c-8e19-a598ac17cd9b';
const SHOP_NAME = 'BeautifulVoice Dev Demo';

async function seed() {
  const { DATABASE_MIGRATION_URL, BV_DEV_KAKAO_USER_ID } = process.env;
  if (!DATABASE_MIGRATION_URL || !/^[1-9][0-9]{0,18}$/.test(BV_DEV_KAKAO_USER_ID ?? '')) {
    throw new Error('Set the migration URL and verified Kakao user ID for the dev app.');
  }

  const client = new Client({ connectionString: DATABASE_MIGRATION_URL, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.shop_id', $1, true)", [SHOP_ID]);
    await client.query(
      'INSERT INTO crm.shop (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [SHOP_ID, SHOP_NAME],
    );
    await client.query(
      `INSERT INTO crm.user_membership (shop_id, user_id, kakao_user_id)
       VALUES ($1, gen_random_uuid(), $2) ON CONFLICT (shop_id) DO NOTHING`,
      [SHOP_ID, BV_DEV_KAKAO_USER_ID],
    );
    const { rowCount } = await client.query(
      'SELECT 1 FROM crm.user_membership WHERE shop_id = $1 AND kakao_user_id = $2',
      [SHOP_ID, BV_DEV_KAKAO_USER_ID],
    );
    if (rowCount !== 1) throw new Error('The demo shop already has a different owner.');

    await client.query(
      'INSERT INTO crm.shop_settings (shop_id) VALUES ($1) ON CONFLICT (shop_id) DO NOTHING',
      [SHOP_ID],
    );
    await client.query('COMMIT');
    console.log('Dev demo shop and owner are ready.');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

seed().catch((error) => {
  console.error(error.code ? `Dev seed failed (${error.code}).` : error.message);
  process.exitCode = 1;
});
