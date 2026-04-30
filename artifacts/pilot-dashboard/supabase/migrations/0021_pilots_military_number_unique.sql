-- 0021_pilots_military_number_unique.sql
--
-- Enforces "every pilot must have a UNIQUE military number" at the database
-- level. The dashboard form already validates this on the client, but with
-- multiple PCs writing to the same Supabase project we need a server-side
-- guarantee so two operations officers can't race a duplicate through.
--
-- Uniqueness is scoped per squadron (data->>'squadronId' or the pilot row's
-- squadron_id column, whichever is available) and is case-insensitive against
-- the trimmed military number stored at data->>'militaryNumber'.
--
-- Rows that don't yet have a military number (legacy rows the user hasn't
-- edited yet) are EXCLUDED from the unique check via the WHERE clause, so
-- this migration is safe to apply against existing data without a backfill.
-- The dashboard's required-field validation will force every new edit to
-- supply one.

DO $$
BEGIN
  -- Only create the index if it does not already exist; allows re-running.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'pilots_military_number_unique_per_squadron'
  ) THEN
    CREATE UNIQUE INDEX pilots_military_number_unique_per_squadron
      ON public.pilots (
        squadron_id,
        lower(trim(data->>'militaryNumber'))
      )
      WHERE data->>'militaryNumber' IS NOT NULL
        AND trim(data->>'militaryNumber') <> '';
  END IF;
END $$;

COMMENT ON INDEX public.pilots_military_number_unique_per_squadron IS
  'Ensures every pilot in a squadron has a unique military number. The mobile pairing flow uses this number as the primary identifier the pilot types on their phone.';
