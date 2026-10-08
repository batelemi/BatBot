-- BatBot Phase 2 — PostgreSQL schema
-- This schema mirrors the current SQLite application data model.
-- It is intentionally separate from the live SQLite database during Phase 2.

CREATE TABLE IF NOT EXISTS users (
  id BIGINT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  premium_until TIMESTAMPTZ,
  premium_started_at TIMESTAMPTZ,
  ai_until TIMESTAMPTZ,
  ai_started_at TIMESTAMPTZ,
  disabled BOOLEAN NOT NULL DEFAULT FALSE,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  temporary_password_hash TEXT,
  temporary_password_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS daily_matches (
  id BIGINT PRIMARY KEY,
  match_name TEXT NOT NULL,
  home_probability DOUBLE PRECISION NOT NULL,
  draw_probability DOUBLE PRECISION NOT NULL,
  away_probability DOUBLE PRECISION NOT NULL,
  recommended_pick TEXT NOT NULL,
  odds DOUBLE PRECISION,
  match_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS password_resets (
  id BIGINT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  delivery_token TEXT,
  temporary_password_encrypted TEXT,
  temporary_password_expires_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS analysis_requests (
  id BIGINT PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_requests (
  id BIGINT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  offer TEXT NOT NULL,
  operator TEXT NOT NULL,
  amount INTEGER NOT NULL,
  reference TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  admin_note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS bookmakers (
  id BIGINT PRIMARY KEY,
  name TEXT NOT NULL,
  bonus TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS coupons (
  id BIGINT PRIMARY KEY,
  platform_name TEXT NOT NULL,
  code TEXT NOT NULL,
  platform_url TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS batbot_messages (
  id BIGINT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS batbot_message_reads (
  message_id BIGINT NOT NULL REFERENCES batbot_messages(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS member_predictions (
  id BIGINT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  home_probability DOUBLE PRECISION NOT NULL,
  draw_probability DOUBLE PRECISION NOT NULL,
  away_probability DOUBLE PRECISION NOT NULL,
  prediction TEXT NOT NULL,
  coupon_code TEXT NOT NULL DEFAULT '',
  bookmaker TEXT NOT NULL DEFAULT '',
  comment TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_daily_matches_date ON daily_matches(match_date, id DESC);
CREATE INDEX IF NOT EXISTS idx_password_resets_user_status ON password_resets(user_id, status, id DESC);
CREATE INDEX IF NOT EXISTS idx_password_resets_token ON password_resets(delivery_token);
CREATE INDEX IF NOT EXISTS idx_analysis_requests_user_created ON analysis_requests(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_requests_user_created ON payment_requests(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_requests_status_created ON payment_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_batbot_messages_expires ON batbot_messages(expires_at, id DESC);
CREATE INDEX IF NOT EXISTS idx_batbot_message_reads_user ON batbot_message_reads(user_id, message_id);
CREATE INDEX IF NOT EXISTS idx_member_predictions_user_created ON member_predictions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_member_predictions_created ON member_predictions(created_at DESC);

-- PostgreSQL-generated IDs for application inserts.
-- These sequences preserve explicit IDs during migration while allowing
-- future inserts to omit the id column and use nextval() automatically.

CREATE SEQUENCE IF NOT EXISTS users_id_seq OWNED BY users.id;
ALTER TABLE users ALTER COLUMN id SET DEFAULT nextval('users_id_seq'::regclass);

CREATE SEQUENCE IF NOT EXISTS daily_matches_id_seq OWNED BY daily_matches.id;
ALTER TABLE daily_matches ALTER COLUMN id SET DEFAULT nextval('daily_matches_id_seq'::regclass);

CREATE SEQUENCE IF NOT EXISTS password_resets_id_seq OWNED BY password_resets.id;
ALTER TABLE password_resets ALTER COLUMN id SET DEFAULT nextval('password_resets_id_seq'::regclass);

CREATE SEQUENCE IF NOT EXISTS analysis_requests_id_seq OWNED BY analysis_requests.id;
ALTER TABLE analysis_requests ALTER COLUMN id SET DEFAULT nextval('analysis_requests_id_seq'::regclass);

CREATE SEQUENCE IF NOT EXISTS payment_requests_id_seq OWNED BY payment_requests.id;
ALTER TABLE payment_requests ALTER COLUMN id SET DEFAULT nextval('payment_requests_id_seq'::regclass);

CREATE SEQUENCE IF NOT EXISTS bookmakers_id_seq OWNED BY bookmakers.id;
ALTER TABLE bookmakers ALTER COLUMN id SET DEFAULT nextval('bookmakers_id_seq'::regclass);

CREATE SEQUENCE IF NOT EXISTS coupons_id_seq OWNED BY coupons.id;
ALTER TABLE coupons ALTER COLUMN id SET DEFAULT nextval('coupons_id_seq'::regclass);

CREATE SEQUENCE IF NOT EXISTS batbot_messages_id_seq OWNED BY batbot_messages.id;
ALTER TABLE batbot_messages ALTER COLUMN id SET DEFAULT nextval('batbot_messages_id_seq'::regclass);

CREATE SEQUENCE IF NOT EXISTS member_predictions_id_seq OWNED BY member_predictions.id;
ALTER TABLE member_predictions ALTER COLUMN id SET DEFAULT nextval('member_predictions_id_seq'::regclass);
