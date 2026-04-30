-- Widen the cross-PC tier CHECK constraints to match the app's real
-- tier set.
--
-- Migration 0010 created xpc_registry.tier, xpc_messages.from_tier /
-- to_tier, and xpc_schedule_shares.current_tier with constraints that
-- pre-date the Flight Commander tier (added in v1.0.45) and the HQ
-- viewer tier. The mismatch caused two symptom classes that made
-- "some PCs / users don't appear" reports impossible to triage:
--
--   1. xpc_schedule_shares — when a Squadron Commander forwards a
--      sheet down to a Flight Commander, cross-pc.ts wrote
--      current_tier='flight' verbatim. Postgres rejected the row with
--      `new row for relation "xpc_schedule_shares" violates check
--      constraint "xpc_schedule_shares_current_tier_check"`. The
--      flight commander's inbox stayed empty forever and no client-side
--      log surfaced the failure (the supabase error was swallowed by
--      the offline fallback path in liveOrLocal).
--
--   2. xpc_messages — flight-tier messages were already worked around
--      in the client by downgrading to 'squadron' on write and
--      recovering 'flight' from the FLIGHT: id prefix on read. That
--      hack worked, but it left HQ-tier messages (a real combination
--      once HQ viewers were added) silently rejected for the same
--      reason: 'hq' was missing from the constraint.
--
--   3. xpc_registry — flight tier is encoded as 'squadron' with a
--      FLIGHT: id prefix. Widening the constraint here lets the
--      client write the real tier going forward without breaking any
--      existing rows.
--
-- This migration drops and re-adds the three CHECK constraints with
-- the full tier set so the client can write the canonical value
-- straight through. The fallback decoders (rowToMessage / rowToShare /
-- rowToPc) keep their FLIGHT: prefix recovery so rows written by
-- older builds still map back to the right tier.

alter table public.xpc_registry
  drop constraint if exists xpc_registry_tier_check;
alter table public.xpc_registry
  add  constraint xpc_registry_tier_check
       check (tier in ('flight','squadron','wing','base','hq'));

alter table public.xpc_messages
  drop constraint if exists xpc_messages_from_tier_check;
alter table public.xpc_messages
  add  constraint xpc_messages_from_tier_check
       check (from_tier in ('flight','squadron','wing','base','hq'));

alter table public.xpc_messages
  drop constraint if exists xpc_messages_to_tier_check;
alter table public.xpc_messages
  add  constraint xpc_messages_to_tier_check
       check (to_tier in ('flight','squadron','wing','base','hq'));

alter table public.xpc_schedule_shares
  drop constraint if exists xpc_schedule_shares_current_tier_check;
alter table public.xpc_schedule_shares
  add  constraint xpc_schedule_shares_current_tier_check
       check (current_tier in ('flight','squadron','wing','base','hq'));
