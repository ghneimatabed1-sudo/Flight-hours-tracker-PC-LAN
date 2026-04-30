-- 0014_security_hardening.sql
-- Fixes Supabase Security Advisor warnings:
--   1. "Function Search Path Mutable" for public.squadron_id()
--   2. "Function Search Path Mutable" for public.pilot_id()
--
-- Setting search_path = '' (empty) prevents search_path injection attacks.
-- Both functions only call current_setting() which is a built-in PostgreSQL
-- function and does not depend on any search_path.

create or replace function public.squadron_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(coalesce(
    pg_catalog.current_setting('request.jwt.claims', true)::jsonb #>> '{app_metadata,squadron_id}',
    ''
  ), '')::uuid;
$$;

create or replace function public.pilot_id()
returns text
language sql
stable
set search_path = ''
as $$
  select nullif(coalesce(
    pg_catalog.current_setting('request.jwt.claims', true)::jsonb #>> '{app_metadata,pilot_id}',
    ''
  ), '');
$$;
