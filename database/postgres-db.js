const { Pool } = require("pg");

const connectionString = String(process.env.DATABASE_URL || "").trim();

if (!connectionString) {
  throw new Error("DATABASE_URL est obligatoire pour la base PostgreSQL métier.");
}

const max = Math.max(
  2,
  Math.min(50, Number(process.env.DATABASE_POOL_SIZE || 10))
);

const pool = new Pool({
  connectionString,
  max,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl: process.env.PGSSL === "require"
    ? { rejectUnauthorized: false }
    : undefined
});

pool.on("error", (error) => {
  console.error("POSTGRES DB POOL:", error.message);
});

async function query(text, params = []) {
  return pool.query(text, params);
}

async function get(text, params = []) {
  const result = await pool.query(text, params);
  return result.rows[0] || null;
}

async function all(text, params = []) {
  const result = await pool.query(text, params);
  return result.rows;
}

module.exports = {
  pool,
  query,
  get,
  all
};
