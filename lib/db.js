import { sql } from "@vercel/postgres";

export { sql };

export async function migrate() {
  await sql`CREATE TABLE IF NOT EXISTS snapshots(
    id serial PRIMARY KEY,
    window_start timestamptz NOT NULL UNIQUE,
    offset_minutes int NOT NULL,
    taken_at timestamptz,
    merkle_root text,
    holder_count int,
    total_tickets int,
    status text NOT NULL DEFAULT 'pending'
  )`;
  await sql`CREATE TABLE IF NOT EXISTS snapshot_entries(
    snapshot_id int NOT NULL REFERENCES snapshots(id),
    wallet text NOT NULL,
    balance_raw numeric NOT NULL,
    tickets int NOT NULL,
    PRIMARY KEY (snapshot_id, wallet)
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_entries_wallet ON snapshot_entries(wallet)`;
  await sql`CREATE TABLE IF NOT EXISTS exclusions(
    wallet text PRIMARY KEY,
    label text
  )`;
  await sql`CREATE TABLE IF NOT EXISTS draws(
    id serial PRIMARY KEY,
    scheduled_at timestamptz NOT NULL,
    prize_title text NOT NULL,
    n_winners int NOT NULL DEFAULT 1,
    drand_round bigint,
    snapshot_id int REFERENCES snapshots(id),
    seed text,
    next_index int NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'scheduled'  -- scheduled|committed|drawn
  )`;
  await sql`CREATE TABLE IF NOT EXISTS free_entries(
    id serial PRIMARY KEY,
    draw_id int NOT NULL REFERENCES draws(id),
    wallet text NOT NULL,
    handle text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (draw_id, wallet)
  )`;
  await sql`CREATE TABLE IF NOT EXISTS codes(
    id serial PRIMARY KEY,
    draw_id int REFERENCES draws(id),          -- NULL = global mystery pool
    game_title text,                           -- NULL = mystery key
    code_encrypted text NOT NULL,
    status text NOT NULL DEFAULT 'available'  -- available|assigned|claimed|void
  )`;
  await sql`ALTER TABLE codes ALTER COLUMN game_title DROP NOT NULL`;
  await sql`CREATE TABLE IF NOT EXISTS winners(
    id serial PRIMARY KEY,
    draw_id int NOT NULL REFERENCES draws(id),
    pool_identity text NOT NULL,
    wallet text NOT NULL,
    sel_index int NOT NULL,
    code_id int REFERENCES codes(id),
    assigned_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    claimed_at timestamptz,
    status text NOT NULL DEFAULT 'assigned'  -- assigned|claimed|expired
  )`;
  await sql`ALTER TABLE draws ADD COLUMN IF NOT EXISTS pool_holders int`;
  await sql`ALTER TABLE draws ADD COLUMN IF NOT EXISTS pool_tickets int`;
  await sql`ALTER TABLE draws ADD COLUMN IF NOT EXISTS pool_free int`;
  await sql`ALTER TABLE draws ADD COLUMN IF NOT EXISTS announced_at timestamptz`;
  await sql`CREATE TABLE IF NOT EXISTS claim_nonces(
    nonce text PRIMARY KEY,
    wallet text NOT NULL,
    draw_id int NOT NULL,
    expires_at timestamptz NOT NULL,
    used boolean NOT NULL DEFAULT false
  )`;
}

export async function getOrCreateWindow(winStart, makeOffset) {
  const existing =
    await sql`SELECT * FROM snapshots WHERE window_start = ${winStart.toISOString()}`;
  if (existing.rows.length) return existing.rows[0];
  const offset = makeOffset();
  const ins = await sql`
    INSERT INTO snapshots(window_start, offset_minutes)
    VALUES (${winStart.toISOString()}, ${offset})
    ON CONFLICT (window_start) DO NOTHING
    RETURNING *`;
  if (ins.rows.length) return ins.rows[0];
  const again =
    await sql`SELECT * FROM snapshots WHERE window_start = ${winStart.toISOString()}`;
  return again.rows[0];
}

export async function saveSnapshot(id, entries, summary) {
  // batch insert entries in chunks
  const CH = 500;
  for (let i = 0; i < entries.length; i += CH) {
    const chunk = entries.slice(i, i + CH);
    const values = [];
    const params = [];
    chunk.forEach((e, j) => {
      const b = j * 4;
      values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4})`);
      params.push(id, e.wallet, e.balanceRaw.toString(), e.tickets);
    });
    await sql.query(
      `INSERT INTO snapshot_entries(snapshot_id, wallet, balance_raw, tickets)
       VALUES ${values.join(",")} ON CONFLICT DO NOTHING`,
      params
    );
  }
  await sql`
    UPDATE snapshots SET
      taken_at = now(),
      merkle_root = ${summary.merkleRoot},
      holder_count = ${summary.holderCount},
      total_tickets = ${summary.totalTickets},
      status = 'taken'
    WHERE id = ${id}`;
}

export async function getExclusions() {
  const r = await sql`SELECT wallet FROM exclusions`;
  return new Set(r.rows.map((x) => x.wallet));
}

export async function lastTakenSnapshots(k, sinceIso = null) {
  const r = sinceIso
    ? await sql`SELECT id, window_start, taken_at, merkle_root, holder_count, total_tickets
                FROM snapshots WHERE status='taken' AND taken_at >= ${sinceIso}
                ORDER BY window_start DESC LIMIT ${k}`
    : await sql`SELECT id, window_start, taken_at, merkle_root, holder_count, total_tickets
                FROM snapshots WHERE status='taken'
                ORDER BY window_start DESC LIMIT ${k}`;
  return r.rows;
}

export async function walletInSnapshots(wallet, snapshotIds) {
  if (!snapshotIds.length) return [];
  const r = await sql.query(
    `SELECT snapshot_id, balance_raw, tickets FROM snapshot_entries
     WHERE wallet = $1 AND snapshot_id = ANY($2::int[])`,
    [wallet, snapshotIds]
  );
  return r.rows;
}
