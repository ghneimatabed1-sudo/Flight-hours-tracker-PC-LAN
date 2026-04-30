-- 0055_assert_pair_code_out_collision_class.sql
--
-- Task #252 — generic in-migration guard for the 42702 ambiguous-column
-- defect class fixed by 0046 (xpc_admin_create_pair) and 0048
-- (xpc_redeem_pair_code).
--
-- Defect class
-- ─────────────
-- A `public.*` PL/pgSQL function declared
--
--     create or replace function public.foo(...)
--     returns table(<col_name> ...)              -- or with explicit OUT params
--     language plpgsql security definer
--     ...
--
-- hoists every `<col_name>` into a PL/pgSQL OUT variable that is in
-- scope for every nested SQL statement in the body. If any of those
-- names matches a column on a table the body INSERTs/UPDATEs into, and
-- the column reference is unqualified (which it usually is in
-- `INSERT (cols ...) VALUES (...)`, `ON CONFLICT (cols ...)`, and
-- `UPDATE SET col = ...`), PostgreSQL aborts with
--
--     42702: column reference "<col_name>" is ambiguous
--     DETAIL: It could refer to either a PL/pgSQL variable or a table column
--
-- The defect is silent in CI / local until a real caller exercises the
-- RPC, which is why the two known instances only surfaced after the
-- round-4 / round-5 audit drivers ran the call paths end-to-end.
--
-- Mitigation: a single `#variable_conflict use_column` directive at the
-- top of the function body. PL/pgSQL then resolves any ambiguous
-- reference in favour of the column, which is the behaviour every
-- existing call site already assumes.
--
-- This migration
-- ───────────────
-- 0046 + 0048 carry per-function regression checks, but those only
-- protect the two functions known to be vulnerable. This migration
-- adds a GENERIC, defect-class-wide assertion that runs on every
-- apply: it enumerates every public.* SECURITY DEFINER PL/pgSQL
-- function, derives its OUT/INOUT/TABLE column names from
-- `pg_proc.proargmodes`, finds the tables it writes to (regex over
-- `pg_get_functiondef`), cross-references against the live column
-- catalog, and `RAISE EXCEPTION`s if any collision is missing
-- `#variable_conflict use_column`. A future migration that adds a
-- new vulnerable RPC will fail to apply, with a clear list of which
-- function and which column collide, rather than landing in
-- production and waiting for its first caller to file a 42702 bug.
--
-- Sweep result at 0055 apply time (2026-04-24 against
-- nklrdhfsbevckovqqkah): 40 SECURITY DEFINER PL/pgSQL functions,
-- 5 with OUT/TABLE params, 2 with name collisions
-- (xpc_admin_create_pair + xpc_redeem_pair_code), BOTH already carry
-- the directive. Zero vulnerable functions remain. The assertion
-- below therefore PASSES on first apply — it's a forward guard.
--
-- Per-function justification for the three RETURNS-TABLE / OUT-param
-- functions that are NOT covered by the directive but are SAFE today:
--
--   * `xpc_pair_links_sweep(p_inactive_days int)` (0038) — OUT names
--     `revoked_count`, `expired_count`. Writes to `xpc_pair_links`,
--     which has neither column. NO COLLISION.
--   * `xpc_backfill_org_chart()` (0037) — OUT names `action`,
--     `entry_name`. Writes to `bases` and `wings`. The OUT was
--     deliberately renamed from `name` to `entry_name` in 0037
--     specifically to dodge this defect class (see header comment in
--     0037). NO COLLISION.
--   * `list_pilot_sync_status()` (0017/0018/0019) — OUT names
--     `pilot_id`, `last_seen_at`, `push_enabled`, `has_token`.
--     READ-ONLY: no INSERT / UPDATE / DELETE statements. The defect
--     fires on unqualified column refs in write statements; a body
--     that only `RETURN QUERY SELECT pr.<col>` cannot trigger it.
--     NO COLLISION at write time.
--
-- The assertion below catches every NEW collision automatically; it
-- does not need to know about these three by name.
--
-- Idempotent. Re-running this migration is a no-op (the DO block has
-- no side effects when the sweep passes).
--
-- SWEEP_VERSION = "task-252.v2 (oid+regex+normalize)"
-- Lockstep tag with scripts/src/check-pair-code-out-collisions.mjs.
-- When the SQL below or the JS sweep changes, bump this string in
-- BOTH files so `git grep SWEEP_VERSION` confirms they agree.

do $$
declare
  bad text;
begin
  with funcs as (
    -- Key by oid so overloaded functions (same proname, different
    -- argument lists) cannot cross-pollinate each other's OUT names
    -- or write targets in the joins below.
    select p.oid as fn_oid,
           p.proname,
           pg_get_function_identity_arguments(p.oid) as args,
           p.proargnames,
           string_to_array(translate(p.proargmodes::text, '{}', ''), ',') as modes,
           pg_get_functiondef(p.oid) as def
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_language l  on l.oid = p.prolang
     where n.nspname = 'public'
       and p.prosecdef = true
       and l.lanname = 'plpgsql'
  ),
  -- OUT/INOUT/TABLE param names — the candidates that can shadow
  -- table columns inside the function body.
  out_names as (
    select f.fn_oid, f.proname, f.args, f.def, f.proargnames[i] as out_name
      from funcs f, generate_subscripts(f.modes, 1) as i
     where f.modes[i] in ('o','b','t')
       and f.proargnames is not null
       and f.proargnames[i] is not null
  ),
  -- Tables the function writes to. Regex is permissive (matches
  -- INSERT INTO / UPDATE / DELETE FROM, with or without the
  -- `public.` schema qualifier). The `g` flag yields one row per
  -- match; the catalog join below filters out names that aren't
  -- real public.* tables (e.g. CTE names).
  targets as (
    select f.fn_oid,
           lower((regexp_matches(
             f.def,
             '(?:insert\s+into|update|delete\s+from)\s+(?:public\.)?([a-z_][a-z0-9_]*)',
             'gi'))[1]) as target_table
      from funcs f
  ),
  -- A collision is: an OUT/TABLE name on the function side that is
  -- ALSO a real column name on a real table the function writes to,
  -- AND the function body lacks `#variable_conflict use_column`.
  -- Directive detection uses regex (case-insensitive, tolerates any
  -- whitespace between the directive keyword and `use_column`) so it
  -- stays in lockstep with the CI sweep at
  -- scripts/src/check-pair-code-out-collisions.mjs.
  collisions as (
    select distinct o.proname, o.args, o.out_name, t.target_table
      from out_names o
      join targets t
        on t.fn_oid = o.fn_oid
      join information_schema.columns c
        on c.table_schema = 'public'
       and c.table_name = t.target_table
       and c.column_name = o.out_name
     where o.def !~* '#variable_conflict[[:space:]]+use_column'
  )
  select string_agg(
           format('public.%I(%s) OUT/TABLE name "%s" collides with public.%I.%I',
                  proname, args, out_name, target_table, out_name),
           E'\n  - ')
    into bad
    from collisions;

  if bad is not null then
    raise exception E'0055 sweep failed: defect-class regression — RETURNS TABLE(...) / OUT names collide with target table columns and `#variable_conflict use_column` is missing.\n  - %\nFix: add `#variable_conflict use_column` immediately after `as $function$` (see 0046 / 0048), or rename the OUT params so they no longer shadow the column.',
      bad;
  end if;
end;
$$;

insert into public._migration_ledger (filename, applied_at, applied_by, sha256)
values ('0055_assert_pair_code_out_collision_class.sql', now(), 'task-252', null)
on conflict (filename) do nothing;

notify pgrst, 'reload schema';
