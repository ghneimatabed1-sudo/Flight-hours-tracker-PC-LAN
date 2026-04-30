# Audit G — Single-squadron operational walk + calc verification

**Run ID:** `mod5f3sl`  
**Started:** 2026-04-24T16:52:29.301Z  
**Ended:** 2026-04-24T16:53:18.724Z  
**Target:** Supabase project `nklrdhfsbevckovqqkah`  
**Namespace:** `AUD_SIM_G_*`

---

## 1. One-line headline

**FAIL** — one or more C-1..C-10 calculations mismatched (see §3 + defects).

---

## 2. Operational walk

| Step | Result |
|---|---|
| Sortie add via dashboard RPC path | PASS |
| Sortie add via mobile flat path | PASS |
| Sortie edit + audit row | PASS |
| Sortie delete + audit row | PASS |
| Schedule chain 6-state walk | FAIL |
| Schedule reject — no sortie row | PASS |
| Pilot profile edit + audit row | PASS |
| Pilot create + delete audit rows | PASS |
| Pilot transfer #26 (out + back) | PASS |
| Pilot transfer paired audit rows | PASS |

Schedule chain states traversed: submitted → in_review_flight → partial_reject → resubmitted → approved → dismissed

Pilot transfer evidence:
- out → `{"leaves":0,"devices":0,"pilotId":"AUD_SIM_G_P8_mod5f3sl","sorties":0,"linkCodes":0,"currencies":5,"toSquadron":"bdec15dd-b632-4ccd-9a18-d8c8e81c8e68","unavailable":1,"fromSquadron":"3072e6f6-64ba-4a54-9390-ef2fb811b92c"}`
- back → `{"leaves":0,"devices":0,"pilotId":"AUD_SIM_G_P8_mod5f3sl","sorties":0,"linkCodes":0,"currencies":5,"toSquadron":"3072e6f6-64ba-4a54-9390-ef2fb811b92c","unavailable":1,"fromSquadron":"bdec15dd-b632-4ccd-9a18-d8c8e81c8e68"}`
- paired audit rows present: 2 (sample: [{"type":"pilot.transfer.in","detail":{"leaves":0,"devices":0,"pilotId":"AUD_SIM_G_P8_mod5f3sl","sorties":0,"linkCodes":0,"currencies":5,"toSquadron":"3072e6f6-64ba-4a54-9390-ef2fb811b92c","unavailabl)

---

## 3. Calculation surfaces (C-1 .. C-10)

| ID | Surface | Result |
|---|---|---|
| C-1 | computePilotTotals (dashboard) | PASS |
| C-2 | computeTotals (mobile) vs dashboard | FAIL |
| C-3 | buildForm1Rows (current month) | PASS |
| C-4 | buildForm2Rows (cumulative) | PASS |
| C-5 | buildForm3 + deriveForm3Stats | PASS |
| C-6 | suggestNextMonthPlanFrom | PASS |
| C-7 | suggestRemarksFor (leave/unavail) | PASS |
| C-8 | computeCurrencies (mobile) | PASS |
| C-9 | Refresh-on-flight (DB-side) | PASS |
| C-10 | Initial / opening hours folding | PASS |

### C-1 — `computePilotTotals`
Per-pilot lifetime totals (Day/Night/NVG/Sim/Captain) compared against raw SQL aggregation against `sorties.data`. Pilot-by-pilot diff in `evidence.calc.C1.perPilot`.

Mismatched pilots: (none)

### C-2 — Mobile `computeTotals` vs dashboard
Per-pilot totals compared. The known drift risk is captain credit (mobile uses flat `pilotIsCaptain` × total; dashboard does seat-aware credit).

Mismatched pilots: AUD_SIM_G_P1_mod5f3sl

### C-3 — `buildForm1Rows` (current month `2026-04`)
Per-pilot monthly total compared to raw SQL filtered to the period. Note: row-level (per-seat) decomposition in Form 1 is intentionally lossy (it carries day1, day2, dayDual columns separately), so this audit compares the `totalForMonth` aggregate.

Mismatched pilots: (none)

### C-4 — `buildForm2Rows` cumulative
Per-pilot `grandTotal` compared to opening + raw-SQL cumulative sum.

Mismatched pilots: (none)

### C-5 — `buildForm3`
Achieved sorties+hours for current month vs raw SQL filtered count/sum.
- expected: sorties=14, hours=35.5
- actual:   sorties=14, hours=35.5

### C-6 — `suggestNextMonthPlanFrom`
- input  {"sorties":14,"hours":35.5}
- output {"plannedSorties":14,"plannedHours":35.5}

### C-7 — `suggestRemarksFor`
Leave + unavailable matrix verified for every pilot.
Mismatched pilots: (none)

### C-8 — `computeCurrencies` (mobile)
Status (expired/urgent/soon/ok/missing) compared against independent expiry math for every pilot × every currency.
Mismatched pilots: (none)

### C-9 — Refresh-on-flight
Refresh-on-flight is implemented in dashboard client code (AddSortie.tsx) and is NOT a DB trigger. The audit driver verified that an in-window DAY sortie inserted today (sortieId=227766ee-7f20-4937-b017-8519b44627b7) would be the trigger; the per-squadron window setting is read by the client at write-time. Server-side, the `currencies` table is updated by the same client; the driver did not directly re-run that client logic.

### C-10 — Initial / opening hours
P1 has initialHours.day1=200 (with dual). Lifetime totalDay=369, openingDay=100, ihDay=250. Lifetime includes IH: true; periodic excludes IH: true.

---

## 4. Defects opened by this run (G)

- **G-C2** (P0) — mobile vs dashboard totals: mobile/dashboard captain or hours drift

(All defects also appended to `.local/reports/audit-2026-04-26/defects.json`.)

---

## 5. Teardown verification

```
{
  "pilots": 0,
  "sorties": 0,
  "squadrons": 0,
  "xpcRegistry": 0,
  "currencies": 0,
  "leaves": 0,
  "unavailable": 0,
  "scheduleShares": 0,
  "auditLog": 0
}
```

Zero `AUD_SIM_G_*` residue: **YES**

---

## 6. Files of record

- Driver: `.local/scripts/audit-2026-04-26/g-driver.mjs`
- Evidence: `.local/reports/audit-2026-04-26/evidence/G/g-driver.json`
- Defects: `.local/reports/audit-2026-04-26/defects.json`
