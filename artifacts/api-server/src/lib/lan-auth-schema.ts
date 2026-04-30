import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { pool } from "@workspace/db";

import { logger } from "./logger";

/**
 * Idempotent full-schema bootstrap for the LAN api-server.
 *
 * Called once on every boot. Creates *every* table the internal route
 * surface reads or writes — operator accounts, sessions, audit log,
 * wings/bases (multi-tier RBAC), domain tables (pilots, sorties,
 * squadrons, currencies, leaves, unavailable, schedule, alerts,
 * notams, saved_duty_weeks).
 *
 * Every statement is `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` /
 * `ON CONFLICT DO NOTHING` so it is safe to call against:
 *   - an empty Postgres database (fresh install on a new host PC), or
 *   - a database from a previous Hawk Eye build (existing install).
 *
 * The exported name is kept as `ensureLanAuthSchema` for back-compat
 * with `index.ts` callers; `ensureFullSchema` is the new alias new
 * code should use.
 */
export async function ensureFullSchema(): Promise<void> {
  // ── Operator accounts ───────────────────────────────────────────────
  await pool.query(`
    create table if not exists lan_users (
      id text primary key,
      username text not null,
      display_name text not null default '',
      role text not null,
      squadron_id text,
      password_hash text not null,
      created_at timestamptz not null default now()
    );
    create unique index if not exists lan_users_username_lower_idx
      on lan_users (lower(username));
  `);
  // Multi-tier scope columns: nullable so existing single-squadron
  // installs keep working unchanged; only commander_wing /
  // commander_base rows use them.
  await pool.query(`
    alter table lan_users add column if not exists wing_id text;
    alter table lan_users add column if not exists base_id text;
    alter table lan_users add column if not exists disabled_at timestamptz;
  `);

  // ── Session tokens ──────────────────────────────────────────────────
  await pool.query(`
    create table if not exists lan_sessions (
      id text primary key,
      user_id text not null references lan_users (id) on delete cascade,
      token text not null,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null
    );
    create unique index if not exists lan_sessions_token_idx on lan_sessions (token);
  `);

  // ── Audit log ───────────────────────────────────────────────────────
  // Audit rows are append-only and we never delete history, so the
  // table grows for the life of the install. The composite index on
  // (occurred_at desc, type) keeps the most-common dashboard query
  // — "give me the last N rows, optionally filtered by type" — fast
  // even after a decade of writes (>10M rows). Postgres autovacuum
  // is on by default and is the only maintenance this table needs.
  await pool.query(`
    create table if not exists audit_log (
      id bigserial primary key,
      occurred_at timestamptz not null default now(),
      actor text,
      type text not null,
      detail jsonb
    );
    create index if not exists audit_log_occurred_at_idx
      on audit_log (occurred_at desc);
    create index if not exists audit_log_actor_idx on audit_log (actor);
    create index if not exists audit_log_occurred_at_type_idx
      on audit_log (occurred_at desc, type);
  `);

  // ── System-health marker ────────────────────────────────────────────
  // Cross-process state shared between the api-server (which reads it
  // for the System Health admin page) and the LAN-host PowerShell
  // helpers (verify-backup.ps1 writes a `last_backup_verify` row when
  // the quarterly self-restore-test passes). Single-row-per-key shape
  // keeps the surface trivial to reason about; never grows unbounded.
  await pool.query(`
    create table if not exists system_health_marker (
      key text primary key,
      ok boolean not null,
      message text,
      observed_at timestamptz not null default now(),
      detail jsonb
    );
  `);

  // ── Wings & bases (multi-tier RBAC) ─────────────────────────────────
  await pool.query(`
    create table if not exists wings (
      id text primary key,
      name text not null,
      created_at timestamptz not null default now()
    );
    create table if not exists bases (
      id text primary key,
      name text not null,
      wing_id text references wings (id) on delete set null,
      created_at timestamptz not null default now()
    );
  `);

  // ── Squadrons ──────────────────────────────────────────────────────
  // The Setup Wizard / migration 0039 schema the dashboard expects is
  // (id, number, name, base, wing, default_aircraft, default_monthly_targets).
  // We additionally carry `wing_id` / `base_id` UUID-style refs into the
  // multi-tier `wings` / `bases` tables, used by the new commander_wing /
  // commander_base RBAC. Both shapes coexist: legacy text columns
  // (`base`, `wing`) remain the source of truth for display + setup
  // wizard JSON, while `wing_id` / `base_id` drive scope authorisation.
  await pool.query(`
    create table if not exists squadrons (
      id uuid primary key default gen_random_uuid(),
      number text not null,
      name text,
      base text,
      wing text,
      default_aircraft jsonb,
      default_monthly_targets jsonb,
      wing_id text references wings (id) on delete set null,
      base_id text references bases (id) on delete set null,
      created_at timestamptz not null default now()
    );
    create unique index if not exists squadrons_number_idx on squadrons (number);
  `);
  // Idempotent column adds for upgraded installs whose squadrons table
  // pre-dated one of the columns above.
  await pool.query(`
    alter table squadrons add column if not exists base text;
    alter table squadrons add column if not exists wing text;
    alter table squadrons add column if not exists default_aircraft jsonb;
    alter table squadrons add column if not exists default_monthly_targets jsonb;
    alter table squadrons add column if not exists wing_id text references wings (id) on delete set null;
    alter table squadrons add column if not exists base_id text references bases (id) on delete set null;
  `);

  // ── Pilots ──────────────────────────────────────────────────────────
  await pool.query(`
    create table if not exists pilots (
      id text primary key,
      squadron_id uuid references squadrons (id) on delete set null,
      rank text,
      rank_en text,
      name text,
      arabic_name text,
      unit text,
      phone text,
      available boolean not null default true,
      data jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create index if not exists pilots_squadron_idx on pilots (squadron_id);
  `);

  // ── Sorties ─────────────────────────────────────────────────────────
  await pool.query(`
    create table if not exists sorties (
      id uuid primary key default gen_random_uuid(),
      squadron_id uuid references squadrons (id) on delete set null,
      pilot_id text references pilots (id) on delete cascade,
      co_pilot_id text references pilots (id) on delete set null,
      date date not null,
      ac_type text,
      ac_number text,
      sortie_type text,
      sortie_name text,
      data jsonb,
      created_by text,
      created_at timestamptz not null default now()
    );
    create index if not exists sorties_pilot_idx on sorties (pilot_id);
    create index if not exists sorties_date_idx on sorties (date desc);
    create index if not exists sorties_squadron_idx on sorties (squadron_id);
  `);

  // ── Currencies ──────────────────────────────────────────────────────
  await pool.query(`
    create table if not exists currencies (
      id uuid primary key default gen_random_uuid(),
      pilot_id text references pilots (id) on delete cascade,
      squadron_id uuid references squadrons (id) on delete set null,
      key text not null,
      expiry_date date,
      data jsonb,
      updated_at timestamptz not null default now()
    );
    create index if not exists currencies_pilot_idx on currencies (pilot_id);
  `);

  // ── Leaves (annual leave allotments) ────────────────────────────────
  // Schema matches GET /api/internal/leaves in ops-read-lan.ts which
  // selects (pilot_id, year, months) filtered by year — i.e. one row
  // per pilot per year listing the months they're scheduled to be
  // away. squadron_id is kept (and added on legacy DBs) so that
  // pilots-transfer.ts can re-home leave rows on transfer.
  await pool.query(`
    create table if not exists leaves (
      id uuid primary key default gen_random_uuid(),
      pilot_id text references pilots (id) on delete cascade,
      squadron_id uuid references squadrons (id) on delete set null,
      year int,
      months jsonb,
      from_date date,
      to_date date,
      reason text,
      created_at timestamptz not null default now()
    );
    alter table leaves
      add column if not exists year int,
      add column if not exists months jsonb,
      add column if not exists squadron_id uuid;
    create index if not exists leaves_pilot_idx on leaves (pilot_id);
    create index if not exists leaves_year_idx on leaves (year);
  `);

  // ── Unavailable windows ─────────────────────────────────────────────
  // squadron_id is required because pilots-transfer.ts updates it
  // directly (not wrapped in runOptionalUpdate) when re-homing a
  // pilot, so an empty-DB bootstrap must include the column.
  await pool.query(`
    create table if not exists unavailable (
      id uuid primary key default gen_random_uuid(),
      pilot_id text references pilots (id) on delete cascade,
      squadron_id uuid references squadrons (id) on delete set null,
      from_date date not null,
      to_date date not null,
      reason text,
      created_at timestamptz not null default now()
    );
    alter table unavailable
      add column if not exists squadron_id uuid;
    create index if not exists unavailable_pilot_idx on unavailable (pilot_id);
    create index if not exists unavailable_dates_idx on unavailable (from_date, to_date);
  `);

  // ── Saved duty weeks (cached schedule snapshots) ────────────────────
  await pool.query(`
    create table if not exists saved_duty_weeks (
      squadron text not null,
      start_date date not null,
      rows jsonb not null,
      saved_at timestamptz not null default now(),
      primary key (squadron, start_date)
    );
  `);

  // ── Duty week (rolling 7-day duty roster) ───────────────────────────
  // GET /api/internal/duty-week reads (day, main_duty, standby, rcm)
  // ordered by effective_from desc limit 7. The table holds one row
  // per duty day; effective_from is the publication timestamp so the
  // most recent revision wins.
  await pool.query(`
    create table if not exists duty_week (
      id uuid primary key default gen_random_uuid(),
      day date,
      main_duty text,
      standby text,
      rcm text,
      effective_from timestamptz not null default now()
    );
    create index if not exists duty_week_effective_from_idx
      on duty_week (effective_from desc);
  `);

  // ── Daily schedule (read-only here; populated by ops UI) ────────────
  await pool.query(`
    create table if not exists schedule (
      id uuid primary key default gen_random_uuid(),
      flight_date date not null,
      takeoff time,
      data jsonb,
      created_at timestamptz not null default now()
    );
    create index if not exists schedule_flight_date_idx on schedule (flight_date);
  `);

  // ── Ops-board surfaces: alerts + NOTAMs ─────────────────────────────
  await pool.query(`
    create table if not exists alerts (
      id uuid primary key default gen_random_uuid(),
      posted_at timestamptz not null default now(),
      body text not null,
      author text,
      priority text
    );
    create index if not exists alerts_posted_at_idx on alerts (posted_at desc);
  `);
  await pool.query(`
    create table if not exists notams (
      id uuid primary key default gen_random_uuid(),
      notam_no text not null,
      posted_on date not null,
      body text not null,
      priority text,
      created_at timestamptz not null default now()
    );
    create index if not exists notams_posted_on_idx on notams (posted_on desc);
  `);

  // ── LAN pairing (Task T-R) ──────────────────────────────────────────
  // Persistent X25519 keypair this PC presents to peers when asking
  // them to pair (see `lib/lan-pairing-crypto.ts`). Single-row table
  // pinned by id=1 so re-bootstrapping the schema never spawns a new
  // identity; a fresh keypair only appears via the explicit
  // `resetLocalPairingKeypair()` helper. Private key is stored at
  // rest in plain hex — DB filesystem access already implies machine
  // compromise, and the key is only useful in tandem with a
  // simultaneously-mounted listening api-server on the LAN.
  await pool.query(`
    create table if not exists lan_pairing_keypair (
      id smallint primary key default 1,
      public_key text not null,
      private_key text not null,
      created_at timestamptz not null default now()
    );
    alter table lan_pairing_keypair
      add column if not exists sign_pub_key text;
    alter table lan_pairing_keypair
      add column if not exists sign_priv_key text;
  `);

  // Inbound pairing requests received by *this* PC (typically a Hub
  // super_admin's PC). When a remote aggregator/viewer POSTs to
  // `/api/internal/lan-pairing/inbound-request` we persist the request
  // so it survives a Hub restart and shows up in the super_admin's
  // pairing inbox. Approve/Deny flips `status`; once approved we
  // generate a peer token, encrypt it with `requester_pub_key`, POST
  // back to `requester_callback_url`, and log the resulting token id
  // here so the operator can revoke it later via the Peer Tokens
  // page.
  //
  // Status values:
  //   pending   — awaiting super_admin action
  //   approved  — token issued + delivered (or queued for delivery)
  //   denied    — super_admin clicked Deny
  //   cancelled — requester withdrew before approval
  //   delivered — approval payload was successfully POSTed to requester
  //   delivery_failed — delivery POST failed; surfaces in the UI for retry
  await pool.query(`
    create table if not exists lan_pairing_inbound_requests (
      id text primary key,
      requester_role text not null,
      requester_hostname text not null,
      requester_address text not null,
      requester_pub_key text not null,
      requester_callback_url text not null,
      requester_squadron text,
      requester_wing text,
      requester_base text,
      requester_app_version text,
      status text not null default 'pending',
      issued_token_id text,
      approval_error text,
      created_at timestamptz not null default now(),
      decided_at timestamptz,
      decided_by text,
      delivered_at timestamptz
    );
    create index if not exists lan_pairing_inbound_status_idx
      on lan_pairing_inbound_requests (status, created_at desc);
    create unique index if not exists lan_pairing_inbound_dedupe_idx
      on lan_pairing_inbound_requests (
        requester_hostname, requester_address, status
      ) where status = 'pending';
    alter table lan_pairing_inbound_requests
      add column if not exists requester_sign_pub_key text;
  `);

  // Outbound pairing requests this PC has sent to a remote Hub. We
  // persist them so a freshly-rebooted aggregator/viewer can find out
  // whether its earlier request was approved without re-prompting the
  // operator. Status values mirror the inbound table; `received_token`
  // is non-null only after the Hub's approval payload was decrypted
  // and the token stashed in the local peer-token-client config.
  await pool.query(`
    create table if not exists lan_pairing_outbound_requests (
      id text primary key,
      hub_hostname text not null,
      hub_address text not null,
      hub_port integer,
      status text not null default 'pending',
      received_token_id text,
      received_token_label text,
      paired_peer_squadron_id text,
      error_detail text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    alter table lan_pairing_outbound_requests
      add column if not exists hub_port integer;
    alter table lan_pairing_outbound_requests
      add column if not exists paired_peer_squadron_id text;
    create index if not exists lan_pairing_outbound_status_idx
      on lan_pairing_outbound_requests (status, created_at desc);
  `);

  // peer_squadrons / peer_cache — owned by aggregate-peers + peer-fanout.
  // Created here so the schema is whole on every PC; the relation is
  // tolerated as missing by the legacy code paths but its presence is
  // required for one-click pairing to actually wire the new peer into
  // the fanout list. Idempotent.
  await pool.query(`
    create table if not exists peer_squadrons (
      id uuid primary key default gen_random_uuid(),
      squadron_id text not null,
      squadron_name text,
      base_url text not null,
      token_hash text,
      added_at timestamptz not null default now(),
      added_by text,
      last_ok_at timestamptz,
      last_error text,
      last_error_at timestamptz,
      removed_at timestamptz,
      auth_token text
    );
    create unique index if not exists peer_squadrons_squadron_idx
      on peer_squadrons (squadron_id) where removed_at is null;
    create table if not exists peer_cache (
      peer_squadron_id uuid not null
        references peer_squadrons (id) on delete cascade,
      kind text not null,
      payload jsonb not null,
      fetched_at timestamptz not null default now(),
      primary key (peer_squadron_id, kind)
    );
    create index if not exists peer_cache_fetched_at_idx
      on peer_cache (fetched_at desc);
  `);
}

/**
 * Back-compat alias. `index.ts` and any external caller can keep using
 * the old name; new callers should prefer `ensureFullSchema`.
 */
export const ensureLanAuthSchema = ensureFullSchema;

// ── Legacy cleanup (Plan A, task #336) ──────────────────────────────────
//
// One-shot, idempotent removal of the cross-PC mesh, broken reminder
// scheduler, and pilot-mobile pairing tables. Each table is dumped to
// `legacy-export-<YYYY-MM-DD>.json` (under LAN_LEGACY_EXPORT_DIR or the
// process cwd) before being dropped, so an operator can recover any
// rows that may have lingered on a long-running install. Subsequent
// boots find the marker row in `schema_cleanup_marker` and short-circuit.
//
// The literal `xpc_*`, `hawk_reminder_*_local`, `pilot_devices`,
// `pilot_link_codes`, `pilot_reminder_prefs`, and
// `pilot_currency_notifications` table names below are intentional. The
// surfaces that read or wrote them are gone (deleted in #336), but a
// long-running install may still have the rows on disk; we MUST keep
// these names here so `ensureLegacyCleanup` can find, dump, and drop
// them on first boot after the upgrade. Do not remove entries unless
// every install in the field has already burnt the cleanup marker.

const LEGACY_TABLES = [
  "xpc_registry",
  "xpc_user_pcs",
  "xpc_messages",
  "xpc_pending",
  "xpc_pair_codes",
  "xpc_pair_links",
  "xpc_pair_audit",
  "xpc_squadron_snapshot",
  "xpc_schedule_shares",
  "hawk_reminder_schedule_local",
  "hawk_reminder_runs_local",
  "hawk_reminder_http_local",
  "pilot_devices",
  "pilot_link_codes",
  "pilot_reminder_prefs",
  "pilot_currency_notifications",
] as const;

const CLEANUP_MARKER_KEY = "task_336_plan_a";

export async function ensureLegacyCleanup(): Promise<void> {
  await pool.query(`
    create table if not exists schema_cleanup_marker (
      key text primary key,
      ran_at timestamptz not null default now(),
      detail jsonb
    );
  `);

  const existing = await pool.query<{ key: string }>(
    `select key from schema_cleanup_marker where key = $1`,
    [CLEANUP_MARKER_KEY],
  );
  if ((existing.rowCount ?? 0) > 0) return;

  const today = new Date().toISOString().slice(0, 10);
  const exportDir = process.env["LAN_LEGACY_EXPORT_DIR"] ?? process.cwd();
  const exportPath = join(exportDir, `legacy-export-${today}.json`);

  const dump: Record<string, unknown[]> = {};
  for (const table of LEGACY_TABLES) {
    const present = await pool.query<{ exists: boolean }>(
      `select exists (
         select 1 from information_schema.tables
         where table_schema = current_schema()
           and table_name = $1
       ) as exists`,
      [table],
    );
    if (!present.rows[0]?.exists) continue;
    try {
      const rows = await pool.query(`select * from ${table}`);
      dump[table] = rows.rows;
    } catch (err) {
      logger.warn(
        { err, table },
        "ensureLegacyCleanup: failed to read legacy table; recording empty dump",
      );
      dump[table] = [];
    }
  }

  try {
    await mkdir(exportDir, { recursive: true });
    await writeFile(
      exportPath,
      JSON.stringify(
        { exportedAt: new Date().toISOString(), tables: dump },
        null,
        2,
      ),
      "utf8",
    );
    logger.info(
      { exportPath, tables: Object.keys(dump) },
      "ensureLegacyCleanup: wrote legacy export",
    );
  } catch (err) {
    logger.error(
      { err, exportPath },
      "ensureLegacyCleanup: failed to write legacy export; aborting drops",
    );
    return;
  }

  for (const table of LEGACY_TABLES) {
    try {
      await pool.query(`drop table if exists ${table} cascade`);
    } catch (err) {
      logger.warn({ err, table }, "ensureLegacyCleanup: drop failed");
    }
  }

  await pool.query(
    `insert into schema_cleanup_marker (key, detail)
     values ($1, $2::jsonb)
     on conflict (key) do nothing`,
    [
      CLEANUP_MARKER_KEY,
      JSON.stringify({
        exportPath,
        droppedTables: LEGACY_TABLES,
      }),
    ],
  );
  logger.info(
    { marker: CLEANUP_MARKER_KEY },
    "ensureLegacyCleanup: marker recorded",
  );
}
