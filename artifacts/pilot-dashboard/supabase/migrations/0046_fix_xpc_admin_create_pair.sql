-- 0046_fix_xpc_admin_create_pair.sql
--
-- Round-5 audit follow-up.
--
-- The round-4 driver's D-T156-D01 was originally classified as a driver bug
-- (wrong arity). After fixing the driver to call the function with its
-- correct 14-argument signature, the call hit a real server-side defect:
--
--   ERROR 42702: column reference "a_pc_id" is ambiguous
--   DETAIL:  It could refer to either a PL/pgSQL variable or a table column
--   QUERY:   insert into public.xpc_pair_links (a_pc_id, b_pc_id, ...)
--            ...
--            on conflict (a_pc_id, b_pc_id) do update ...
--
-- Root cause: `RETURNS TABLE(a_pc_id text, b_pc_id text, kind text)` makes
-- `a_pc_id`, `b_pc_id`, and `kind` implicit PL/pgSQL OUT variables. Inside
-- the function body, the unqualified column references in the INSERT/
-- ON CONFLICT clauses become ambiguous between the table column and the
-- OUT variable. PostgreSQL bails out with 42702.
--
-- The body of xpc_admin_create_pair has been correct in shape since 0038
-- but no caller ever exercised it before (the dashboard's pair UI uses a
-- different code path). The round-4 audit was the first end-to-end caller,
-- which is why this defect surfaced now.
--
-- Fix: replace the function with `#variable_conflict use_column` directive,
-- which tells PL/pgSQL that column references in SQL statements always win
-- over identically-named local variables. The function body and signature
-- are otherwise byte-identical to the version dumped from production
-- (pg_get_functiondef as of 2026-04-24).

create or replace function public.xpc_admin_create_pair(
  p_a_pc_id text,
  p_b_pc_id text,
  p_a_tier text,
  p_b_tier text,
  p_a_squadron text,
  p_b_squadron text,
  p_a_seat text,
  p_b_seat text,
  p_a_user_display text,
  p_b_user_display text,
  p_justification text default null,
  p_expires_at timestamptz default null,
  p_permanent boolean default false,
  p_kind_hint text default null
)
returns table(a_pc_id text, b_pc_id text, kind text)
language plpgsql
security definer
set search_path to 'public'
as $function$
#variable_conflict use_column
declare
  v_kind text;
  ca text; cb text;
  cat text; cbt text;
  cas text; cbs text;
  cas_seat text; cbs_seat text;
  cad text; cbd text;
begin
  if not public.xpc_is_super_admin() then
    raise exception 'admin-create requires super_admin' using errcode = '42501';
  end if;
  if p_a_pc_id is null or p_b_pc_id is null or p_a_pc_id = p_b_pc_id then
    raise exception 'invalid pc ids' using errcode = '22023';
  end if;
  v_kind := public.xpc_validate_pairing(
    p_a_tier, p_b_tier, p_a_squadron, p_b_squadron,
    p_a_seat, p_b_seat, true, p_justification, p_expires_at, p_kind_hint
  );
  if v_kind is null then
    raise exception 'admin-create rejected by matrix' using errcode = '42501';
  end if;
  if p_a_pc_id < p_b_pc_id then
    ca := p_a_pc_id; cb := p_b_pc_id;
    cat := p_a_tier; cbt := p_b_tier;
    cas := p_a_squadron; cbs := p_b_squadron;
    cas_seat := p_a_seat; cbs_seat := p_b_seat;
    cad := p_a_user_display; cbd := p_b_user_display;
  else
    ca := p_b_pc_id; cb := p_a_pc_id;
    cat := p_b_tier; cbt := p_a_tier;
    cas := p_b_squadron; cbs := p_a_squadron;
    cas_seat := p_b_seat; cbs_seat := p_a_seat;
    cad := p_b_user_display; cbd := p_a_user_display;
  end if;
  insert into public.xpc_pair_links
    (a_pc_id, b_pc_id, a_tier, b_tier, a_squadron, b_squadron,
     a_user_seat, b_user_seat, a_user_display, b_user_display,
     kind, paired_by_user_id, paired_by_label,
     justification, expires_at, permanent,
     revoked_at, revoked_reason)
  values
    (ca, cb, cat, cbt, cas, cbs, cas_seat, cbs_seat, cad, cbd,
     v_kind, auth.uid(), 'super_admin',
     p_justification, p_expires_at, coalesce(p_permanent, false),
     null, null)
  on conflict (a_pc_id, b_pc_id) do update
    set kind = excluded.kind,
        a_tier = excluded.a_tier, b_tier = excluded.b_tier,
        a_squadron = excluded.a_squadron, b_squadron = excluded.b_squadron,
        a_user_seat = excluded.a_user_seat, b_user_seat = excluded.b_user_seat,
        a_user_display = excluded.a_user_display, b_user_display = excluded.b_user_display,
        paired_at = now(),
        paired_by_user_id = excluded.paired_by_user_id,
        paired_by_label = 'super_admin',
        justification = excluded.justification,
        expires_at = excluded.expires_at,
        permanent = excluded.permanent,
        revoked_at = null, revoked_reason = null,
        last_activity_at = now();
  insert into public.xpc_pair_audit (action, target_pc_a, target_pc_b, by_user_id, kind, justification, detail)
    values ('pair_created', ca, cb, auth.uid(), v_kind, p_justification,
            jsonb_build_object('via','admin','permanent', coalesce(p_permanent, false),
                               'expires_at', p_expires_at));

  -- Same auto-stamp side effects as xpc_redeem_pair_code (see comment
  -- there). Conditional on the existing parent/squadron host being
  -- NULL so we never overwrite a deliberate operator decision.
  if v_kind = 'in_squadron' then
    update public.xpc_registry
       set squadron_pc_id = case when (select tier from public.xpc_registry where id = ca) = 'flight' then cb else ca end
     where id = case when (select tier from public.xpc_registry where id = ca) = 'flight' then ca else cb end
       and squadron_pc_id is null;
  elsif v_kind = 'sqn_to_wing' then
    update public.xpc_registry
       set parent_pc_id = case when (select tier from public.xpc_registry where id = ca) = 'squadron' then cb else ca end
     where id = case when (select tier from public.xpc_registry where id = ca) = 'squadron' then ca else cb end
       and parent_pc_id is null;
  elsif v_kind = 'wing_to_base' then
    update public.xpc_registry
       set parent_pc_id = case when (select tier from public.xpc_registry where id = ca) = 'wing' then cb else ca end
     where id = case when (select tier from public.xpc_registry where id = ca) = 'wing' then ca else cb end
       and parent_pc_id is null;
  end if;

  return query select ca, cb, v_kind;
end;
$function$;

insert into public._migration_ledger (filename, applied_at, applied_by, sha256)
values ('0046_fix_xpc_admin_create_pair.sql', now(), 'task-156-round5', null)
on conflict (filename) do nothing;

notify pgrst, 'reload schema';
