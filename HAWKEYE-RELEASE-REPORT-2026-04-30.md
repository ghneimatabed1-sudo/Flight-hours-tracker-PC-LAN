# Hawk Eye — Release Verify Report (2026-04-30)

**Verdict:** GREEN — GO. Safe to copy this build to the USB stick.

- Started: 2026-04-30T21:25:22.505Z
- Finished: 2026-04-30T21:26:13.587Z
- Evidence: `release-evidence/2026-04-30/`
- Baseline: `scripts/src/release-evidence-baseline.json` (initialized)

## Summary

| Check | Status | Duration | Log |
| --- | --- | --- | --- |
| TypeScript typecheck (all workspace packages) | SKIP | — | — |
| Static check: no external URLs in dashboard bundle | PASS | 756ms | `release-evidence/2026-04-30/check-no-external-urls.log` |
| All in-process tests (pilot-dashboard suite) | SKIP | — | — |
| 3-process multi-PC test (real api-server processes) | SKIP | — | — |
| Matrix Playwright sweep (role × profile × probe) | PASS | 50.3s | `release-evidence/2026-04-30/matrix-playwright.log` |

## Matrix evidence diff

No drift from baseline. Every probe in this run matched the committed baseline status.

## Per-check details

### TypeScript typecheck (all workspace packages)

- Skipped via `HAWKEYE_RELEASE_SKIP_TYPECHECK=1`

### Static check: no external URLs in dashboard bundle

- Command: `pnpm run check:no-external-urls`
- Exit code: 0 (PASS)
- Duration: 756ms
- Log: `release-evidence/2026-04-30/check-no-external-urls.log`

### All in-process tests (pilot-dashboard suite)

- Skipped via `HAWKEYE_RELEASE_SKIP_IN_PROCESS_TESTS=1`

### 3-process multi-PC test (real api-server processes)

- Skipped via `HAWKEYE_RELEASE_SKIP_MULTI_PC_REAL_PROCESS=1`

### Matrix Playwright sweep (role × profile × probe)

- Command: `pnpm --filter @workspace/pilot-dashboard run test:matrix-playwright`
- Exit code: 0 (PASS)
- Duration: 50.3s
- Log: `release-evidence/2026-04-30/matrix-playwright.log`

## Recommended next action

Proceed with §7 of `OPERATOR-RUNBOOK.md` (Push an updated build via USB).
