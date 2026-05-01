// install-profile — small bootstrap state describing which install
// profile the local backend is running. Drives whether the dashboard
// behaves as a hub front-end (talking to /api/internal/*) or as an
// aggregator front-end (talking to /api/aggregate/*).
//
// The single source of truth on the server is `GET /api/healthz`,
// which returns `{ status: "ok", installProfile: <profile> }`. We
// fetch it once at mount, persist the value into the API helper
// module (so subsequent calls in `internal-migration.ts` route to
// the right path), and expose the value as React context so the
// rest of the app can gate UI off it without re-fetching.
//
// Profiles:
//   - `hub`             — local Postgres, /api/internal/* + /api/peer/*
//   - `aggregator-wing` — fan-out reads, /api/aggregate/*
//   - `aggregator-base` — fan-out reads, /api/aggregate/*
//   - `viewer`          — no backend; the dashboard runs against a
//                          remote hub/aggregator
//
// We default to `hub` if the call fails — this matches the server
// default in `resolveInstallProfile()` and keeps existing behaviour
// for users who haven't set the env var.

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  getActiveInstallProfile,
  getInternalApiHealthUrl,
  setActiveInstallProfile,
} from "./internal-migration";

export type InstallProfile =
  | "hub"
  | "aggregator-wing"
  | "aggregator-base"
  | "viewer";

const VALID_PROFILES: ReadonlyArray<InstallProfile> = [
  "hub",
  "aggregator-wing",
  "aggregator-base",
  "viewer",
];

export function isAggregatorProfile(p: InstallProfile): boolean {
  return p === "aggregator-wing" || p === "aggregator-base";
}

export function parseInstallProfile(v: unknown): InstallProfile | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  return (VALID_PROFILES as ReadonlyArray<string>).includes(trimmed)
    ? (trimmed as InstallProfile)
    : null;
}

interface InstallProfileState {
  profile: InstallProfile;
  loaded: boolean;
  error: string | null;
}

const Ctx = createContext<InstallProfileState | null>(null);

/**
 * One-shot fetch of `/api/healthz` → installProfile. Exported for
 * tests so they can stub the network and assert resolution.
 */
export async function fetchInstallProfileFromHealthz(): Promise<{
  profile: InstallProfile;
  error: string | null;
}> {
  const url = getInternalApiHealthUrl();
  if (!url) {
    // No internal API configured (e.g. browser served straight off
    // a published web build with no proxy). Stay on the hub default
    // so existing UI continues to work.
    return { profile: "hub", error: null };
  }
  try {
    const res = await fetch(url, { method: "GET", cache: "no-store" });
    if (!res.ok) {
      return { profile: "hub", error: `http_${res.status}` };
    }
    const body = (await res.json()) as { installProfile?: unknown };
    const parsed = parseInstallProfile(body?.installProfile);
    if (!parsed) {
      // healthz answered but didn't carry the field — older backend.
      return { profile: "hub", error: null };
    }
    return { profile: parsed, error: null };
  } catch (e) {
    return {
      profile: "hub",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

interface ProviderProps {
  children: ReactNode;
  /**
   * Tests bypass the network probe by passing `initialProfile`. In
   * production this is left undefined so the provider does the real
   * `/api/healthz` round-trip.
   */
  initialProfile?: InstallProfile;
}

export function InstallProfileProvider({
  children,
  initialProfile,
}: ProviderProps) {
  // Seed from the module-level value so a re-mounted provider keeps
  // the resolved profile rather than flashing back to "hub". When a
  // test passes `initialProfile`, we also push it into the active
  // register synchronously so helpers (`fetchAggregateRows`, etc.)
  // see the right profile on the very first render — without this
  // they'd race against the `useEffect` below and route the first
  // call to `/api/internal/*`.
  const seed = initialProfile ?? getActiveInstallProfile();
  if (initialProfile !== undefined) {
    setActiveInstallProfile(initialProfile);
  }
  const [profile, setProfile] = useState<InstallProfile>(seed);
  const [loaded, setLoaded] = useState<boolean>(initialProfile !== undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialProfile !== undefined) {
      setActiveInstallProfile(initialProfile);
      setLoaded(true);
      return;
    }
    let cancelled = false;
    void (async () => {
      const r = await fetchInstallProfileFromHealthz();
      if (cancelled) return;
      setActiveInstallProfile(r.profile);
      setProfile(r.profile);
      setError(r.error);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [initialProfile]);

  const value = useMemo<InstallProfileState>(
    () => ({ profile, loaded, error }),
    [profile, loaded, error],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useInstallProfile(): InstallProfileState {
  const v = useContext(Ctx);
  if (v) return v;
  // Defensive fallback for components rendered outside the provider
  // (e.g. legacy stand-alone tests). Mirrors the server default.
  return {
    profile: getActiveInstallProfile(),
    loaded: true,
    error: null,
  };
}

export function useIsAggregator(): boolean {
  return isAggregatorProfile(useInstallProfile().profile);
}
