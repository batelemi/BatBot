const { Pool } = require('pg');
const PgSession = require('connect-pg-simple')(require('express-session'));

function createPostgresSessionStore() {
  const connectionString = String(process.env.DATABASE_URL || '').trim();
  if (!connectionString) return null;

  const max = Math.max(2, Math.min(50, Number(process.env.DATABASE_POOL_SIZE || 10)));
  const pool = new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined
  });

  pool.on('error', (error) => {
    console.error('POSTGRES SESSION POOL:', error.message);
  });

  const store = new PgSession({
    pool,
    tableName: process.env.PG_SESSION_TABLE || 'user_sessions',
    createTableIfMissing: true,
    pruneSessionInterval: 60 * 60
  });

  return { pool, store };
}

module.exports = { createPostgresSessionStore };
