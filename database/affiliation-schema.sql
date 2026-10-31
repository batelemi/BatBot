-- BATBOT : schema local du programme d'affiliation.
-- Ne pas appliquer en production sans validation complete.

CREATE TABLE IF NOT EXISTS affiliate_profiles (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  referral_code TEXT NOT NULL UNIQUE,
  referred_by_user_id BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  qualification_window_started_at TIMESTAMPTZ,
  renewal_eligible_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (referred_by_user_id IS NULL OR referred_by_user_id <> user_id)
);

CREATE INDEX IF NOT EXISTS idx_affiliate_profiles_referrer
  ON affiliate_profiles(referred_by_user_id);

-- Conservation des anciens liens de parrainage.
CREATE TABLE IF NOT EXISTS affiliate_referral_code_aliases (
  referral_code TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_affiliate_referral_code_aliases_user
  ON affiliate_referral_code_aliases(user_id);

-- Unicité des anciens codes sans distinction de casse ni espaces.
CREATE UNIQUE INDEX IF NOT EXISTS idx_affiliate_referral_code_aliases_normalized
  ON affiliate_referral_code_aliases (UPPER(BTRIM(referral_code)));


CREATE TABLE IF NOT EXISTS affiliate_payment_events (
  id BIGSERIAL PRIMARY KEY,
  payment_request_id BIGINT NOT NULL UNIQUE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  offer TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount IN (1000, 2000, 3000)),
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_affiliate_payment_events_user
  ON affiliate_payment_events(user_id, confirmed_at);

CREATE TABLE IF NOT EXISTS affiliate_commissions (
  id BIGSERIAL PRIMARY KEY,
  affiliate_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  referred_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  payment_event_id BIGINT NOT NULL
    REFERENCES affiliate_payment_events(id) ON DELETE RESTRICT,
  commission_type TEXT NOT NULL
    CHECK (commission_type IN ('first_purchase_20', 'renewal_10')),
  offer TEXT NOT NULL,
  payment_amount INTEGER NOT NULL CHECK (payment_amount > 0),
  commission_rate NUMERIC(5,4) NOT NULL
    CHECK (commission_rate IN (0.20, 0.10)),
  commission_amount INTEGER NOT NULL CHECK (commission_amount > 0),
  status TEXT NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'reserved', 'paid', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at TIMESTAMPTZ,
  CHECK (
    (commission_type = 'first_purchase_20' AND commission_rate = 0.20)
    OR
    (commission_type = 'renewal_10' AND commission_rate = 0.10)
  ),
  UNIQUE (payment_event_id, commission_type)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_affiliate_first_commission_per_user
  ON affiliate_commissions(referred_user_id)
  WHERE commission_type = 'first_purchase_20';

CREATE INDEX IF NOT EXISTS idx_affiliate_commissions_balance
  ON affiliate_commissions(affiliate_user_id, commission_type, status);

CREATE TABLE IF NOT EXISTS affiliate_withdrawals (
  id BIGSERIAL PRIMARY KEY,
  affiliate_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  commission_type TEXT NOT NULL
    CHECK (commission_type IN ('first_purchase_20', 'renewal_10')),
  amount INTEGER NOT NULL CHECK (amount >= 3000),
  payment_method TEXT NOT NULL
    CHECK (payment_method IN ('Wave', 'Orange Money', 'MTN Money', 'Moov Money')),
  payment_number TEXT NOT NULL,
  batbot_account_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verifying', 'approved', 'paid', 'rejected')),
  admin_note TEXT NOT NULL DEFAULT '',
  payment_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS affiliate_withdrawal_commissions (
  withdrawal_id BIGINT NOT NULL
    REFERENCES affiliate_withdrawals(id) ON DELETE RESTRICT,
  commission_id BIGINT NOT NULL
    REFERENCES affiliate_commissions(id) ON DELETE RESTRICT,
  amount INTEGER NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    released_at TIMESTAMPTZ,
  PRIMARY KEY (withdrawal_id, commission_id)
);

-- Une commission ne peut appartenir qu'à un seul retrait actif.
CREATE UNIQUE INDEX IF NOT EXISTS uq_affiliate_commission_active_withdrawal
  ON affiliate_withdrawal_commissions(commission_id)
  WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_affiliate_withdrawals_admin
  ON affiliate_withdrawals(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_affiliate_withdrawals_user
  ON affiliate_withdrawals(affiliate_user_id, created_at DESC);
