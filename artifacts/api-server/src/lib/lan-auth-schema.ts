import { pool } from "@workspace/db";

/**
 * Self-provisioned tables for base-LAN operator sessions (replaces Supabase
 * Auth long-term). Safe to run repeatedly — uses IF NOT EXISTS.
 */
export async function ensureLanAuthSchema(): Promise<void> {
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
}
