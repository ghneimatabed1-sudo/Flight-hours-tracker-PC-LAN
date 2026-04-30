-- Tighten xpc_registry SELECT visibility.
--
-- Previously the registry's SELECT policy was `using (true)`, meaning any
-- authenticated user (including a squadron-tier operator at Squadron A)
-- could enumerate every PC across the entire base — squadron names,
-- device fingerprints, last-seen times, app versions. The operational
-- features only need a much narrower slice:
--
--   * Wing / Base / HQ leadership PCs are a public directory — every
--     squadron must be able to address them (messages going "up").
--   * Wing / Base / HQ viewers themselves need to see every squadron
--     PC they oversee.
--   * Squadron-tier viewers should ONLY see another squadron's PC if
--     they have already exchanged something with that squadron through
--     one of the participant-scoped tables (pending guest-pilot
--     approval, schedule share, or direct message). Random enumeration
--     is no longer possible.
--   * A user can always see PCs they have personally claimed.
--
-- The xpc_pending / xpc_schedule_shares / xpc_messages policies were
-- already participant-scoped, so this migration only touches the
-- registry table.

-- Helper: viewer's app_metadata.tier, read straight from the JWT
-- (no table lookup, no recursion). Mirrors the read in
-- xpc_can_claim_pc_id().
create or replace function public.xpc_my_jwt_tier()
  returns text
  language sql stable
as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb
       -> 'app_metadata' ->> 'tier';
$$;
grant execute on function public.xpc_my_jwt_tier() to authenticated;

drop policy if exists xpc_registry_select on public.xpc_registry;
create policy xpc_registry_select on public.xpc_registry
  for select to authenticated
  using (
    -- 1. Your own PCs.
    id = any(public.xpc_my_pc_ids())

    -- 2. Leadership PCs are a public directory (everyone needs to be
    --    able to address Wing / Base / HQ).
    or tier in ('wing', 'base', 'hq')

    -- 3. Wing / Base / HQ viewers see every PC, including all squadrons
    --    under them.
    or coalesce(public.xpc_my_jwt_tier(), '') in ('wing', 'base', 'hq')

    -- 4. Squadron-tier viewers can see another squadron's PC only if
    --    they have an established interaction with it.
    or exists (
      select 1 from public.xpc_pending p
       where (p.hosting_squadron_id = xpc_registry.id
              or p.home_squadron_id = xpc_registry.id)
         and (p.hosting_squadron_id = any(public.xpc_my_pc_ids())
              or p.home_squadron_id = any(public.xpc_my_pc_ids()))
    )
    or exists (
      select 1 from public.xpc_schedule_shares s
       where (s.origin_squadron_id = xpc_registry.id
              or s.current_pc_id = xpc_registry.id)
         and (s.origin_squadron_id = any(public.xpc_my_pc_ids())
              or s.current_pc_id = any(public.xpc_my_pc_ids()))
    )
    or exists (
      select 1 from public.xpc_messages m
       where (m.from_pc_id = xpc_registry.id
              or m.to_pc_id = xpc_registry.id)
         and (m.from_pc_id = any(public.xpc_my_pc_ids())
              or m.to_pc_id = any(public.xpc_my_pc_ids()))
    )
  );
