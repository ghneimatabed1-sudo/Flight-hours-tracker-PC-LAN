import { pool } from "@workspace/db";
import { logger } from "./logger";

export type InstallProfile =
  | "hub"
  | "aggregator-wing"
  | "aggregator-base"
  | "viewer";

const ALL_PROFILES: readonly InstallProfile[] = [
  "hub",
  "aggregator-wing",
  "aggregator-base",
  "viewer",
] as const;

const DEFAULT_PROFILE: InstallProfile = "hub";

/**
 * Resolve INSTALL_PROFILE. Defaults to `hub` (today's only deployed
 * mode); throws on unknown values rather than silently exposing the
 * wrong route surface.
 */
export function resolveInstallProfile(
  raw: string | undefined = process.env["INSTALL_PROFILE"],
): InstallProfile {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "") return DEFAULT_PROFILE;
  if ((ALL_PROFILES as readonly string[]).includes(v)) {
    return v as InstallProfile;
  }
  throw new Error(
    `Invalid INSTALL_PROFILE value: "${raw}". `
      + `Expected one of: ${ALL_PROFILES.join(", ")}.`,
  );
}

/**
 * Pin the first-boot profile in `install_profile_meta` and record the
 * most recent profile observed. Returns the canonical first-boot row
 * so the caller can detect drift.
 */
export async function recordInstallProfile(
  current: InstallProfile,
): Promise<{ profile: InstallProfile; firstBootedAt: Date }> {
  const res = await pool.query<{
    profile: string;
    first_booted_at: Date;
  }>(
    `
    insert into install_profile_meta (id, profile, first_booted_at, last_seen_profile, last_seen_at)
    values (1, $1, now(), $1, now())
    on conflict (id) do update
      set last_seen_profile = excluded.last_seen_profile,
          last_seen_at      = now()
    returning profile, first_booted_at
    `,
    [current],
  );
  const row = res.rows[0]!;
  if (row.profile !== current) {
    logger.warn(
      { firstBootedProfile: row.profile, currentProfile: current },
      "INSTALL_PROFILE changed since first boot — original profile is canonical for this PC",
    );
  }
  return { profile: row.profile as InstallProfile, firstBootedAt: row.first_booted_at };
}

export function isAggregatorProfile(p: InstallProfile): boolean {
  return p === "aggregator-wing" || p === "aggregator-base";
}

export const ALL_INSTALL_PROFILES = ALL_PROFILES;

let activeProfile: InstallProfile | null = null;

export function setActiveInstallProfile(profile: InstallProfile): void {
  activeProfile = profile;
}

export function getActiveInstallProfile(): InstallProfile {
  if (activeProfile !== null) return activeProfile;
  activeProfile = resolveInstallProfile();
  return activeProfile;
}

export function _resetActiveInstallProfileForTests(): void {
  activeProfile = null;
}
