# Supabase seed data

This folder contains the demo seed for a freshly provisioned Supabase
project. Running it gives the app the same baseline data the in-memory
preview shows **across four demo squadrons** so Hawk Eye HQ commanders
can immediately compare squadrons on the cross-squadron pilot table and
dashboards. Per squadron: 16 pilots, 80 sorties, 240 currencies, 16
annual-leave rows, 5 duty days, 2 unavailability windows, 3 NOTAMs, and
today's 4-slot flight schedule.

### Seeded squadrons

| # | UUID                                   | Squadron                         | Base                      | Pilot IDs  | License key             | Admin email               |
| - | -------------------------------------- | -------------------------------- | ------------------------- | ---------- | ----------------------- | ------------------------- |
| 1 | `00000000-0000-0000-0000-000000000001` | 7th Squadron                     | King Abdullah II Air Base | P001–P016  | `DEMO-RJAF-1234-5678`   | `admin@demo.rjaf.local`   |
| 2 | `00000000-0000-0000-0000-000000000002` | 8th Search & Rescue Squadron     | King Hussein Air Base     | P101–P116  | `DEMO-RJAF-8SAR-0002`   | `admin@8sar.rjaf.local`   |
| 3 | `00000000-0000-0000-0000-000000000003` | 12th VIP Transport Squadron      | Marka Air Base            | P201–P216  | `DEMO-RJAF-12VIP-0003`  | `admin@12vip.rjaf.local`  |
| 4 | `00000000-0000-0000-0000-000000000004` | 5th Flight Test Squadron         | Mafraq Air Base           | P301–P316  | `DEMO-RJAF-5FTS-0004`   | `admin@5fts.rjaf.local`   |

Every admin uses password `admin123`. Pilot IDs are prefixed per-squadron
(`P001+`, `P101+`, `P201+`, `P301+`) so they never collide.

## Files

- **`generate-seed.mjs`** — deterministic generator that mirrors the RNG
  in `src/lib/mock.ts`. Re-run after changing the mock data:
  ```sh
  node artifacts/pilot-dashboard/supabase/seed/generate-seed.mjs
  ```
- **`seed.sql`** — generated SQL ready to apply against a clean DB.

## Run order

1. **Apply migrations** (Supabase SQL editor or `supabase db push`):
   - `migrations/0001_init.sql`
   - `migrations/0002_mobile_link.sql`
2. **Run the seed** with the **service role** (Supabase SQL editor is
   already service-role; psql callers must use the service-role
   connection string). RLS would otherwise block the inserts, and the
   admin-user provisioning at the end writes directly to the `auth.*`
   tables.
   ```sh
   psql "$SUPABASE_SERVICE_ROLE_URL" -f seed.sql
   ```
   The seed creates **four ready-to-use admin accounts** (one per
   squadron) — see the table at the top of this README for each
   squadron's email and license key. Every admin uses password
   `admin123` and has its `app_metadata.squadron_id` pre-set so RLS
   scopes the session to that squadron only. Change every password
   immediately for any non-demo environment.
3. **Activate the license** in the desktop app using any seeded key —
   each squadron has its own, so you can activate as many physical
   desktops as you have seeded squadrons. The first squadron's key is
   `DEMO-RJAF-1234-5678`.

## What gets seeded

Per-squadron counts (multiplied by 4 for the total seed):

| Table         | Rows/sqn | Total | Notes                                                    |
| ------------- | -------- | ----- | -------------------------------------------------------- |
| `squadrons`   | 1        | 4     | Fixed UUIDs `…0001`–`…0004`                              |
| `licenses`    | 1        | 4     | One demo key per squadron, each expires in 365 days      |
| `pilots`      | 16       | 64    | Pilot IDs prefixed per squadron so they never collide    |
| `sorties`     | 80       | 320   | Dates relative to `CURRENT_DATE`                         |
| `currencies`  | 240      | 960   | 16 pilots × 15 six-month tasks                           |
| `leaves`      | 16       | 64    | One row per pilot for the current calendar year          |
| `duty_week`   | 5        | 20    | Sun–Thu standing roster                                  |
| `unavailable` | 2        | 8     | Sample medical leave / course attendance                 |
| `notams`      | 3        | 12    | Recent NOTAMs (per-squadron `notam_no` prefix)           |
| `schedule`    | 4        | 16    | Today's flight line                                      |
| `auth.users`  | 1        | 4     | One demo admin per squadron (`admin@…`/`admin123`)       |

## Verifying

Right after running the seed, these totals should match (all four
squadrons combined):

```sql
select 'squadrons'   as t, count(*) from squadrons
union all select 'pilots',     count(*) from pilots
union all select 'sorties',    count(*) from sorties
union all select 'currencies', count(*) from currencies
union all select 'leaves',     count(*) from leaves
union all select 'duty_week',  count(*) from duty_week
union all select 'notams',     count(*) from notams;
-- expect: 4, 64, 320, 960, 64, 20, 12
```

## One-shot reset & reseed (`pnpm run db:seed`)

For demo environments you can wipe and re-seed in a single command:

```sh
SUPABASE_DB_URL=postgresql://postgres:PWD@db.<project>.supabase.co:5432/postgres \
  pnpm --filter @workspace/pilot-dashboard run db:seed
```

The script (`db-seed.mjs`) does, in order: regenerate `seed.sql` from
`src/lib/mock.ts`, **drop and recreate the entire `public` schema**
(clean slate — Supabase's own `auth`, `storage`, and `extensions`
schemas are not touched), re-apply every migration in `../migrations`,
apply the fresh `seed.sql`, then print a sanity-check row count. It
requires the `psql` CLI on `PATH`.

Because each run resets `public` from scratch, the migrations don't have
to be idempotent — every run is effectively a first run.

The older `reset-and-reseed.sh` in this folder is the previous
truncate-only flow; prefer `pnpm run db:seed` for new work.

**Safety guards:**

- Aborts if `SUPABASE_DB_URL` is missing.
- Refuses to run if the URL contains `prod`, `live`, or `production`
  unless you also set `I_KNOW_WHAT_IM_DOING=1`.
- Prints the target host (with credentials masked) and asks for
  interactive confirmation. Pass `--yes` or set `CI=1` to skip the
  prompt in scripted environments.

**Sourcing `SUPABASE_DB_URL` safely:**

- Use the **direct connection string** from the Supabase dashboard
  (Project Settings → Database → Connection string → URI), not the
  pooled one — migrations need a direct session.
- This connection uses the `postgres` superuser, so treat it like a
  service-role key: keep it out of git, out of chat, and out of any
  shared `.env` that gets committed.
- Prefer exporting it inline for a single command (as in the example
  above) or storing it in a local-only `.env.local` that is git-ignored.
- Never point it at a production project.

## Re-running

The seed is idempotent for stable-key tables (squadrons, licenses,
pilots, currencies, leaves) via `ON CONFLICT … DO UPDATE`. Tables that
either use UUID PKs or key on the run date — sorties, unavailable,
notams, today's schedule, and duty_week — are wiped for this squadron
before reinsert, so re-running on a later day cannot accumulate stale
duplicates.
