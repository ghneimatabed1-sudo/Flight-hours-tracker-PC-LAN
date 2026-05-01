// Matrix cell catalogue for the role × profile × scenario sweep
// (task #361). Mirrors the cells the integration tests in
// `tests/multi-pc-cross.test.ts`, `tests/sorties-writes-gate.test.ts`
// and `tests/lan-read-scope-routes.test.ts` already pin at the route
// level — the Playwright pass re-runs them through a real browser
// and captures per-cell screenshot, console log and network log.

import type { InstallProfile } from "../../../api-server/src/lib/install-profile";
import type { Actor } from "./matrix-server";

/**
 * One probe = one explicit fetch the spec issues after login. Used to
 * capture per-cell network evidence for role-allowed and role-blocked
 * endpoints. The expectedStatus field is documentation-only (we
 * record whatever the server returned, not assert on it — the matrix
 * is evidence, not a pass/fail gate).
 */
export interface ProbeSpec {
  label: string;
  method: "GET" | "POST";
  /** Path relative to the matrix server URL, e.g. "/api/internal/pilots". */
  path: string;
  /** JSON body for POST probes. */
  body?: Record<string, unknown>;
  /** Whether the role is expected to be allowed (informational). */
  expected: "allowed" | "blocked" | "404";
}

export interface MatrixCell {
  profile: InstallProfile;
  /** Slug used for the evidence directory. Lowercase, no spaces. */
  roleSlug: string;
  /** Display label written into the evidence README. */
  roleLabel: string;
  actor: Actor;
  probes: ProbeSpec[];
}

const SQUADRON_A = "00000000-0000-0000-0000-000000000a01";
const WING_7 = "00000000-0000-0000-0000-0000000077w7";
const BASE_3 = "00000000-0000-0000-0000-000000000b03";

function actor(
  username: string,
  role: string,
  scope: { squadronId?: string | null; wingId?: string | null; baseId?: string | null } = {},
): Actor {
  return {
    username,
    displayName: username,
    role,
    squadronId: scope.squadronId ?? SQUADRON_A,
    wingId: scope.wingId ?? null,
    baseId: scope.baseId ?? null,
  };
}

// ── Endpoint banks ─────────────────────────────────────────────────

const HUB_PROBES_RW: ProbeSpec[] = [
  { label: "healthz", method: "GET", path: "/api/healthz", expected: "allowed" },
  { label: "auth.me", method: "GET", path: "/api/internal/auth/lan/me", expected: "allowed" },
  { label: "pilots.list", method: "GET", path: "/api/internal/pilots", expected: "allowed" },
  { label: "squadrons.list", method: "GET", path: "/api/internal/squadrons", expected: "allowed" },
  { label: "audit.read", method: "GET", path: "/api/internal/audit-log", expected: "allowed" },
  { label: "peer-tokens.read", method: "GET", path: "/api/internal/peer-tokens", expected: "allowed" },
  {
    label: "pilots.upsert",
    method: "POST",
    path: "/api/internal/pilots/upsert",
    body: {
      id: "00000000-0000-0000-0000-000000000999",
      squadron_id: SQUADRON_A,
      name: "Probe Pilot",
      rank: "Capt",
      phone: "",
      available: true,
    },
    expected: "allowed",
  },
];

const HUB_PROBES_OPS: ProbeSpec[] = [
  { label: "healthz", method: "GET", path: "/api/healthz", expected: "allowed" },
  { label: "auth.me", method: "GET", path: "/api/internal/auth/lan/me", expected: "allowed" },
  { label: "pilots.list", method: "GET", path: "/api/internal/pilots", expected: "allowed" },
  { label: "squadrons.list", method: "GET", path: "/api/internal/squadrons", expected: "allowed" },
  { label: "audit.read", method: "GET", path: "/api/internal/audit-log", expected: "allowed" },
  { label: "peer-tokens.read", method: "GET", path: "/api/internal/peer-tokens", expected: "blocked" },
  {
    label: "pilots.upsert",
    method: "POST",
    path: "/api/internal/pilots/upsert",
    body: {
      id: "00000000-0000-0000-0000-000000000999",
      squadron_id: SQUADRON_A,
      name: "Probe Pilot",
      rank: "Capt",
      phone: "",
      available: true,
    },
    expected: "allowed",
  },
];

const HUB_PROBES_READONLY_COMMANDER: ProbeSpec[] = [
  { label: "healthz", method: "GET", path: "/api/healthz", expected: "allowed" },
  { label: "auth.me", method: "GET", path: "/api/internal/auth/lan/me", expected: "allowed" },
  { label: "pilots.list", method: "GET", path: "/api/internal/pilots", expected: "allowed" },
  { label: "squadrons.list", method: "GET", path: "/api/internal/squadrons", expected: "allowed" },
  { label: "peer-tokens.read", method: "GET", path: "/api/internal/peer-tokens", expected: "blocked" },
  {
    label: "pilots.upsert",
    method: "POST",
    path: "/api/internal/pilots/upsert",
    body: {
      id: "00000000-0000-0000-0000-000000000999",
      squadron_id: SQUADRON_A,
      name: "Probe Pilot",
      rank: "Capt",
      phone: "",
      available: true,
    },
    expected: "blocked",
  },
];

function aggregatorProbes(peersExpected: "allowed" | "blocked"): ProbeSpec[] {
  return [
    { label: "healthz", method: "GET", path: "/api/healthz", expected: "allowed" },
    { label: "auth.me", method: "GET", path: "/api/aggregate/auth/lan/me", expected: "allowed" },
    { label: "aggregate.peers", method: "GET", path: "/api/aggregate/peers", expected: peersExpected },
    { label: "aggregate.pilots", method: "GET", path: "/api/aggregate/pilots", expected: "allowed" },
    { label: "aggregate.sorties", method: "GET", path: "/api/aggregate/sorties", expected: "allowed" },
    { label: "aggregate.readiness", method: "GET", path: "/api/aggregate/readiness-summary", expected: "allowed" },
    { label: "internal.pilots (not mounted)", method: "GET", path: "/api/internal/pilots", expected: "404" },
    { label: "peer.pilots (not mounted)", method: "GET", path: "/api/peer/pilots", expected: "404" },
  ];
}

const VIEWER_PROBES: ProbeSpec[] = [
  { label: "healthz (no backend)", method: "GET", path: "/api/healthz", expected: "404" },
  { label: "auth.me (no backend)", method: "GET", path: "/api/internal/auth/lan/me", expected: "404" },
  { label: "pilots.list (no backend)", method: "GET", path: "/api/internal/pilots", expected: "404" },
  { label: "aggregate.peers (no backend)", method: "GET", path: "/api/aggregate/peers", expected: "404" },
];

// ── Cells ──────────────────────────────────────────────────────────

export const MATRIX_CELLS: MatrixCell[] = [
  // ── Hub PC ───────────────────────────────────────────────────────
  {
    profile: "hub",
    roleSlug: "super_admin",
    roleLabel: "Super Admin",
    actor: actor("hub-super", "super_admin", { wingId: WING_7, baseId: BASE_3 }),
    probes: HUB_PROBES_RW,
  },
  {
    profile: "hub",
    roleSlug: "admin",
    roleLabel: "Admin",
    actor: actor("hub-admin", "admin", { wingId: WING_7, baseId: BASE_3 }),
    probes: HUB_PROBES_RW,
  },
  {
    profile: "hub",
    roleSlug: "ops",
    roleLabel: "Ops",
    actor: actor("hub-ops", "ops"),
    probes: HUB_PROBES_OPS,
  },
  {
    profile: "hub",
    roleSlug: "commander_squadron",
    roleLabel: "Commander · Squadron",
    actor: actor("hub-csq", "commander_squadron"),
    probes: HUB_PROBES_READONLY_COMMANDER,
  },

  // ── Aggregator-Wing PC ──────────────────────────────────────────
  {
    profile: "aggregator-wing",
    roleSlug: "super_admin",
    roleLabel: "Super Admin",
    actor: actor("wing-super", "super_admin", { wingId: WING_7 }),
    probes: aggregatorProbes("allowed"),
  },
  {
    profile: "aggregator-wing",
    roleSlug: "commander_wing",
    roleLabel: "Commander · Wing",
    actor: actor("wing-cwg", "commander_wing", { wingId: WING_7 }),
    probes: aggregatorProbes("blocked"),
  },

  // ── Aggregator-Base PC ──────────────────────────────────────────
  {
    profile: "aggregator-base",
    roleSlug: "super_admin",
    roleLabel: "Super Admin",
    actor: actor("base-super", "super_admin", { baseId: BASE_3 }),
    probes: aggregatorProbes("allowed"),
  },
  {
    profile: "aggregator-base",
    roleSlug: "commander_base",
    roleLabel: "Commander · Base",
    actor: actor("base-cba", "commander_base", { baseId: BASE_3 }),
    probes: aggregatorProbes("blocked"),
  },

  // ── Viewer PC ───────────────────────────────────────────────────
  {
    profile: "viewer",
    roleSlug: "commander_squadron",
    roleLabel: "Commander · Squadron",
    actor: actor("viewer-csq", "commander_squadron"),
    probes: VIEWER_PROBES,
  },
  {
    profile: "viewer",
    roleSlug: "flight_commander",
    roleLabel: "Flight Commander",
    actor: actor("viewer-fcom", "flight_commander"),
    probes: VIEWER_PROBES,
  },
  {
    profile: "viewer",
    roleSlug: "ops",
    roleLabel: "Ops",
    actor: actor("viewer-ops", "ops"),
    probes: VIEWER_PROBES,
  },
];
