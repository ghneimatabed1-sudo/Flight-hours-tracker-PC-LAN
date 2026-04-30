-- Mobile pilot viewer — server-side link verification, per-pilot device tokens,
-- and tightened RLS so that the anon key alone cannot read pilot or sortie rows.
--
-- Trust model:
--   * Ops officer issues a one-time link code from the PC dashboard. The code
--     is hashed (SHA-256) and stored in pilot_link_codes; the raw value never
--     lives in the database.
--   * The mobile app calls link_pilot_device(p_mil, p_code). The function runs
--     SECURITY DEFINER, validates the code server-side, marks it consumed,
--     issues an opaque device token, and returns the initial pilot snapshot.
--   * Every subsequent fetch goes through pilot_snapshot(p_token), which again
--     runs SECURITY DEFINER and only returns the rows for the pilot bound to
--     that token. The mobile app never selects directly from pilots/sorties.
--   * Existing pilots_rw / sorties_rw policies require an authenticated
--     squadron JWT, so anon clients cannot read those tables directly. This
--     migration revokes any residual anon SELECT rights to make that explicit.

create extension if not exists "pgcrypto";

-- One-time codes issued by ops to a specific pilot. Hashed at rest.
create table if not exists pilot_link_codes (
  id uuid primary key default gen_random_uuid(),
  squadron_id uuid not null references squadrons(id) on delete cascade,
  pilot_id text not null references pilots(id) on delete cascade,
  code_hash text not null,
  issued_by uuid references auth.users(id),
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  consumed_at timestamptz
);

create index if not exists pilot_link_codes_pilot_idx on pilot_link_codes(pilot_id);

-- Active mobile devices. The token is opaque and treated like a bearer secret
-- (32 random bytes, base64url). It is also stored hashed so the database never
-- holds the raw value.
create table if not exists pilot_devices (
  token_hash text primary key,
  squadron_id uuid not null references squadrons(id) on delete cascade,
  pilot_id text not null references pilots(id) on delete cascade,
  linked_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists pilot_devices_pilot_idx on pilot_devices(pilot_id);

alter table pilot_link_codes enable row level security;
alter table pilot_devices    enable row level security;

-- Only ops staff (authenticated app_users in the same squadron) can read or
-- mutate codes / devices through PostgREST. The mobile RPCs run SECURITY
-- DEFINER and therefore bypass these row policies for their own narrow needs.
create policy link_codes_ops_rw on pilot_link_codes
  for all using (squadron_id = public.squadron_id())
  with check (squadron_id = public.squadron_id());

create policy devices_ops_rw on pilot_devices
  for all using (squadron_id = public.squadron_id())
  with check (squadron_id = public.squadron_id());

-- Belt-and-braces: explicitly remove any lingering anon SELECT rights on the
-- pilot-facing tables. The pilots_rw / sorties_rw policies in 0001 already
-- gate by squadron JWT, so these revokes only document intent.
revoke all on pilots from anon;
revoke all on sorties from anon;
revoke all on pilot_link_codes from anon;
revoke all on pilot_devices from anon;

-- Helpers --------------------------------------------------------------------

-- pgcrypto lives in the `extensions` schema on Supabase, so callers with
-- `set search_path = public` cannot see `digest()` unqualified — that was
-- the "function digest(text, unknown) does not exist" (42883) error users
-- hit when generating a mobile pairing code. Fully-qualify the call so
-- the function works regardless of the caller's search_path.
create extension if not exists pgcrypto with schema extensions;

create or replace function public._hash_secret(p_secret text)
returns text language sql immutable
set search_path = public, extensions as $$
  select encode(extensions.digest(p_secret, 'sha256'), 'hex');
$$;

-- Issue a fresh link code for a pilot. Called from the ops dashboard.
-- Returns the *raw* code so ops can read it once and share with the pilot.
create or replace function public.issue_pilot_link_code(p_pilot_id text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_squadron uuid;
  v_code text;
begin
  -- Must be an authenticated ops user from the pilot's squadron.
  select squadron_id into v_squadron from pilots where id = p_pilot_id;
  if v_squadron is null then
    raise exception 'pilot_not_found';
  end if;
  if public.squadron_id() is distinct from v_squadron then
    raise exception 'forbidden';
  end if;

  -- 6-digit numeric, easy to read over the phone.
  v_code := lpad((floor(random() * 1000000))::int::text, 6, '0');

  -- Invalidate any unconsumed codes for this pilot first.
  update pilot_link_codes
     set consumed_at = now()
   where pilot_id = p_pilot_id and consumed_at is null;

  insert into pilot_link_codes (squadron_id, pilot_id, code_hash, issued_by)
  values (v_squadron, p_pilot_id, _hash_secret(v_code), auth.uid());

  return v_code;
end;
$$;

-- Verify a one-time code and bind a new device. Returns an opaque token plus
-- the initial pilot snapshot.
create or replace function public.link_pilot_device(p_mil text, p_code text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_pilot pilots%rowtype;
  v_token text;
  v_token_hash text;
  v_snapshot jsonb;
begin
  if p_mil is null or p_code is null
     or length(trim(p_mil)) = 0
     or length(trim(p_code)) = 0 then
    raise exception 'bad_input';
  end if;

  select * into v_pilot from pilots where id = trim(p_mil);
  if not found then
    -- Use a generic error to avoid confirming which military numbers exist.
    raise exception 'invalid_credentials';
  end if;

  -- Match against an unconsumed, unexpired code for this pilot.
  perform 1
    from pilot_link_codes
   where pilot_id = v_pilot.id
     and code_hash = _hash_secret(trim(p_code))
     and consumed_at is null
     and expires_at > now()
   limit 1;
  if not found then
    raise exception 'invalid_credentials';
  end if;

  update pilot_link_codes
     set consumed_at = now()
   where pilot_id = v_pilot.id
     and code_hash = _hash_secret(trim(p_code))
     and consumed_at is null;

  v_token := encode(gen_random_bytes(32), 'base64');
  v_token_hash := _hash_secret(v_token);

  insert into pilot_devices (token_hash, squadron_id, pilot_id)
  values (v_token_hash, v_pilot.squadron_id, v_pilot.id);

  insert into audit_log (squadron_id, type, actor, detail)
  values (v_pilot.squadron_id, 'mobile.link', v_pilot.id,
          jsonb_build_object('pilotId', v_pilot.id));

  v_snapshot := pilot_snapshot(v_token);
  return v_snapshot || jsonb_build_object('token', v_token);
end;
$$;

-- Resolve a token to its pilot, returning the read-only snapshot. Updates
-- last_seen_at so ops can see when a device last synced.
create or replace function public.pilot_snapshot(p_token text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_token_hash text;
  v_device pilot_devices%rowtype;
  v_pilot pilots%rowtype;
  v_squadron squadrons%rowtype;
  v_sorties jsonb;
begin
  if p_token is null or length(p_token) = 0 then
    raise exception 'unauthorized';
  end if;

  v_token_hash := _hash_secret(p_token);
  select * into v_device
    from pilot_devices
   where token_hash = v_token_hash
     and revoked_at is null;
  if not found then
    raise exception 'unauthorized';
  end if;

  update pilot_devices
     set last_seen_at = now()
   where token_hash = v_token_hash;

  select * into v_pilot from pilots where id = v_device.pilot_id;
  if not found then
    raise exception 'unauthorized';
  end if;

  select * into v_squadron from squadrons where id = v_pilot.squadron_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id,
           'date', s.date,
           'data', s.data
         ) order by s.date desc), '[]'::jsonb)
    into v_sorties
    from sorties s
   where s.pilot_id = v_pilot.id;

  return jsonb_build_object(
    'pilot', jsonb_build_object(
      'id', v_pilot.id,
      'rank', v_pilot.rank,
      'name', v_pilot.name,
      'arabicName', v_pilot.arabic_name,
      'unit', v_pilot.unit,
      'phone', v_pilot.phone,
      'data', v_pilot.data
    ),
    'squadron', case when v_squadron.id is null then null
                else jsonb_build_object(
                  'id', v_squadron.id,
                  'number', v_squadron.number,
                  'name', v_squadron.name,
                  'base', v_squadron.base
                ) end,
    'sorties', v_sorties
  );
end;
$$;

-- Allow the anon role (mobile app, no JWT) to call only these two RPCs.
grant execute on function public.link_pilot_device(text, text) to anon;
grant execute on function public.pilot_snapshot(text) to anon;

-- Ops issuance is for authenticated dashboard users only.
revoke all on function public.issue_pilot_link_code(text) from public;
grant execute on function public.issue_pilot_link_code(text) to authenticated;

-- Ops can revoke a device (e.g. lost phone). Plain UPDATE on pilot_devices is
-- already gated by the devices_ops_rw policy, so no extra function is needed.
