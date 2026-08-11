// ============================================================================
// DROPRATE — Gacha schema (ADDITIVE ONLY)
//
// migrateGacha() CREATEs new tables and NEVER alters the raffle's tables. It is
// called by the gacha admin/api routes, not by the raffle cron, so the live
// raffle schema and code paths are completely untouched.
// ============================================================================

import { sql } from "./db.js";

export async function migrateGacha() {
  // Inventory of encrypted keys, bucketed by rarity.
  await sql`CREATE TABLE IF NOT EXISTS crate_keys(
    id serial PRIMARY KEY,
    rarity text NOT NULL,                         -- common|rare|epic|legendary
    game_title text,
    appid int,
    image text,
    msrp_cents int,
    cost_cents int,                                -- OPTIONAL: what you paid (private); null = untracked
    code_encrypted text NOT NULL,
    status text NOT NULL DEFAULT 'available',      -- available|sealed|revealed|sold_back|void
    loaded_at timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`ALTER TABLE crate_keys ALTER COLUMN cost_cents DROP NOT NULL`; // for pre-existing tables
  await sql`CREATE INDEX IF NOT EXISTS idx_cratekeys_bucket ON crate_keys(rarity, status)`;

  // Pull records (reveal-gate state machine mirrors lib/gacha.js).
  await sql`CREATE TABLE IF NOT EXISTS pulls(
    id serial PRIMARY KEY,
    owner text NOT NULL,
    crate text NOT NULL,                           -- which crate tier was opened
    rarity text NOT NULL,                          -- resulting rarity
    key_id int REFERENCES crate_keys(id),
    paid_raw numeric NOT NULL,                      -- $DROP base units paid
    reference text,                                  -- Solana-Pay correlation id
    amount_quoted_raw numeric,                       -- locked quote amount
    quote_expires_at timestamptz,
    paid_sig text,                                   -- on-chain payment signature
    paid boolean NOT NULL DEFAULT false,
    drand_round bigint,                             -- committed future round (the commitment)
    seed text,                                       -- drand randomness once resolved
    nonce text,                                      -- per-pull nonce fixed at open
    state text NOT NULL DEFAULT 'awaiting_payment',  -- awaiting_payment|committing|sealed|kept|revealed|sold_back|owed
    listed boolean NOT NULL DEFAULT false,
    refund_raw numeric,
    misses_since_floor int NOT NULL DEFAULT 0,
    decision_deadline timestamptz,                   -- sell-back allowed until here (research window)
    created_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_pulls_owner ON pulls(owner, state)`;
  // HARD GUARANTEE: a given key can back at most ONE pull, ever. Even if two
  // concurrent resolves somehow tried to claim the same key, Postgres rejects
  // the second write. This is the backstop behind the atomic claim in api/crate.js.
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uniq_pulls_key_id ON pulls(key_id) WHERE key_id IS NOT NULL`;

  // Per-owner pity counters, keyed by crate tier.
  await sql`CREATE TABLE IF NOT EXISTS pity(
    owner text NOT NULL,
    crate text NOT NULL,
    misses int NOT NULL DEFAULT 0,
    PRIMARY KEY (owner, crate)
  )`;

  // Replay guard: an on-chain payment signature can back at most one pull.
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uniq_pulls_paid_sig ON pulls(paid_sig) WHERE paid_sig IS NOT NULL`;

  // Money ledger: every burn / treasury credit / refund is a row a signer worker
  // executes on-chain and marks sent. Fully auditable, and idempotent by pull+type.
  await sql`CREATE TABLE IF NOT EXISTS settlements(
    id serial PRIMARY KEY,
    pull_id int REFERENCES pulls(id),
    type text NOT NULL,                              -- burn|treasury|refund
    amount_raw numeric NOT NULL,
    status text NOT NULL DEFAULT 'pending',          -- pending|sent|failed
    sig text,
    created_at timestamptz NOT NULL DEFAULT now(),
    sent_at timestamptz
  )`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uniq_settlement_pull_type ON settlements(pull_id, type)`;
}

// Stock snapshot: how many available keys sit in each bucket.
export async function bucketCounts() {
  const r = await sql`
    SELECT rarity, count(*)::int AS n
    FROM crate_keys WHERE status = 'available'
    GROUP BY rarity`;
  const out = { common: 0, rare: 0, epic: 0, legendary: 0 };
  for (const row of r.rows) out[row.rarity] = row.n;
  return out;
}
