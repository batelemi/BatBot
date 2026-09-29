#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { Client } = require('pg');

const root = path.resolve(__dirname, '..');
const sqlitePath = process.env.SQLITE_DB_PATH || path.join(root, 'sdrive.db');
const schemaPath = path.join(root, 'database', 'postgres-schema.sql');
const databaseUrl = String(process.env.DATABASE_URL || '').trim();

if (!databaseUrl) {
  console.error('DATABASE_URL est obligatoire pour lancer la migration.');
  process.exit(1);
}
if (!fs.existsSync(sqlitePath)) {
  console.error(`Base SQLite introuvable : ${sqlitePath}`);
  process.exit(1);
}

const sqlite = new Database(sqlitePath, { readonly: true });
const client = new Client({
  connectionString: databaseUrl,
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined
});

const tables = [
  {
    name: 'users',
    columns: ['id','username','phone','password_hash','premium_until','premium_started_at','ai_until','ai_started_at','disabled','must_change_password','temporary_password_hash','temporary_password_expires_at','created_at'],
    select: `SELECT id, username, phone, password_hash, premium_until, premium_started_at, ai_until, ai_started_at, disabled, must_change_password, temporary_password_hash, temporary_password_expires_at, created_at FROM users ORDER BY id`
  },
  {
    name: 'daily_matches',
    columns: ['id','match_name','home_probability','draw_probability','away_probability','recommended_pick','odds','match_date','created_at'],
    select: `SELECT id, match_name, home_probability, draw_probability, away_probability, recommended_pick, odds, match_date, created_at FROM daily_matches ORDER BY id`
  },
  {
    name: 'settings',
    columns: ['key','value'],
    select: `SELECT key, value FROM settings ORDER BY key`
  },
  {
    name: 'password_resets',
    columns: ['id','user_id','status','delivery_token','temporary_password_encrypted','temporary_password_expires_at','resolved_at','created_at'],
    select: `SELECT id, user_id, status, delivery_token, temporary_password_encrypted, temporary_password_expires_at, resolved_at, created_at FROM password_resets ORDER BY id`
  },
  {
    name: 'analysis_requests',
    columns: ['id','user_id','type','content','status','created_at'],
    select: `SELECT id, user_id, type, content, status, created_at FROM analysis_requests ORDER BY id`
  },
  {
    name: 'payment_requests',
    columns: ['id','user_id','offer','operator','amount','reference','status','admin_note','created_at','resolved_at'],
    select: `SELECT id, user_id, offer, operator, amount, reference, status, admin_note, created_at, resolved_at FROM payment_requests ORDER BY id`
  },
  {
    name: 'bookmakers',
    columns: ['id','name','bonus','url','active','created_at'],
    select: `SELECT id, name, bonus, url, active, created_at FROM bookmakers ORDER BY id`
  },
  {
    name: 'coupons',
    columns: ['id','platform_name','code','platform_url','description','active','created_at','updated_at'],
    select: `SELECT id, platform_name, code, platform_url, description, active, created_at, updated_at FROM coupons ORDER BY id`
  },
  {
    name: 'batbot_messages',
    columns: ['id','title','body','created_at','expires_at'],
    select: `SELECT id, title, body, created_at, expires_at FROM batbot_messages ORDER BY id`
  },
  {
    name: 'batbot_message_reads',
    columns: ['message_id','user_id','read_at'],
    select: `SELECT message_id, user_id, read_at FROM batbot_message_reads ORDER BY message_id, user_id`
  },
  {
    name: 'member_predictions',
    columns: ['id','user_id','home_team','away_team','home_probability','draw_probability','away_probability','prediction','coupon_code','bookmaker','comment','created_at'],
    select: `SELECT id, user_id, home_team, away_team, home_probability, draw_probability, away_probability, prediction, coupon_code, bookmaker, comment, created_at FROM member_predictions ORDER BY id`
  }
];

function normalize(row, table) {
  const copy = { ...row };
  if (['users','bookmakers','coupons'].includes(table)) copy.active = copy.active == null ? null : Boolean(copy.active);
  if (table === 'users') {
    copy.disabled = Boolean(copy.disabled);
    copy.must_change_password = Boolean(copy.must_change_password);
  }
  return copy;
}

async function main() {
  await client.connect();
  await client.query('BEGIN');
  try {
    await client.query(fs.readFileSync(schemaPath, 'utf8'));

    for (const table of tables) {
      const rows = sqlite.prepare(table.select).all();
      console.log(`${table.name}: ${rows.length} ligne(s)`);
      if (!rows.length) continue;

      const placeholders = table.columns.map((_, i) => `$${i + 1}`).join(', ');
      const columnsSql = table.columns.map((c) => `"${c}"`).join(', ');
      const conflict = table.name === 'settings'
        ? 'ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value'
        : 'ON CONFLICT DO NOTHING';
      const sql = `INSERT INTO "${table.name}" (${columnsSql}) VALUES (${placeholders}) ${conflict}`;
      const statement = { text: sql };

      for (const raw of rows) {
        const row = normalize(raw, table.name);
        await client.query({ ...statement, values: table.columns.map((column) => row[column]) });
      }
    }

    await client.query(`
      DO $$
      DECLARE r RECORD;
      BEGIN
        FOR r IN
          SELECT table_name, column_name
          FROM information_schema.columns
          WHERE table_schema='public'
            AND column_name='id'
            AND data_type IN ('bigint','integer')
            AND table_name IN ('users','daily_matches','password_resets','analysis_requests','payment_requests','bookmakers','coupons','batbot_messages','member_predictions')
        LOOP
          EXECUTE format('CREATE SEQUENCE IF NOT EXISTS %I_id_seq', r.table_name);
          EXECUTE format('SELECT setval(%L, COALESCE((SELECT MAX(id) FROM %I), 1), true)', r.table_name || '_id_seq', r.table_name);
        END LOOP;
      END LOOP;
    `);

    await client.query('COMMIT');
    console.log('Migration SQLite → PostgreSQL terminée sans supprimer la base SQLite.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
    sqlite.close();
  }
}

main().catch((error) => {
  console.error('MIGRATION FAILED:', error.stack || error.message);
  process.exit(1);
});
