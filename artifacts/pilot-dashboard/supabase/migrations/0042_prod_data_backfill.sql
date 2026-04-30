-- 0042_prod_data_backfill.sql
--
-- Task #145 (2/4) — One-shot production data cleanup.
--
-- Idempotent. Re-running on a clean DB is a no-op. The cleanup work:
--
--   1. Collapse every group of xpc_registry rows that canonicalise to
--      the same id into a single canonical row, keeping the most
--      recent last_seen + the most informative metadata.
--   2. Re-point xpc_pair_links and xpc_user_pcs at the surviving id.
--   3. Delete xpc_user_pcs rows whose pc_id no longer exists in
--      xpc_registry (orphans from PCs that were reset by hand without
--      cleaning up their claims).
--   4. Merge every group of squadrons rows that canonicalise to the
--      same name into the oldest surviving row, re-pointing every FK.
--   5. Backfill squadrons.wing for any row with a NULL wing — defaults
--      to "8 WG" because today's only customer is NO.8 SQDN under 8 WG;
--      the Setup Wizard overrides this on every fresh install. The
--      default is intentional: a NULL wing breaks downstream PDF
--      headers and the org-chart picker, so anything is better than
--      nothing for the existing 15 years of data.
--
-- The trigger added in 0041 prevents the same drift from re-appearing
-- — once this migration runs, future inserts that would create a
-- different-cased duplicate are rejected at the DB layer.

-- ── 1+2+3. xpc_registry / xpc_user_pcs / xpc_pair_links collapse ────
do $$
declare
  grp record;
  keep record;
  victim record;
begin
  for grp in
    select public.xpc_canon_pc_id(id) as canon, count(*) as n
      from public.xpc_registry
     group by public.xpc_canon_pc_id(id)
    having count(*) > 1
  loop
    -- Pick the survivor: MOST RECENT last_seen wins. Ties broken by
    -- shorter id (typically the cleanest spelling).
    select * into keep
      from public.xpc_registry
     where public.xpc_canon_pc_id(id) = grp.canon
     order by last_seen desc nulls last, length(id) asc, id asc
     limit 1;

    raise notice 'collapsing % rows under canon % → keeping id=%',
      grp.n, grp.canon, keep.id;

    -- Walk every other row in the group and re-point references.
    for victim in
      select * from public.xpc_registry
       where public.xpc_canon_pc_id(id) = grp.canon
         and id <> keep.id
    loop
      -- Re-point xpc_user_pcs (pc_id is part of PK alongside user_id).
      -- Use ON CONFLICT DO NOTHING semantics: if the user already
      -- claims the survivor id, drop the duplicate row.
      delete from public.xpc_user_pcs
       where user_id in (
         select user_id from public.xpc_user_pcs where pc_id = victim.id
         intersect
         select user_id from public.xpc_user_pcs where pc_id = keep.id
       )
         and pc_id = victim.id;
      update public.xpc_user_pcs set pc_id = keep.id where pc_id = victim.id;

      -- Re-point xpc_pair_links. Both sides may need rewriting. The
      -- canonical (a < b) constraint and PK (a, b) mean a self-pair
      -- (X ↔ X) is impossible — so any pair that becomes self-referential
      -- is deleted, not rewritten.
      delete from public.xpc_pair_links
       where (a_pc_id = victim.id and b_pc_id = keep.id)
          or (a_pc_id = keep.id   and b_pc_id = victim.id)
          or (a_pc_id = victim.id and b_pc_id = victim.id);

      -- ANTI-JOIN PRE-DELETE: if BOTH victim and keep are paired with
      -- the same third PC X, the UPDATE below would try to insert a
      -- duplicate (keep,X) row and fail the PK. Delete those victim
      -- rows first — keep already has the canonical pair to X.
      delete from public.xpc_pair_links v
       where (v.a_pc_id = victim.id or v.b_pc_id = victim.id)
         and exists (
           select 1 from public.xpc_pair_links k
            where (k.a_pc_id = keep.id or k.b_pc_id = keep.id)
              and case when k.a_pc_id = keep.id then k.b_pc_id else k.a_pc_id end
                = case when v.a_pc_id = victim.id then v.b_pc_id else v.a_pc_id end
         );

      -- Rewrite the remaining sides. We have to respect the canonical
      -- (a < b) ordering, so swap if needed.
      update public.xpc_pair_links
         set a_pc_id = least(keep.id, b_pc_id),
             b_pc_id = greatest(keep.id, b_pc_id)
       where a_pc_id = victim.id;
      update public.xpc_pair_links
         set a_pc_id = least(a_pc_id, keep.id),
             b_pc_id = greatest(a_pc_id, keep.id)
       where b_pc_id = victim.id;

      -- Audit trail (the table has no INSERT policy for the
      -- authenticated role, but DDL runs as superuser via the
      -- Management API so this insert is permitted).
      insert into public.xpc_pair_audit
        (action, target_pc_a, target_pc_b, kind, detail)
        values ('registry_pruned', victim.id, keep.id, null,
                jsonb_build_object('reason','canon_dedup',
                                   'canon', grp.canon,
                                   'merged_into', keep.id));

      -- Finally drop the victim registry row.
      delete from public.xpc_registry where id = victim.id;
    end loop;
  end loop;

  -- 3. Orphan xpc_user_pcs rows.
  delete from public.xpc_user_pcs up
   where not exists (
     select 1 from public.xpc_registry r where r.id = up.pc_id
   );
end $$;

-- ── 4. squadrons collapse ───────────────────────────────────────────
do $$
declare
  grp record;
  keep record;
  victim record;
begin
  for grp in
    select public.squadrons_canon_name(name) as canon, count(*) as n
      from public.squadrons
     group by public.squadrons_canon_name(name)
    having count(*) > 1
  loop
    -- Pick the survivor: OLDEST created_at wins, because it's the row
    -- the rest of the schema's FKs already point at.
    select * into keep
      from public.squadrons
     where public.squadrons_canon_name(name) = grp.canon
     order by created_at asc nulls last, id asc
     limit 1;

    raise notice 'collapsing % squadrons under canon % → keeping id=% name=%',
      grp.n, grp.canon, keep.id, keep.name;

    for victim in
      select * from public.squadrons
       where public.squadrons_canon_name(name) = grp.canon
         and id <> keep.id
    loop
      -- Re-point every FK referencing squadrons.id. Listed explicitly
      -- so a future schema addition that adds another squadron-scoped
      -- table forces a code review here rather than silently drifting.
      update public.licenses             set squadron_id = keep.id where squadron_id = victim.id;
      update public.users                set squadron_id = keep.id where squadron_id = victim.id;
      update public.pilots               set squadron_id = keep.id where squadron_id = victim.id;
      update public.sorties              set squadron_id = keep.id where squadron_id = victim.id;
      update public.currencies           set squadron_id = keep.id where squadron_id = victim.id;
      update public.leaves               set squadron_id = keep.id where squadron_id = victim.id;
      update public.unavailable          set squadron_id = keep.id where squadron_id = victim.id;
      update public.duty_week            set squadron_id = keep.id where squadron_id = victim.id;
      update public.schedule             set squadron_id = keep.id where squadron_id = victim.id;
      update public.notams               set squadron_id = keep.id where squadron_id = victim.id;
      update public.audit_log            set squadron_id = keep.id where squadron_id = victim.id;
      update public.pilot_link_codes     set squadron_id = keep.id where squadron_id = victim.id;
      update public.pilot_devices        set squadron_id = keep.id where squadron_id = victim.id;
      update public.pilot_reminder_prefs set squadron_id = keep.id where squadron_id = victim.id;
      update public.alerts               set squadron_id = keep.id where squadron_id = victim.id;

      delete from public.squadrons where id = victim.id;
    end loop;
  end loop;
end $$;

-- ── 5. Backfill squadrons.wing ──────────────────────────────────────
-- Default '8 WG' matches today's customer; new squadrons override on
-- first save via the Setup Wizard. Operators can edit the field at
-- any time on Admin → Squadrons.
update public.squadrons
   set wing = '8 WG'
 where wing is null or btrim(wing) = '';

-- ── 6. Unique indexes on the canonical form ─────────────────────────
-- These are the belt-and-braces enforcement deferred from 0041 — now
-- safe to create because steps 1-4 just collapsed every group of
-- canon-equivalent rows down to one. Idempotent across re-runs.
drop index if exists public.xpc_registry_id_canon_idx;
create unique index xpc_registry_id_canon_idx
  on public.xpc_registry ((public.xpc_canon_pc_id(id)));

drop index if exists public.squadrons_name_canon_idx;
create unique index squadrons_name_canon_idx
  on public.squadrons ((public.squadrons_canon_name(name)));

notify pgrst, 'reload schema';
