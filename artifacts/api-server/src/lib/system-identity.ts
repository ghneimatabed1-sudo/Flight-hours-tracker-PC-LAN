import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { timingSafeEqual } from "node:crypto";

/**
 * "System identity" token used by non-human callers (PowerShell
 * scheduled tasks like `verify-backup.ps1`) to authenticate against
 * the api-server without having a logged-in human session.
 *
 * The token is a long random string written ONCE at install time into
 *
 *   PROGRAMDATA\HawkEye\system-identity.token       (Windows)
 *   $HAWK_SYSTEM_IDENTITY_TOKEN_FILE                (Linux/dev)
 *
 * by `aggregator-first-time-setup.ps1` / `first-time-setup.ps1` and
 * read back by both:
 *
 *  - the api-server, which exposes it through
 *    `getExpectedSystemIdentityToken()` so route handlers can compare
 *    incoming `x-hawk-system-identity` headers,
 *  - the PowerShell scripts, which read the same file and send it as
 *    a header.
 *
 * Why a separate token from `INTERNAL_WRITE_SECRET`:
 *   `INTERNAL_WRITE_SECRET` is a coarse "any LAN client may write"
 *   gate. The system-identity token is specifically an attestation
 *   that "this came from a non-human host process" — the audit-log
 *   row is then attributed to actor `system:<role>` instead of a
 *   real LAN user. Mixing the two would let any web client forge
 *   non-human audit rows, which defeats the audit trail.
 */

// Canonical env names (preferred). The HAWKEYE_* aliases below are
// accepted as a legacy fallback so installers and CI configurations
// that already write the older names continue to work. Resolution
// order: canonical → legacy alias → file path.
const ENV_TOKEN_VAR = "HAWK_SYSTEM_IDENTITY_TOKEN";
const ENV_TOKEN_FILE_VAR = "HAWK_SYSTEM_IDENTITY_TOKEN_FILE";
const ENV_TOKEN_VAR_LEGACY = "HAWKEYE_SYSTEM_IDENTITY_TOKEN";
const ENV_TOKEN_FILE_VAR_LEGACY = "HAWKEYE_SYSTEM_IDENTITY_TOKEN_FILE";
const HEADER_NAME = "x-hawk-system-identity";

let cachedToken: string | null | undefined;

function defaultTokenPath(): string | null {
  if (process.platform === "win32") {
    const programData = process.env.PROGRAMDATA;
    if (programData && programData.trim() !== "") {
      return join(programData, "HawkEye", "system-identity.token");
    }
    return null;
  }
  // Non-Windows fallback for developers — mirrors the same path
  // semantics under /var if the operator hasn't pinned an explicit
  // env var.
  return "/var/lib/hawkeye/system-identity.token";
}

function readTokenFile(p: string): string | null {
  try {
    if (!isAbsolute(p) || !existsSync(p)) return null;
    const raw = readFileSync(p, "utf8");
    const trimmed = raw.replace(/\s+/g, "").trim();
    return trimmed === "" ? null : trimmed;
  } catch {
    return null;
  }
}

/**
 * Returns the expected system-identity token. Resolution order:
 *   1. `HAWK_SYSTEM_IDENTITY_TOKEN` env var (canonical),
 *   2. `HAWKEYE_SYSTEM_IDENTITY_TOKEN` env var (legacy alias),
 *   3. file at `HAWK_SYSTEM_IDENTITY_TOKEN_FILE`,
 *   4. file at `HAWKEYE_SYSTEM_IDENTITY_TOKEN_FILE` (legacy alias),
 *   5. file at the OS default install path.
 *
 * The legacy aliases mirror what the older PowerShell installers and
 * the verify-backup script accept, so an operator who set the older
 * name on the host won't be silently shut out when this artifact rolls
 * out the canonical name.
 *
 * Returns `null` when the install hasn't been bootstrapped yet — in
 * that case the caller MUST refuse the request rather than fail-open.
 *
 * The result is memoised for the life of the process; tests that need
 * to flip the token at runtime should call `__resetSystemIdentityCache()`.
 */
export function getExpectedSystemIdentityToken(): string | null {
  if (cachedToken !== undefined) return cachedToken;
  const fromEnv = String(process.env[ENV_TOKEN_VAR] ?? "").trim();
  if (fromEnv !== "") {
    cachedToken = fromEnv;
    return cachedToken;
  }
  const fromEnvLegacy = String(
    process.env[ENV_TOKEN_VAR_LEGACY] ?? "",
  ).trim();
  if (fromEnvLegacy !== "") {
    cachedToken = fromEnvLegacy;
    return cachedToken;
  }
  const explicitFile = String(process.env[ENV_TOKEN_FILE_VAR] ?? "").trim();
  if (explicitFile !== "") {
    cachedToken = readTokenFile(explicitFile);
    return cachedToken;
  }
  const explicitFileLegacy = String(
    process.env[ENV_TOKEN_FILE_VAR_LEGACY] ?? "",
  ).trim();
  if (explicitFileLegacy !== "") {
    cachedToken = readTokenFile(explicitFileLegacy);
    return cachedToken;
  }
  const defaultPath = defaultTokenPath();
  cachedToken = defaultPath ? readTokenFile(defaultPath) : null;
  return cachedToken;
}

/**
 * Constant-time compare of `presented` against the expected token.
 * Returns false when either side is missing/empty so a misconfigured
 * install fails closed.
 */
export function verifySystemIdentityToken(
  presented: string | null | undefined,
): boolean {
  const expected = getExpectedSystemIdentityToken();
  if (!expected) return false;
  const got = String(presented ?? "").trim();
  if (!got) return false;
  // Constant-time compare requires equal-length buffers.
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(got, "utf8");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function getSystemIdentityHeaderName(): string {
  return HEADER_NAME;
}

/** Test-only escape hatch — re-reads the token on next access. */
export function __resetSystemIdentityCache(): void {
  cachedToken = undefined;
}
