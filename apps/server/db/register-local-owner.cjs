const { randomBytes } = require('node:crypto');
const { createServer } = require('node:http');
const { Client } = require('pg');
const { kakaoAuthorizationUrl, verifyKakaoCallback } = require('../dist/kakao-login.js');

const CALLBACK = 'http://127.0.0.1:5173/api/auth/kakao/callback';
const SHOP = 'ee3fe317-c214-446f-82c2-c209cc4eafa1';
const OWNER = 'fecfeac9-d4bc-4fea-b761-1755770fa98c';

async function register(client, kakaoId) {
  await client.query('BEGIN');
  try {
    await client.query('INSERT INTO crm.shop (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [SHOP, 'BeautifulVoice local test shop']);
    await client.query(
      `INSERT INTO crm.user_membership (shop_id, user_id, kakao_user_id)
       VALUES ($1, $2, $3) ON CONFLICT (shop_id) DO NOTHING`, [SHOP, OWNER, kakaoId],
    );
    const { rows: [row] } = await client.query(
      'SELECT user_id, kakao_user_id FROM crm.user_membership WHERE shop_id = $1', [SHOP],
    );
    if (row?.user_id !== OWNER || row.kakao_user_id !== kakaoId) {
      throw new Error('The test shop already belongs to another account');
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  const { DATABASE_MIGRATION_URL, KAKAO_CLIENT_ID, KAKAO_CLIENT_SECRET, KAKAO_REDIRECT_URI } = process.env;
  if (process.env.NODE_ENV === 'production' || !KAKAO_CLIENT_ID || !KAKAO_CLIENT_SECRET
    || KAKAO_REDIRECT_URI !== CALLBACK || !DATABASE_MIGRATION_URL) {
    throw new Error('Set the local Kakao and migration settings in .env first');
  }
  const dbUrl = new URL(DATABASE_MIGRATION_URL);
  const envLocal = ['127.0.0.1', 'localhost', '[::1]'].includes(dbUrl.hostname);
  if (!['postgres:', 'postgresql:'].includes(dbUrl.protocol) || !envLocal
    || dbUrl.search || dbUrl.hash || dbUrl.username !== 'bv_local' || dbUrl.pathname !== '/beautifulvoice') {
    throw new Error('Registration accepts only the BeautifulVoice local development database');
  }
  const config = { clientId: KAKAO_CLIENT_ID, clientSecret: KAKAO_CLIENT_SECRET, redirectUri: CALLBACK };
  const client = new Client({ connectionString: dbUrl.href, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    await client.query('SELECT kakao_user_id FROM crm.user_membership LIMIT 0');
    await new Promise((resolve, reject) => {
      const state = randomBytes(32).toString('base64url');
      let claimed = false;
      let timer;
      const callbackUrl = new URL(CALLBACK);
      const server = createServer(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        if (req.method !== 'GET' || req.headers.host !== callbackUrl.host
          || req.url?.split('?')[0] !== callbackUrl.pathname) {
          res.writeHead(404).end();
          return;
        }
        const url = new URL(req.url, CALLBACK);
        const code = url.searchParams.get('code');
        if (claimed || !code || url.searchParams.get('state') !== state) {
          res.writeHead(400).end('Invalid Kakao callback.');
          return;
        }
        claimed = true;
        clearTimeout(timer);
        try {
          const kakaoId = await verifyKakaoCallback(config, { code, state }, state);
          await register(client, kakaoId);
          res.writeHead(200).end('Test owner registered. Close this tab and start the app.');
          finish();
        } catch {
          res.writeHead(400).end('Registration failed. Check the local terminal.');
          finish(new Error('Kakao verification or local account registration failed; no account was replaced'));
        }
      });
      function finish(error) {
        clearTimeout(timer);
        server.close();
        if (error) reject(error);
        else resolve();
      }
      server.once('error', (error) => reject(new Error(error.code === 'EADDRINUSE'
        ? 'Port 5173 is busy. Stop the web dev server before registration.' : 'Could not open local callback')));
      server.listen(5173, '127.0.0.1', () => {
        timer = setTimeout(() => finish(new Error('Kakao registration timed out')), 5 * 60 * 1000);
        console.log('Open this URL in your own browser and sign in as the test owner:');
        console.log(kakaoAuthorizationUrl(config, state).href);
      });
    });
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.code ? 'Local database setup failed; check that PostgreSQL is running and migrated.' : error.message);
    process.exitCode = 1;
  });
}

module.exports = { register, SHOP, OWNER };
