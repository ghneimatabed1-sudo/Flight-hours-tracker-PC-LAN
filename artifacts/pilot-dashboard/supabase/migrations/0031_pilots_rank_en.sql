-- 0030_pilots_rank_en.sql
--
-- Adds an explicit `rank_en` column to the `pilots` table so every
-- English UI surface (Roster, Duty Week, Schedule, Sortie list, prints
-- etc.) renders a clean English rank instead of echoing the canonical
-- Arabic value stored in `rank` (which we keep unchanged so existing
-- Arabic UI keeps working).
--
-- The dashboard's data layer (`rowToPilot`) reads from both the new
-- column and the JSONB `data->>'rankEn'` so older rows that haven't
-- been re-saved yet still resolve correctly. The Add/Edit Pilot form
-- writes both, so once a pilot is touched in v1.1.73+ the column has
-- the authoritative value.
--
-- The backfill at the bottom uses a CASE expression that mirrors the
-- TypeScript RJAF rank lookup table in `src/lib/ranks.ts`. Any pilot
-- whose Arabic rank doesn't match a known value is left NULL — the
-- read-side fallback in the app fills in via the same lookup at
-- render time, and the next save persists it.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'pilots'
      AND column_name = 'rank_en'
  ) THEN
    ALTER TABLE public.pilots ADD COLUMN rank_en text;
  END IF;
END $$;

-- One-shot backfill — only updates rows where rank_en is NULL so this
-- migration is safe to re-run and won't overwrite operator edits.
UPDATE public.pilots
SET rank_en = CASE regexp_replace(coalesce(rank, ''), '\s+', ' ', 'g')
  WHEN 'ملازم طيار'              THEN '2nd Lt'
  WHEN 'ملازم/١ طيار'             THEN '1st Lt'
  WHEN 'ملازم أول طيار'            THEN '1st Lt'
  WHEN 'نقيب طيار'                THEN 'Capt'
  WHEN 'رائد طيار'                THEN 'Maj'
  WHEN 'مقدم طيار'                THEN 'Lt Col'
  WHEN 'مقدم الركن طيار'          THEN 'Lt Col (GS)'
  WHEN 'المقدم الركن الطيار'      THEN 'Lt Col (GS)'
  WHEN 'عقيد طيار'                THEN 'Col'
  WHEN 'عقيد الركن طيار'          THEN 'Col (GS)'
  WHEN 'العقيد الركن الطيار'      THEN 'Col (GS)'
  WHEN 'عميد طيار'                THEN 'Brig Gen'
  WHEN 'لواء طيار'                THEN 'Maj Gen'
  WHEN 'فريق طيار'                THEN 'Lt Gen'
  ELSE NULL
END
WHERE rank_en IS NULL;
