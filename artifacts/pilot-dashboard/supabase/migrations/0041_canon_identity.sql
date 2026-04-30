-- 0041_canon_identity.sql
--
-- Task #145 (1/4) — Identity normalization in the database.
--
-- Two helper functions + two unique indexes + two BEFORE INSERT/UPDATE
-- triggers that prevent the production drift that bit us in April 2026:
-- three xpc_registry rows ("NO.8", "NO. 8 SQDN", "NO.8 SQDN") and two
-- squadrons rows ("NO.8" / "NO.8 Squadron") for what is logically ONE
-- squadron.
--
-- Going forward the database itself rejects any write whose canonical
-- form would collide with a different-cased existing row, with an
-- error message the operator can act on.
--
-- The one-shot collapse of the existing duplicates lives in
-- 0042_prod_data_backfill.sql — this migration sets up the rails;
-- the next one runs them. Keeping them split means we can re-run 0041
-- safely on a brand-new install (no duplicates yet) without the
-- backfill firing on data that may not exist.

-- ── canonicalisers ────────────────────────────────────────────────────
-- xpc_canon_pc_id rules (settled after the April-2026 burn-in):
--   * Strip everything except [A-Z0-9.:#], then uppercase. Dots are
--     preserved so "NO.8" stays distinct from "NO8" (those really are
--     different PCs in legacy operator naming).
--   * If the id has NO namespace marker (':' or '#'), additionally
--     strip a trailing SQDN / SQUADRON / SQN suffix. This collapses
--     the prod-witnessed trio "NO.8" / "NO. 8 SQDN" / "NO.8 SQDN"
--     down to one canonical "NO.8".
--   * If the id IS namespaced (e.g. "WING:NORTH", "FLIGHT:NO.8#A1"),
--     leave the suffix alone — "WING:NORTH-SQDN" is a different PC
--     from "WING:NORTH" and we must not merge them.
create or replace function public.xpc_canon_pc_id(p_id text)
returns text
language sql
immutable
set search_path = public, pg_catalog
as $$
  with stripped as (
    select upper(regexp_replace(coalesce(p_id, ''), '[^A-Za-z0-9.:#]', '', 'g')) as s
  )
  select case
    when s = '' then null
    when s !~ '[:#]' then regexp_replace(s, '(SQDN|SQUADRON|SQN)$', '')
    else s
  end
  from stripped;
$$;

-- squadrons_canon_name: same idea, but ALSO strip the trailing "SQDN"
-- / "SQUADRON" suffix so "NO.8" and "NO.8 Squadron" canonicalise to
-- one value. This is intentional: in operational radio traffic the
-- bare squadron number IS the squadron — the suffix is decoration.
create or replace function public.squadrons_canon_name(p_name text)
returns text language sql immutable as $$
  select case when p_name is null then null
              else upper(
                regexp_replace(
                  regexp_replace(p_name, '\s+', '', 'g'),
                  '(SQDN|SQUADRON)$', '', 'i'
                )
              )
         end;
$$;

grant execute on function public.xpc_canon_pc_id(text) to authenticated, anon;
grant execute on function public.squadrons_canon_name(text) to authenticated, anon;

-- ── NOTE on unique indexes ───────────────────────────────────────────
-- The unique indexes on the canonical form are deliberately created in
-- 0042_prod_data_backfill.sql, AFTER the duplicate-collapse runs.
-- Creating them here would fail on production (which already has 3
-- registry rows + 2 squadrons rows that all canonicalise to the same
-- value) and brick the entire pipeline. The trigger guards below give
-- us correctness from this migration onward; the indexes give us
-- belt-and-braces enforcement once 0042 has cleaned the slate.

-- ── BEFORE INSERT/UPDATE triggers — instructive error messages ──────
-- The unique index above already enforces collision; the trigger fires
-- FIRST so the operator sees a sentence describing what to do, not the
-- raw "duplicate key value violates unique constraint" text.

create or replace function public.xpc_registry_canon_guard()
returns trigger language plpgsql as $$
declare
  existing text;
  new_canon text := public.xpc_canon_pc_id(new.id);
begin
  select id into existing
    from public.xpc_registry
   where public.xpc_canon_pc_id(id) = new_canon
     and id <> new.id
   limit 1;
  if existing is not null then
    raise exception
      'PC id % collides with existing PC id % (both canonicalise to %). '
      'Pick the canonical id (no whitespace, uppercase) for this PC, or '
      'reset the duplicate from the Connection Map first.',
      new.id, existing, new_canon
      using errcode = '23505';
  end if;
  return new;
end;
$$;

drop trigger if exists xpc_registry_canon_guard_trg on public.xpc_registry;
create trigger xpc_registry_canon_guard_trg
  before insert or update of id on public.xpc_registry
  for each row execute function public.xpc_registry_canon_guard();

create or replace function public.squadrons_canon_guard()
returns trigger language plpgsql as $$
declare
  existing text;
  new_canon text := public.squadrons_canon_name(new.name);
begin
  select name into existing
    from public.squadrons
   where public.squadrons_canon_name(name) = new_canon
     and id <> new.id
   limit 1;
  if existing is not null then
    raise exception
      'Squadron name % collides with existing squadron % (both '
      'canonicalise to %). Edit the existing row instead of creating '
      'a duplicate, or rename it first.',
      new.name, existing, new_canon
      using errcode = '23505';
  end if;
  return new;
end;
$$;

drop trigger if exists squadrons_canon_guard_trg on public.squadrons;
create trigger squadrons_canon_guard_trg
  before insert or update of name on public.squadrons
  for each row execute function public.squadrons_canon_guard();

-- Reload PostgREST schema cache so freshly-added functions are callable
-- via the REST API on the next request rather than 60 seconds later.
notify pgrst, 'reload schema';
