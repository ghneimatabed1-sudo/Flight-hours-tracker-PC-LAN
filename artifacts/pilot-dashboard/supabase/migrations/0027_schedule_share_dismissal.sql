-- 0027_schedule_share_dismissal.sql
--
-- Two new columns on xpc_schedule_shares so the Flight Schedule chain
-- can clean itself up without operator babysitting:
--
--   rejected_by_pc_ids   text[]      PC IDs that have rejected this share.
--                                    Populated automatically when an
--                                    approver clicks "Reject"; the share
--                                    bounces back to the originator and
--                                    is then permanently hidden from any
--                                    PC in this list (so the originator's
--                                    follow-up edit/resend/approve does
--                                    NOT re-surface a stale rejected row
--                                    in the rejecter's inbox).
--
--   originator_dismissed_at  timestamptz  When the originating PC chose
--                                    "Delete from my view". Hides the
--                                    share from the originator's screen
--                                    only. Receivers, reviewers and the
--                                    central audit trail are untouched.

ALTER TABLE public.xpc_schedule_shares
  ADD COLUMN IF NOT EXISTS rejected_by_pc_ids text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS originator_dismissed_at timestamptz;
