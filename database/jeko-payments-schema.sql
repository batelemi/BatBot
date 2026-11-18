-- BATBOT PRO : circuit indépendant des paiements Jeko.
-- Ne modifie ni payment_requests ni les tables affiliate_*.

CREATE TABLE IF NOT EXISTS jeko_payments (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL
        REFERENCES users(id) ON DELETE RESTRICT,

    offer TEXT NOT NULL
        CHECK (offer IN (
            'Premium 7 jours',
            'Premium 14 jours',
            'Premium 21 jours'
        )),

    amount_xof INTEGER NOT NULL
        CHECK (amount_xof IN (1000, 2000, 3000)),

    amount_cents INTEGER NOT NULL
        CHECK (amount_cents IN (100000, 200000, 300000)),

    currency TEXT NOT NULL DEFAULT 'XOF'
        CHECK (currency = 'XOF'),

    payment_method TEXT NOT NULL
        CHECK (payment_method IN (
            'orange', 'wave', 'mtn', 'moov', 'djamo'
        )),

    reference TEXT NOT NULL UNIQUE,
    jeko_payment_id TEXT UNIQUE,
    jeko_transaction_id TEXT UNIQUE,
    store_id TEXT NOT NULL,
    redirect_url TEXT,

    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN (
            'pending', 'paid', 'failed', 'cancelled', 'expired'
        )),

    provider_status TEXT,
    status_check_after TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    paid_at TIMESTAMPTZ,

    CHECK (
        (offer = 'Premium 7 jours' AND amount_xof = 1000 AND amount_cents = 100000)
        OR
        (offer = 'Premium 14 jours' AND amount_xof = 2000 AND amount_cents = 200000)
        OR
        (offer = 'Premium 21 jours' AND amount_xof = 3000 AND amount_cents = 300000)
    )
);

ALTER TABLE jeko_payments
    ADD COLUMN IF NOT EXISTS status_check_after TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_jeko_payments_user
    ON jeko_payments(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_jeko_payments_status
    ON jeko_payments(status, created_at DESC);

-- Limitation des créations de paiements Jèko par utilisateur.
CREATE TABLE IF NOT EXISTS jeko_creation_rate_limits (
    user_id BIGINT PRIMARY KEY
        REFERENCES users(id) ON DELETE CASCADE,
    window_started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    request_count INTEGER NOT NULL DEFAULT 1
        CHECK (request_count BETWEEN 1 AND 3),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS jeko_webhook_events (
    event_key TEXT PRIMARY KEY,
    payment_id BIGINT NOT NULL
        REFERENCES jeko_payments(id) ON DELETE RESTRICT,
    event_type TEXT NOT NULL,
    payload_sha256 CHAR(64) NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_jeko_webhook_events_payment
    ON jeko_webhook_events(payment_id, received_at DESC);
