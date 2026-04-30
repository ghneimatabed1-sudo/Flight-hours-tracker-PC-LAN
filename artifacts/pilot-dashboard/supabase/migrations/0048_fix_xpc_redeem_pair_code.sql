-- 0048_fix_xpc_redeem_pair_code.sql
--
-- Task #171 — production blocker fix for the self-service cross-PC
-- pairing redemption RPC.
--
-- Audit D against prod (.local/reports/audit-2026-04-25/D-cross-pc.md, D5)
-- proved that EVERY call to public.xpc_redeem_pair_code raises
--
--   ERROR  42702: column reference "a_pc_id" is ambiguous
--   DETAIL It could refer to either a PL/pgSQL variable or a table column
--   QUERY  insert into public.xpc_pair_links (a_pc_id, b_pc_id, ...) ...
--          on conflict (a_pc_id, b_pc_id) do update ...
--
-- Root cause is identical to the one fixed for xpc_admin_create_pair in
-- migration 0046_fix_xpc_admin_create_pair.sql:
--   `RETURNS TABLE(a_pc_id text, b_pc_id text, kind text)` makes a_pc_id,
--   b_pc_id and kind implicit PL/pgSQL OUT variables. Inside the function
--   body the unqualified column references in the INSERT/ON CONFLICT
--   clause become ambiguous between the table column and the OUT variable
--   and PostgreSQL bails out before any row is written.
--
-- Effect in production:
--   * The 6-digit handshake code is NEVER consumed (the function aborts
--     before update consumed_at).
--   * The pair link is NEVER created.
--   * The xpc_pair_audit ledger gets no `pair_created` row.
--   * The whole wing↔base, sqn↔wing and in-squadron self-service
--     pairing flow is broken end-to-end.
--
-- Fix: replace the function with the SAME signature + the SAME body but
--   prepend `#variable_conflict use_column` so column references in SQL
--   statements always win over identically-named local variables. This
--   exactly mirrors the precedent set by 0046 for xpc_admin_create_pair.
--
-- Idempotent. Re-running this migration is a no-op.

create or replace function public.xpc_redeem_pair_code(
  p_code text,
  p_joiner_pc_id text,
  p_joiner_tier text,
  p_joiner_squadron text,
  p_joiner_user_display text,
  p_joiner_user_seat text
) returns table(a_pc_id text, b_pc_id text, kind text)
language plpgsql security definer set search_path = public
as $function$
#variable_conflict use_column
declare
  v_code public.xpc_pair_codes%rowtype;
  v_kind text;
  v_a text; v_b text;
  v_a_tier text; v_b_tier text;
  v_a_sq text; v_b_sq text;
  v_a_disp text; v_b_disp text;
  v_a_seat text; v_b_seat text;
begin
  -- Auth required.
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  -- Joiner must actually own the PC id it claims.
  if p_joiner_pc_id is null
     or not (p_joiner_pc_id = any(public.xpc_my_pc_ids())) then
    raise exception 'joiner does not own pc_id %', p_joiner_pc_id
      using errcode = '42501';
  end if;

  select * into v_code
    from public.xpc_pair_codes
   where code = p_code
   for update;
  if not found then
    raise exception 'code not found' using errcode = 'P0002';
  end if;
  if v_code.consumed_at is not null then
    raise exception 'code already used' using errcode = '22023';
  end if;
  if v_code.expires_at < now() then
    raise exception 'code expired' using errcode = '22023';
  end if;
  if v_code.host_pc_id = p_joiner_pc_id then
    raise exception 'host and joiner are the same PC' using errcode = '22023';
  end if;

  v_kind := public.xpc_validate_pairing(
    v_code.host_tier, p_joiner_tier,
    v_code.host_squadron, p_joiner_squadron,
    v_code.host_user_seat, p_joiner_user_seat,
    false, null, null
  );
  if v_kind is null then
    insert into public.xpc_pair_audit (action, target_pc_a, target_pc_b, by_user_id, detail)
      values ('validation_rejected', v_code.host_pc_id, p_joiner_pc_id, auth.uid(),
              jsonb_build_object('reason','matrix_forbidden_self_service',
                                 'host_tier', v_code.host_tier,
                                 'joiner_tier', p_joiner_tier));
    raise exception 'self-service pair forbidden by matrix (host=%, joiner=%)',
      v_code.host_tier, p_joiner_tier
      using errcode = '42501';
  end if;

  -- Canonical (a < b) ordering.
  if v_code.host_pc_id < p_joiner_pc_id then
    v_a := v_code.host_pc_id; v_b := p_joiner_pc_id;
    v_a_tier := v_code.host_tier; v_b_tier := p_joiner_tier;
    v_a_sq := v_code.host_squadron; v_b_sq := p_joiner_squadron;
    v_a_disp := v_code.host_user_display; v_b_disp := p_joiner_user_display;
    v_a_seat := v_code.host_user_seat; v_b_seat := p_joiner_user_seat;
  else
    v_a := p_joiner_pc_id; v_b := v_code.host_pc_id;
    v_a_tier := p_joiner_tier; v_b_tier := v_code.host_tier;
    v_a_sq := p_joiner_squadron; v_b_sq := v_code.host_squadron;
    v_a_disp := p_joiner_user_display; v_b_disp := v_code.host_user_display;
    v_a_seat := p_joiner_user_seat; v_b_seat := v_code.host_user_seat;
  end if;

  insert into public.xpc_pair_links
    (a_pc_id, b_pc_id, a_tier, b_tier, a_squadron, b_squadron,
     a_user_display, b_user_display, a_user_seat, b_user_seat,
     kind, paired_by_user_id, paired_by_label, revoked_at, revoked_reason)
  values
    (v_a, v_b, v_a_tier, v_b_tier, v_a_sq, v_b_sq,
     v_a_disp, v_b_disp, v_a_seat, v_b_seat,
     v_kind, auth.uid(), p_joiner_user_display, null, null)
  on conflict (a_pc_id, b_pc_id) do update
    set kind = excluded.kind,
        a_tier = excluded.a_tier, b_tier = excluded.b_tier,
        a_squadron = excluded.a_squadron, b_squadron = excluded.b_squadron,
        a_user_display = excluded.a_user_display, b_user_display = excluded.b_user_display,
        a_user_seat = excluded.a_user_seat, b_user_seat = excluded.b_user_seat,
        paired_at = now(),
        paired_by_user_id = excluded.paired_by_user_id,
        paired_by_label = excluded.paired_by_label,
        revoked_at = null, revoked_reason = null,
        last_activity_at = now();

  update public.xpc_pair_codes
     set consumed_at = now()
   where code = p_code;

  insert into public.xpc_pair_audit (action, target_pc_a, target_pc_b, by_user_id, kind, detail)
    values ('pair_created', v_a, v_b, auth.uid(), v_kind,
            jsonb_build_object('via','code','code', p_code));

  -- Auto-stamp side effects so the handshake completes the routing
  -- setup operators expect:
  --   * in_squadron flight↔ops  → flight PC's squadron_pc_id := ops PC
  --   * sqn_to_wing             → squadron PC's parent_pc_id := wing PC
  --   * wing_to_base            → wing PC's parent_pc_id := base PC
  -- All three are conditional updates — operators may have already
  -- pinned a parent / squadron host, in which case we leave it alone
  -- (no overwriting of existing structure).
  if v_kind = 'in_squadron' then
    update public.xpc_registry r
       set squadron_pc_id = case
             when (select tier from public.xpc_registry where id = v_a) = 'flight'
             then v_b else v_a end
     where id = case
             when (select tier from public.xpc_registry where id = v_a) = 'flight'
             then v_a else v_b end
       and squadron_pc_id is null;
  elsif v_kind = 'sqn_to_wing' then
    update public.xpc_registry r
       set parent_pc_id = case
             when (select tier from public.xpc_registry where id = v_a) = 'squadron'
             then v_b else v_a end
     where id = case
             when (select tier from public.xpc_registry where id = v_a) = 'squadron'
             then v_a else v_b end
       and parent_pc_id is null;
  elsif v_kind = 'wing_to_base' then
    update public.xpc_registry r
       set parent_pc_id = case
             when (select tier from public.xpc_registry where id = v_a) = 'wing'
             then v_b else v_a end
     where id = case
             when (select tier from public.xpc_registry where id = v_a) = 'wing'
             then v_a else v_b end
       and parent_pc_id is null;
  end if;

  return query select v_a, v_b, v_kind;
end;
$function$;

revoke all on function public.xpc_redeem_pair_code(text,text,text,text,text,text) from public;
grant execute on function public.xpc_redeem_pair_code(text,text,text,text,text,text) to authenticated;

-- ── In-migration regression assertion ────────────────────────────────
--
-- Defence-in-depth: a future "create or replace" of either fixed RPC
-- that forgets the directive would silently re-introduce the 42702
-- defect class. Catch that at migration apply time by inspecting the
-- live function definitions for the directive. The assertion fires
-- AFTER the create-or-replace above, so it validates the just-loaded
-- bodies — not whatever happened to be in the database before.
do $$
declare
  redeem_def text;
  admin_def text;
begin
  select pg_get_functiondef(p.oid) into redeem_def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'xpc_redeem_pair_code'
     and pg_get_function_identity_arguments(p.oid) =
         'p_code text, p_joiner_pc_id text, p_joiner_tier text, p_joiner_squadron text, p_joiner_user_display text, p_joiner_user_seat text';
  if redeem_def is null then
    raise exception '0048 regression check: xpc_redeem_pair_code(text,text,text,text,text,text) not found';
  end if;
  if position('#variable_conflict use_column' in redeem_def) = 0 then
    raise exception '0048 regression check: xpc_redeem_pair_code is missing #variable_conflict use_column — defect class would re-appear (see 42702)';
  end if;

  select pg_get_functiondef(p.oid) into admin_def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'xpc_admin_create_pair';
  if admin_def is null then
    raise exception '0048 regression check: xpc_admin_create_pair not found (expected from 0046)';
  end if;
  if position('#variable_conflict use_column' in admin_def) = 0 then
    raise exception '0048 regression check: xpc_admin_create_pair lost its #variable_conflict use_column — re-apply 0046 first';
  end if;
end;
$$;

-- Functional end-to-end regression coverage for the three self-service
-- paths (in_squadron, sqn_to_wing, wing_to_base) lives OUTSIDE this
-- migration in `.local/scripts/regression-task-171-redeem-pair.mjs`.
-- It is intentionally not inlined here because it would require seeding
-- temporary auth.users rows (xpc_user_pcs.user_id has FK to auth.users)
-- and a partial seed-then-error would risk rolling back the production
-- fix itself. Run the script after applying this migration to confirm
-- the prod handshake completes for all three pairing kinds:
--   SUPABASE_MANAGEMENT_TOKEN=... \
--     node .local/scripts/regression-task-171-redeem-pair.mjs

insert into public._migration_ledger (filename, applied_at, applied_by, sha256)
values ('0048_fix_xpc_redeem_pair_code.sql', now(), 'task-171', null)
on conflict (filename) do nothing;

notify pgrst, 'reload schema';
