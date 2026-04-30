# Historical Import — CSV column reference

The Historical Import screen accepts two CSV files exported from the legacy
**SqDn App 21.10.16**. Map the legacy columns to the names below, save as
UTF-8 CSV, and drop both files onto the Historical Import page.

Both files use a header row. Field order does not matter — columns are
matched by name. Empty optional cells are accepted.

## Pilot CSV

Required columns: `id`, `name`, `rank`.

| Column          | Type    | Notes                                                              |
|-----------------|---------|--------------------------------------------------------------------|
| `id`            | string  | Stable pilot id (e.g. `P001`). Must be unique within the file.     |
| `name`          | string  | English name.                                                      |
| `arabicName`    | string  | Arabic name. Optional.                                             |
| `rank`          | string  | e.g. `Maj`, `Capt`, `1st Lt`, `Lt Col`.                            |
| `phone`         | string  | Optional.                                                          |
| `address`       | string  | Optional.                                                          |
| `unit`          | enum    | One of `SQDN`, `HQ Attached`, `Other`, `UH-60M`, `UH-60AIL`, `Both`, `RCN`. Defaults to `SQDN`. |
| `available`     | bool    | `true`/`false`/`1`/`0`. Defaults to `true`.                        |
| `openingDay`    | number  | Opening balance — day hours.                                       |
| `openingNight`  | number  | Opening balance — night hours.                                     |
| `openingNvg`    | number  | Opening balance — NVG hours.                                       |
| `monthDay`      | number  | Current-month day hours.                                           |
| `monthNight`    | number  | Current-month night hours.                                         |
| `monthNvg`      | number  | Current-month NVG hours.                                           |
| `monthSim`      | number  | Current-month sim hours.                                           |
| `monthCaptain`  | number  | Current-month PIC hours.                                           |
| `totalDay`      | number  | Lifetime day hours.                                                |
| `totalNight`    | number  | Lifetime night hours.                                              |
| `totalNvg`      | number  | Lifetime NVG hours.                                                |
| `totalSim`      | number  | Lifetime sim hours.                                                |
| `totalCaptain`  | number  | Lifetime PIC hours.                                                |
| `expiryDay`     | YYYY-MM-DD | Day-currency expiry.                                            |
| `expiryNight`   | YYYY-MM-DD | Night-currency expiry.                                          |
| `expiryIrt`     | YYYY-MM-DD | IRT expiry.                                                     |
| `expiryMedical` | YYYY-MM-DD | Medical expiry.                                                 |
| `expirySim`     | YYYY-MM-DD | Sim-currency expiry.                                            |
| `doctorNote`    | string  | Optional free text.                                                |

## Sortie CSV

Required columns: `id`, `date`, `pilotId`, `acType`. `date` must be `YYYY-MM-DD`.

| Column        | Type       | Notes                                                          |
|---------------|------------|----------------------------------------------------------------|
| `id`          | string     | Stable sortie id (e.g. `S10001`).                              |
| `date`        | YYYY-MM-DD | Sortie date.                                                   |
| `acType`      | string     | e.g. `UH-60M`, `UH-60L`, `UH-60AIL`, `AS332`.                  |
| `acNumber`    | string     | Tail / a/c number.                                             |
| `pilotId`     | string     | Must match a `id` in the pilot file (or an existing pilot).    |
| `coPilotId`   | string     | Optional.                                                      |
| `sortieType`  | string     | e.g. `Training`, `Mission`, `Check Ride`, `FCF`, `Transport`.  |
| `name`        | string     | Sortie / flight name (e.g. `NAV`, `EMER`, `MSN NVG`).          |
| `day1`        | number     | Day, 1st PLT hours.                                            |
| `day2`        | number     | Day, 2nd PLT hours.                                            |
| `dayDual`     | number     | Day dual hours.                                                |
| `night1`      | number     | Night, 1st PLT hours.                                          |
| `night2`      | number     | Night, 2nd PLT hours.                                          |
| `nightDual`   | number     | Night dual hours.                                              |
| `nvg`         | number     | NVG hours.                                                     |
| `sim`         | number     | Sim hours.                                                     |
| `actual`      | number     | Total flight time for the row.                                 |

## Notes

- All accepted rows for both files are written in a single batch each.
  If any row in a batch is rejected by the database, the whole batch is
  rolled back so opening balances cannot be partially imported.
- Every imported row is tagged with `imported = true` and an
  `importedAt` timestamp. The Audit Log records the import as
  `import.history.ok` with the totals.
- Re-running the import with the same `id`s upserts (overwrites) the
  existing rows. Rows already entered through the UI keep their original
  `imported = false` flag unless intentionally overwritten.
