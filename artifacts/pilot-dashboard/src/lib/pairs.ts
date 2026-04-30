// Pair-link layer (task #138).
//
// Source of truth for cross-PC routing. Replaces implicit registry-
// heartbeat discovery with EXPLICIT, persistent pair links.
// Two surfaces both write here:
//   • Self-service handshake: PC A shows a 6-digit code, PC B redeems it.
//   • Super-Admin Connection Map: god-mode click-to-pair page.
//
// Schema lives in 0031_xpc_pair_links.sql. RLS keeps an operator scoped
// to pairs they participate in; super_admin sees everything.

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { supabase, supabaseConfigured } from "./supabase";
import { getLocalPcId } from "./cross-pc";
import {
  fetchInternalXpcPairAudit,
  fetchInternalXpcPairCode,
  fetchInternalXpcPairs,
  isLanSessionLoginEnabled,
  postInternalXpcPairAdminBulk,
  postInternalXpcPairAdminCreate,
  postInternalXpcPairAdminResetPc,
  postInternalXpcPairAdminSetPermanent,
  postInternalXpcPairAdminSweep,
  postInternalXpcPairIssueCode,
  postInternalXpcPairRedeem,
  postInternalXpcPairRevoke,
} from "./internal-migration";

const live = () => supabaseConfigured && supabase !== null;

export type PairKind =
  | "in_squadron"
  | "sqn_to_wing"
  | "wing_to_base"
  | "cross_squadron_ops"
  | "peer_flight"
  | "peer_sqn"
  | "peer_wing"
  | "peer_base";

export type PcTier = "flight" | "squadron" | "wing" | "base" | "hq";

export interface PairLink {
  aPcId: string;
  bPcId: string;
  aTier: PcTier;
  bTier: PcTier;
  aSquadron: string | null;
  bSquadron: string | null;
  aUserDisplay: string | null;
  bUserDisplay: string | null;
  aUserSeat: string | null;
  bUserSeat: string | null;
  kind: PairKind;
  pairedAt: string;
  pairedByLabel: string | null;
  justification: string | null;
  expiresAt: string | null;
  permanent: boolean;
  lastActivityAt: string;
  revokedAt: string | null;
}

export interface PairCode {
  code: string;
  hostPcId: string;
  hostTier: PcTier;
  hostSquadron: string | null;
  hostUserDisplay: string | null;
  hostUserSeat: string | null;
  expiresAt: string;
  consumedAt: string | null;
}

export interface PairAuditEntry {
  id: string;
  action: string;
  targetPcA: string | null;
  targetPcB: string | null;
  byUserLabel: string | null;
  kind: string | null;
  justification: string | null;
  detail: Record<string, unknown> | null;
  at: string;
}

// ── Allowed-pairing matrix (mirror of xpc_validate_pairing) ──────────
// Seat-string canonicaliser. UIs and integrations write the Sqn Cmdr
// seat as "Sqn Cmdr", "SqnCmdr", "sqncmdr", "SQN_CMDR" — all of which
// mean the same thing. Strip every non-alphanumeric and lowercase so
// the matrix sees a single canonical form. Mirrors the SQL helper
// `xpc_canon_seat()` in 0038_xpc_pair_links.sql.
export function canonSeat(seat: string | null | undefined): string | null {
  if (seat == null) return null;
  return seat.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Resolves to a kind, or null when forbidden without super-admin override.
export function resolvePairKind(args: {
  aTier: PcTier;
  bTier: PcTier;
  aSquadron: string | null;
  bSquadron: string | null;
  /** Optional seat/role hint ("Ops" / "SqnCmdr" / "Flight" / "Wing" / "Base").
   *  Two SqnCmdr seats in different squadrons (super-admin override)
   *  resolve to peer_sqn instead of cross_squadron_ops. */
  aSeat?: string | null;
  bSeat?: string | null;
  superAdmin: boolean;
  justification?: string | null;
  expiresAt?: string | null;
  /** Explicit peer_sqn intent set by super-admin in the Connection
   *  Map when registry rows lack seat metadata. Without this hint
   *  cross-squadron squadron-tier pairs MUST go through the
   *  justification+expiry escape hatch. */
  kindHint?: PairKind | null;
}): PairKind | null {
  const { aTier, bTier, aSquadron, bSquadron, aSeat, bSeat, superAdmin, justification, expiresAt } = args;
  const same = aSquadron && bSquadron
    && aSquadron.toLowerCase() === bSquadron.toLowerCase();
  const bothCmdr = canonSeat(aSeat) === "sqncmdr"
                && canonSeat(bSeat) === "sqncmdr";
  if (aTier === bTier) {
    if (aTier === "flight") return "peer_flight";
    if (aTier === "squadron") {
      if (same) return "in_squadron";
      // peer_sqn: only when seats canonicalise to SqnCmdr↔SqnCmdr OR
      // the super-admin EXPLICITLY hints peer_sqn from the Connection
      // Map. Without an explicit hint, the fallback is the
      // cross_squadron_ops escape hatch (justification + expiry).
      if (superAdmin && (bothCmdr || args.kindHint === "peer_sqn")) {
        return "peer_sqn";
      }
      if (superAdmin && justification && justification.length >= 8 && expiresAt) {
        return "cross_squadron_ops";
      }
      return null;
    }
    if (aTier === "wing") return "peer_wing";
    if (aTier === "base") return superAdmin ? "peer_base" : null;
    return null;
  }
  const pair = `${aTier}-${bTier}`;
  if (pair === "flight-squadron" || pair === "squadron-flight") return "in_squadron";
  if (pair === "squadron-wing"   || pair === "wing-squadron")   return "sqn_to_wing";
  if (pair === "wing-base"       || pair === "base-wing")       return "wing_to_base";
  return null;
}

// ── Row mapping (db snake → ts camel) ────────────────────────────────
type LinkRow = {
  a_pc_id: string; b_pc_id: string;
  a_tier: string; b_tier: string;
  a_squadron: string | null; b_squadron: string | null;
  a_user_display: string | null; b_user_display: string | null;
  a_user_seat: string | null; b_user_seat: string | null;
  kind: string;
  paired_at: string;
  paired_by_label: string | null;
  justification: string | null;
  expires_at: string | null;
  permanent: boolean;
  last_activity_at: string;
  revoked_at: string | null;
};

function mapLink(r: LinkRow): PairLink {
  return {
    aPcId: r.a_pc_id, bPcId: r.b_pc_id,
    aTier: r.a_tier as PcTier, bTier: r.b_tier as PcTier,
    aSquadron: r.a_squadron, bSquadron: r.b_squadron,
    aUserDisplay: r.a_user_display, bUserDisplay: r.b_user_display,
    aUserSeat: r.a_user_seat, bUserSeat: r.b_user_seat,
    kind: r.kind as PairKind,
    pairedAt: r.paired_at,
    pairedByLabel: r.paired_by_label,
    justification: r.justification,
    expiresAt: r.expires_at,
    permanent: r.permanent,
    lastActivityAt: r.last_activity_at,
    revokedAt: r.revoked_at,
  };
}

function canonicalOrder<T extends { pcId: string }>(a: T & { tier: PcTier; squadron: string | null; userDisplay: string | null; userSeat: string | null }, b: T & { tier: PcTier; squadron: string | null; userDisplay: string | null; userSeat: string | null }) {
  return a.pcId < b.pcId ? { a, b } : { a: b, b: a };
}

// ── Code generation / redeem ─────────────────────────────────────────
function generateCode(): string {
  // 6 digits, presented as XX-YY-ZZ for readability.
  const n = Math.floor(100000 + Math.random() * 900000);
  return String(n);
}

export function formatCode(c: string): string {
  const s = c.replace(/\D/g, "");
  if (s.length !== 6) return c;
  return `${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}`;
}

export interface IssueCodeArgs {
  hostPcId: string;
  hostTier: PcTier;
  hostSquadron: string | null;
  hostUserDisplay: string | null;
  hostUserSeat: string | null;
  hostUserId: string | null;
}

export async function issuePairCode(args: IssueCodeArgs): Promise<PairCode> {
  if (isLanSessionLoginEnabled()) {
    const item = await postInternalXpcPairIssueCode({
      host_pc_id: args.hostPcId,
      host_tier: args.hostTier,
      host_squadron: args.hostSquadron,
      host_user_display: args.hostUserDisplay,
      host_user_seat: args.hostUserSeat,
      host_user_id: args.hostUserId,
    });
    if (!item) throw new Error("Could not issue pairing code.");
    return {
      code: String(item.code ?? ""),
      hostPcId: String(item.host_pc_id ?? ""),
      hostTier: String(item.host_tier ?? "squadron") as PcTier,
      hostSquadron: item.host_squadron ? String(item.host_squadron) : null,
      hostUserDisplay: item.host_user_display ? String(item.host_user_display) : null,
      hostUserSeat: item.host_user_seat ? String(item.host_user_seat) : null,
      expiresAt: String(item.expires_at ?? ""),
      consumedAt: item.consumed_at ? String(item.consumed_at) : null,
    };
  }
  if (!live() || !supabase) throw new Error("Supabase is not configured.");
  // Up to 3 attempts. Retries on:
  //   • 23505 (unique-violation) — extremely rare 6-digit collision in
  //     the 5-min window; just regenerate.
  //   • Any other transient error (PostgREST schema-cache miss right
  //     after a migration, momentary network blip, 503 from PgBouncer).
  // Each retry waits an exponential backoff (120ms, 360ms) so a brief
  // outage isn't surfaced to the operator as "Failed to issue pairing
  // code." when the very next attempt would have succeeded.
  let lastError: { code?: string; message?: string } | null = null;
  for (let i = 0; i < 3; i++) {
    const code = generateCode();
    const expires = new Date(Date.now() + 5 * 60_000).toISOString();
    const { data, error } = await supabase
      .from("xpc_pair_codes")
      .insert({
        code,
        host_pc_id: args.hostPcId,
        host_tier: args.hostTier,
        host_squadron: args.hostSquadron,
        host_user_id: args.hostUserId,
        host_user_display: args.hostUserDisplay,
        host_user_seat: args.hostUserSeat,
        expires_at: expires,
      })
      .select()
      .single();
    if (!error && data) {
      // (No client-side audit row for code issuance — the
      // xpc_pair_audit table has no INSERT policy for the
      // authenticated role, by design. The pair_created row written
      // by xpc_redeem_pair_code captures the meaningful event.)
      return {
        code: data.code,
        hostPcId: data.host_pc_id,
        hostTier: data.host_tier as PcTier,
        hostSquadron: data.host_squadron,
        hostUserDisplay: data.host_user_display,
        hostUserSeat: data.host_user_seat,
        expiresAt: data.expires_at,
        consumedAt: data.consumed_at,
      };
    }
    lastError = error ?? null;
    // RLS denial (42501) and matrix-violation are NOT transient — bail
    // out immediately so the operator sees the real reason.
    if (error?.code === "42501") {
      throw new Error(error.message);
    }
    // Backoff before the next attempt (skipped on the final iteration).
    if (i < 2) {
      await new Promise(r => setTimeout(r, 120 * Math.pow(3, i)));
    }
  }
  throw new Error(lastError?.message ?? "Could not issue a pairing code after 3 attempts. Try again in a few seconds.");
}

export async function lookupPairCode(rawCode: string): Promise<PairCode | null> {
  if (isLanSessionLoginEnabled()) {
    const code = rawCode.replace(/\D/g, "").slice(0, 6);
    const item = await fetchInternalXpcPairCode(code);
    if (!item) return null;
    return {
      code: String(item.code ?? ""),
      hostPcId: String(item.host_pc_id ?? ""),
      hostTier: String(item.host_tier ?? "squadron") as PcTier,
      hostSquadron: item.host_squadron ? String(item.host_squadron) : null,
      hostUserDisplay: item.host_user_display ? String(item.host_user_display) : null,
      hostUserSeat: item.host_user_seat ? String(item.host_user_seat) : null,
      expiresAt: String(item.expires_at ?? ""),
      consumedAt: item.consumed_at ? String(item.consumed_at) : null,
    };
  }
  if (!live() || !supabase) throw new Error("Supabase is not configured.");
  const code = rawCode.replace(/\D/g, "").slice(0, 6);
  const { data, error } = await supabase
    .from("xpc_pair_codes")
    .select("*")
    .eq("code", code)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return {
    code: data.code,
    hostPcId: data.host_pc_id,
    hostTier: data.host_tier as PcTier,
    hostSquadron: data.host_squadron,
    hostUserDisplay: data.host_user_display,
    hostUserSeat: data.host_user_seat,
    expiresAt: data.expires_at,
    consumedAt: data.consumed_at,
  };
}

export interface RedeemArgs {
  rawCode: string;
  joinerPcId: string;
  joinerTier: PcTier;
  joinerSquadron: string | null;
  joinerUserDisplay: string | null;
  joinerUserSeat: string | null;
  joinerUserId: string | null;
}

export interface RedeemResult {
  link: PairLink;
  hostPcId: string;
  hostUserDisplay: string | null;
  hostSquadron: string | null;
  hostTier: PcTier;
}

export async function redeemPairCode(args: RedeemArgs): Promise<RedeemResult> {
  if (isLanSessionLoginEnabled()) {
    const out = await postInternalXpcPairRedeem({
      code: args.rawCode,
      joiner_pc_id: args.joinerPcId,
      joiner_tier: args.joinerTier,
      joiner_squadron: args.joinerSquadron,
      joiner_user_display: args.joinerUserDisplay,
      joiner_user_seat: args.joinerUserSeat,
      joiner_user_id: args.joinerUserId,
    });
    const link = out?.item as { a_pc_id?: unknown; b_pc_id?: unknown; kind?: unknown } | undefined;
    const host = out?.host as {
      host_pc_id?: unknown;
      host_user_display?: unknown;
      host_squadron?: unknown;
      host_tier?: unknown;
    } | undefined;
    if (!link?.a_pc_id || !link?.b_pc_id) {
      throw new Error("Pair created but no row returned.");
    }
    const links = await fetchInternalXpcPairs({
      mine: args.joinerPcId,
      limit: 1000,
    });
    const match = (links ?? []).find((r) =>
      String(r.a_pc_id ?? "") === String(link.a_pc_id)
      && String(r.b_pc_id ?? "") === String(link.b_pc_id),
    );
    if (!match) throw new Error("Failed to load new pair.");
    return {
      link: mapLink(match as unknown as LinkRow),
      hostPcId: String(host?.host_pc_id ?? ""),
      hostUserDisplay: host?.host_user_display ? String(host.host_user_display) : null,
      hostSquadron: host?.host_squadron ? String(host.host_squadron) : null,
      hostTier: String(host?.host_tier ?? "squadron") as PcTier,
    };
  }
  if (!live() || !supabase) throw new Error("Supabase is not configured.");
  // Pre-flight: friendlier error messages than the RPC's raw exceptions.
  // The RPC re-validates everything server-side as authoritative.
  const code = await lookupPairCode(args.rawCode);
  if (!code) {
    throw new Error("Code not recognised — confirm both PCs are using the same backend (open the Diagnostic page on each).");
  }
  if (code.consumedAt) {
    throw new Error("Code already used — ask the other PC to generate a fresh one.");
  }
  if (new Date(code.expiresAt).getTime() < Date.now()) {
    throw new Error("Code expired — ask the other PC to generate a new one.");
  }
  if (code.hostPcId === args.joinerPcId) {
    throw new Error("That code was generated by THIS PC. Enter it on the other PC instead.");
  }
  // Atomic redeem: validates the matrix server-side, marks the code
  // consumed, and inserts the link in a single transaction. Bypasses
  // the codes-table UPDATE policy (which is super_admin only) by being
  // SECURITY DEFINER. The matrix trigger on xpc_pair_links also
  // re-validates as defence in depth.
  const { data, error } = await supabase.rpc("xpc_redeem_pair_code", {
    p_code: args.rawCode.replace(/\D/g, "").slice(0, 6),
    p_joiner_pc_id: args.joinerPcId,
    p_joiner_tier: args.joinerTier,
    p_joiner_squadron: args.joinerSquadron,
    p_joiner_user_display: args.joinerUserDisplay,
    p_joiner_user_seat: args.joinerUserSeat,
  });
  if (error) {
    // Translate the SQLSTATE-coded server errors into operator-facing copy.
    const msg = (error.message || "").toLowerCase();
    if (msg.includes("forbidden by matrix")) {
      throw new Error(
        `These two tiers (${code.hostTier} ↔ ${args.joinerTier}) cannot pair via the self-service code. Ask the super admin to create the link from the Connection Map.`,
      );
    }
    if (msg.includes("does not own pc_id")) {
      throw new Error("This PC isn't fully registered yet — wait ~30 s for the heartbeat and try again.");
    }
    throw new Error(error.message);
  }
  // RPC returns a single row {a_pc_id, b_pc_id, kind}.
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("Pair created but no row returned.");
  // Read the freshly-inserted link back so we hand the caller a fully
  // populated PairLink (the RPC only returns the canonical tuple).
  const { data: link, error: linkErr } = await supabase
    .from("xpc_pair_links")
    .select("*")
    .eq("a_pc_id", row.a_pc_id).eq("b_pc_id", row.b_pc_id)
    .single();
  if (linkErr || !link) throw new Error(linkErr?.message ?? "Failed to load new pair.");
  return {
    link: mapLink(link as LinkRow),
    hostPcId: code.hostPcId,
    hostUserDisplay: code.hostUserDisplay,
    hostSquadron: code.hostSquadron,
    hostTier: code.hostTier,
  };
}

// ── Admin / super_admin actions ──────────────────────────────────────
export interface AdminCreateArgs {
  a: { pcId: string; tier: PcTier; squadron: string | null; userDisplay: string | null; userSeat: string | null };
  b: { pcId: string; tier: PcTier; squadron: string | null; userDisplay: string | null; userSeat: string | null };
  byUserId: string | null;
  byUserLabel: string | null;
  justification?: string | null;
  expiresAt?: string | null;
  permanent?: boolean;
  /** Optional explicit kind hint. When set to "peer_sqn" the matrix
   *  will accept a different-squadron squadron-tier pair without seat
   *  data. Use only when the super-admin has personally verified that
   *  both PCs are SqnCmdr seats. */
  kindHint?: PairKind | null;
}

// All admin writes route through SECURITY DEFINER RPCs. RLS on
// xpc_pair_links forbids non-super_admin direct writes, so the RPCs
// are the only legal write path. Each RPC re-runs the matrix
// validation server-side and re-checks the super_admin gate inside
// its body — DEFINER privileges do not leak to the public.
export async function adminCreatePair(args: AdminCreateArgs): Promise<PairLink> {
  if (isLanSessionLoginEnabled()) {
    const resp = await postInternalXpcPairAdminCreate({
      a_pc_id: args.a.pcId,
      b_pc_id: args.b.pcId,
      a_tier: args.a.tier,
      b_tier: args.b.tier,
      a_squadron: args.a.squadron,
      b_squadron: args.b.squadron,
      a_user_seat: args.a.userSeat,
      b_user_seat: args.b.userSeat,
      a_user_display: args.a.userDisplay,
      b_user_display: args.b.userDisplay,
      justification: args.justification ?? null,
      expires_at: args.expiresAt ?? null,
      permanent: args.permanent ?? false,
      kind_hint: args.kindHint ?? null,
    });
    if (!resp.ok) throw new Error(resp.error);
    const links = await fetchInternalXpcPairs({ limit: 2000 });
    const aPcId = args.a.pcId < args.b.pcId ? args.a.pcId : args.b.pcId;
    const bPcId = args.a.pcId < args.b.pcId ? args.b.pcId : args.a.pcId;
    const link = (links ?? []).find((r) =>
      String(r.a_pc_id ?? "") === aPcId && String(r.b_pc_id ?? "") === bPcId,
    );
    if (!link) throw new Error("Failed to load new pair.");
    return mapLink(link as unknown as LinkRow);
  }
  if (!live() || !supabase) throw new Error("Supabase is not configured.");
  const { data, error } = await supabase.rpc("xpc_admin_create_pair", {
    p_a_pc_id: args.a.pcId, p_b_pc_id: args.b.pcId,
    p_a_tier: args.a.tier, p_b_tier: args.b.tier,
    p_a_squadron: args.a.squadron, p_b_squadron: args.b.squadron,
    p_a_seat: args.a.userSeat, p_b_seat: args.b.userSeat,
    p_a_user_display: args.a.userDisplay, p_b_user_display: args.b.userDisplay,
    p_justification: args.justification ?? null,
    p_expires_at: args.expiresAt ?? null,
    p_permanent: args.permanent ?? false,
    p_kind_hint: args.kindHint ?? null,
  });
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("Pair created but no row returned.");
  const { data: link, error: linkErr } = await supabase
    .from("xpc_pair_links").select("*")
    .eq("a_pc_id", row.a_pc_id).eq("b_pc_id", row.b_pc_id).single();
  if (linkErr || !link) throw new Error(linkErr?.message ?? "Failed to load new pair.");
  return mapLink(link as LinkRow);
}

export async function revokePair(aPcId: string, bPcId: string, reason: string, _byUserId: string | null): Promise<void> {
  if (isLanSessionLoginEnabled()) {
    const ord = aPcId < bPcId ? { a: aPcId, b: bPcId } : { a: bPcId, b: aPcId };
    const resp = await postInternalXpcPairRevoke({
      a_pc_id: ord.a,
      b_pc_id: ord.b,
      reason,
    });
    if (!resp.ok) throw new Error(resp.error);
    return;
  }
  if (!live() || !supabase) throw new Error("Supabase is not configured.");
  const ord = aPcId < bPcId ? { a: aPcId, b: bPcId } : { a: bPcId, b: aPcId };
  // Try the participant path first (safe if super_admin owns a side
  // too); fall back to the admin path if RLS rejects (i.e. caller is
  // super_admin but doesn't own either side of the pair). Both RPCs
  // verify their own permissions, so the fallback is safe.
  const mine = await supabase.rpc("xpc_revoke_my_pair", {
    p_a_pc_id: ord.a, p_b_pc_id: ord.b, p_reason: reason,
  });
  if (mine.error) {
    if (mine.error.message?.toLowerCase().includes("does not own")) {
      const adm = await supabase.rpc("xpc_admin_revoke_pair", {
        p_a_pc_id: ord.a, p_b_pc_id: ord.b, p_reason: reason,
      });
      if (adm.error) throw new Error(adm.error.message);
      return;
    }
    throw new Error(mine.error.message);
  }
}

export async function setPairPermanent(aPcId: string, bPcId: string, permanent: boolean): Promise<void> {
  if (isLanSessionLoginEnabled()) {
    const ord = aPcId < bPcId ? { a: aPcId, b: bPcId } : { a: bPcId, b: aPcId };
    const resp = await postInternalXpcPairAdminSetPermanent({
      a_pc_id: ord.a,
      b_pc_id: ord.b,
      permanent,
    });
    if (!resp.ok) throw new Error(resp.error);
    return;
  }
  if (!live() || !supabase) throw new Error("Supabase is not configured.");
  const ord = aPcId < bPcId ? { a: aPcId, b: bPcId } : { a: bPcId, b: aPcId };
  const { error } = await supabase.rpc("xpc_admin_set_permanent", {
    p_a_pc_id: ord.a, p_b_pc_id: ord.b, p_permanent: permanent,
  });
  if (error) throw new Error(error.message);
}

export async function resetRegisteredPc(
  pcId: string,
  _byUserId: string | null,
  reason?: string,
  force?: boolean,
): Promise<{ revokedPairCount: number }> {
  if (isLanSessionLoginEnabled()) {
    const resp = await postInternalXpcPairAdminResetPc({
      pc_id: pcId,
      reason: reason ?? null,
      force: force ?? false,
    });
    if (!resp.ok) throw new Error(resp.error);
    return { revokedPairCount: Number(resp.revokedPairCount ?? 0) };
  }
  if (!live() || !supabase) throw new Error("Supabase is not configured.");
  // Atomic reset: server-side RPC revokes every active pair, deletes
  // the registry row + user_pcs claims, and writes the audit row in
  // ONE transaction. If any step throws the whole thing rolls back —
  // there is no half-reset state and no silent failure mode.
  //
  // `force` is a belt-and-braces follow-up that explicitly removes the
  // registry row even if the PC has no active pairs / claims. It's only
  // exposed in the UI when the heartbeat is stale, but the API allows
  // it unconditionally so a script can clean up stuck rows without
  // first inspecting state.
  const { data, error } = await supabase.rpc("xpc_admin_reset_pc", {
    p_pc_id: pcId,
    p_reason: reason ?? null,
  });
  if (error) throw new Error(error.message);
  if (force) {
    // Best-effort secondary delete in case the RPC's idempotency left
    // a stale registry row behind. RLS on the table only allows
    // super-admins; an RLS denial is safely swallowed because the row
    // is already gone for non-super-admins.
    const del = await supabase.from("xpc_pcs").delete().eq("id", pcId);
    if (del.error && del.error.code !== "PGRST116" && del.error.code !== "42501") {
      throw new Error(del.error.message);
    }
  }
  return { revokedPairCount: Number(data ?? 0) };
}

// Super-admin bulk: pair every (Ops PC ↔ Flight PC) sharing a
// squadron name. Idempotent. Returns count of newly-created pairs.
export async function bulkPairInSquadron(): Promise<number> {
  if (isLanSessionLoginEnabled()) {
    const resp = await postInternalXpcPairAdminBulk();
    if (!resp.ok) throw new Error(resp.error);
    return Number(resp.created ?? 0);
  }
  if (!live() || !supabase) throw new Error("Supabase is not configured.");
  const { data, error } = await supabase.rpc("xpc_admin_bulk_pair_in_squadron");
  if (error) throw new Error(error.message);
  return Number(data ?? 0);
}

export async function runSweep(): Promise<{ revoked: number; expired: number }> {
  if (isLanSessionLoginEnabled()) {
    const resp = await postInternalXpcPairAdminSweep({ inactive_days: 90 });
    if (!resp.ok) throw new Error(resp.error);
    return { revoked: Number(resp.revoked ?? 0), expired: Number(resp.expired ?? 0) };
  }
  if (!live() || !supabase) throw new Error("Supabase is not configured.");
  const { data, error } = await supabase.rpc("xpc_pair_links_sweep", { p_inactive_days: 90 });
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  return { revoked: Number(row?.revoked_count ?? 0), expired: Number(row?.expired_count ?? 0) };
}

// (Audit rows are now written exclusively by the SECURITY DEFINER
// RPCs in the 0038 migration — xpc_pair_audit has no INSERT policy
// for the `authenticated` role, so client-side audit writes would be
// rejected by RLS anyway.)

// ── React Query hooks ────────────────────────────────────────────────
const KEY_LINKS = ["xpc_pair_links"] as const;
const KEY_AUDIT = ["xpc_pair_audit"] as const;

function useMyPairLinks(myPcId: string | null): UseQueryResult<PairLink[]> & { data: PairLink[] } {
  const q = useQuery<PairLink[]>({
    queryKey: [...KEY_LINKS, "mine", myPcId ?? "self"],
    enabled: (live() || isLanSessionLoginEnabled()) && !!myPcId,
    refetchInterval: 5_000,
    queryFn: async () => {
      if (!myPcId) return [];
      if (isLanSessionLoginEnabled()) {
        const rows = await fetchInternalXpcPairs({ mine: myPcId, limit: 2000 });
        return (rows ?? []).map((r) => mapLink(r as unknown as LinkRow));
      }
      if (!live() || !supabase) return [];
      const { data, error } = await supabase
        .from("xpc_pair_links")
        .select("*")
        .or(`a_pc_id.eq.${myPcId},b_pc_id.eq.${myPcId}`)
        .is("revoked_at", null)
        .order("paired_at", { ascending: false });
      if (error) throw new Error(error.message);
      return (data as LinkRow[] ?? []).map(mapLink);
    },
  });
  return { ...q, data: q.data ?? [] } as UseQueryResult<PairLink[]> & { data: PairLink[] };
}

export function useMyPairs(): UseQueryResult<PairLink[]> & { data: PairLink[] } {
  const myPcId = getLocalPcId() || null;
  return useMyPairLinks(myPcId);
}

export function useAllPairs(): UseQueryResult<PairLink[]> & { data: PairLink[] } {
  // super_admin only — RLS will filter to caller's pairs otherwise.
  const q = useQuery<PairLink[]>({
    queryKey: [...KEY_LINKS, "all"],
    enabled: live() || isLanSessionLoginEnabled(),
    refetchInterval: 8_000,
    queryFn: async () => {
      if (isLanSessionLoginEnabled()) {
        const rows = await fetchInternalXpcPairs({ limit: 2000 });
        return (rows ?? []).map((r) => mapLink(r as unknown as LinkRow));
      }
      if (!live() || !supabase) return [];
      const { data, error } = await supabase
        .from("xpc_pair_links")
        .select("*")
        .is("revoked_at", null)
        .order("paired_at", { ascending: false })
        .limit(2000);
      if (error) throw new Error(error.message);
      return (data as LinkRow[] ?? []).map(mapLink);
    },
  });
  return { ...q, data: q.data ?? [] } as UseQueryResult<PairLink[]> & { data: PairLink[] };
}

export interface PairAuditResult {
  entries: PairAuditEntry[];
  rlsDenied: boolean;
}

export function usePairAudit(limit: number = 200): UseQueryResult<PairAuditResult> & { data: PairAuditResult } {
  const q = useQuery<PairAuditResult>({
    queryKey: [...KEY_AUDIT, limit],
    enabled: live() || isLanSessionLoginEnabled(),
    refetchInterval: 10_000,
    queryFn: async () => {
      if (isLanSessionLoginEnabled()) {
        const out = await fetchInternalXpcPairAudit(limit);
        if (!out) return { entries: [], rlsDenied: false };
        const entries = out.items.map((r) => ({
          id: String(r.id ?? ""),
          action: String(r.action ?? ""),
          targetPcA: r.target_pc_a ? String(r.target_pc_a) : null,
          targetPcB: r.target_pc_b ? String(r.target_pc_b) : null,
          byUserLabel: r.by_user_label ? String(r.by_user_label) : null,
          kind: r.kind ? String(r.kind) : null,
          justification: r.justification ? String(r.justification) : null,
          detail: (r.detail ?? null) as Record<string, unknown> | null,
          at: String(r.at ?? ""),
        }));
        return { entries, rlsDenied: out.rlsDenied };
      }
      if (!live() || !supabase) return { entries: [], rlsDenied: false };
      const { data, error } = await supabase
        .from("xpc_pair_audit")
        .select("*")
        .order("at", { ascending: false })
        .limit(limit);
      if (error) {
        // PostgREST returns 42501 when RLS rejects the SELECT — every
        // non-super-admin caller hits this on the audit table. Don't
        // throw: surface the denial as a flag so the page can render
        // an info card instead of a destructive toast.
        if (error.code === "42501" || /permission denied|rls/i.test(error.message)) {
          return { entries: [], rlsDenied: true };
        }
        throw new Error(error.message);
      }
      const entries = (data as Array<{
        id: string; action: string; target_pc_a: string | null; target_pc_b: string | null;
        by_user_label: string | null; kind: string | null; justification: string | null;
        detail: Record<string, unknown> | null; at: string;
      }> ?? []).map(r => ({
        id: r.id, action: r.action,
        targetPcA: r.target_pc_a, targetPcB: r.target_pc_b,
        byUserLabel: r.by_user_label, kind: r.kind,
        justification: r.justification, detail: r.detail, at: r.at,
      }));
      return { entries, rlsDenied: false };
    },
  });
  const fallback: PairAuditResult = { entries: [], rlsDenied: false };
  return { ...q, data: q.data ?? fallback } as UseQueryResult<PairAuditResult> & { data: PairAuditResult };
}

// Long-poll for a fresh pair created against my PC id (host modal closes
// automatically once the other side redeems the code).
export function useWatchForIncomingPair(myPcId: string | null, sinceIso: string | null): PairLink | null {
  const q = useQuery<PairLink | null>({
    queryKey: [...KEY_LINKS, "watch", myPcId ?? "self", sinceIso],
    enabled: (live() || isLanSessionLoginEnabled()) && !!myPcId && !!sinceIso,
    refetchInterval: 2_000,
    queryFn: async () => {
      if (!myPcId || !sinceIso) return null;
      if (isLanSessionLoginEnabled()) {
        const rows = await fetchInternalXpcPairs({ mine: myPcId, since: sinceIso, limit: 1 });
        const row = (rows ?? [])[0];
        return row ? mapLink(row as unknown as LinkRow) : null;
      }
      if (!live() || !supabase) return null;
      const { data, error } = await supabase
        .from("xpc_pair_links")
        .select("*")
        .or(`a_pc_id.eq.${myPcId},b_pc_id.eq.${myPcId}`)
        .is("revoked_at", null)
        .gte("paired_at", sinceIso)
        .order("paired_at", { ascending: false })
        .limit(1);
      if (error) return null;
      const row = (data as LinkRow[] ?? [])[0];
      return row ? mapLink(row) : null;
    },
  });
  return q.data ?? null;
}

// Pair-aware peer hook — returns the peer PC id for every active pair
// the local PC is part of, optionally filtered by tier. Pickers use
// this to put paired PCs FIRST, then divider, then unpaired registry.
export interface PairedPeer {
  pcId: string;
  tier: PcTier;
  squadron: string | null;
  userDisplay: string | null;
  userSeat: string | null;
  kind: PairKind;
  pairedAt: string;
  expiresAt: string | null;
  permanent: boolean;
}

export function usePairedPeers(tierFilter?: PcTier | PcTier[]): PairedPeer[] {
  const myPcId = getLocalPcId();
  const { data } = useMyPairLinks(myPcId || null);
  const tiers = !tierFilter
    ? null
    : Array.isArray(tierFilter) ? tierFilter : [tierFilter];
  const peers: PairedPeer[] = data.map((l) => {
    const isA = l.aPcId === myPcId;
    return {
      pcId: isA ? l.bPcId : l.aPcId,
      tier: (isA ? l.bTier : l.aTier) as PcTier,
      squadron: isA ? l.bSquadron : l.aSquadron,
      userDisplay: isA ? l.bUserDisplay : l.aUserDisplay,
      userSeat: isA ? l.bUserSeat : l.aUserSeat,
      kind: l.kind,
      pairedAt: l.pairedAt,
      expiresAt: l.expiresAt,
      permanent: l.permanent,
    };
  });
  return tiers ? peers.filter(p => tiers.includes(p.tier)) : peers;
}

// ── Mutations as React-Query hooks ───────────────────────────────────
export function useIssueCode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: issuePairCode,
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY_AUDIT }),
  });
}
export function useRedeemCode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: redeemPairCode,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY_LINKS });
      qc.invalidateQueries({ queryKey: KEY_AUDIT });
    },
  });
}
export function useAdminCreatePair() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: adminCreatePair,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY_LINKS });
      qc.invalidateQueries({ queryKey: KEY_AUDIT });
    },
  });
}
export function useRevokePair() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { aPcId: string; bPcId: string; reason: string; byUserId: string | null }) =>
      revokePair(args.aPcId, args.bPcId, args.reason, args.byUserId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY_LINKS });
      qc.invalidateQueries({ queryKey: KEY_AUDIT });
    },
  });
}
export function useSetPairPermanent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { aPcId: string; bPcId: string; permanent: boolean }) =>
      setPairPermanent(args.aPcId, args.bPcId, args.permanent),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY_LINKS }),
  });
}
export function useResetRegisteredPc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { pcId: string; byUserId: string | null; force?: boolean }) =>
      resetRegisteredPc(args.pcId, args.byUserId, undefined, args.force),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY_LINKS });
      qc.invalidateQueries({ queryKey: KEY_AUDIT });
    },
  });
}
export function useRunSweep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: runSweep,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY_LINKS });
      qc.invalidateQueries({ queryKey: KEY_AUDIT });
    },
  });
}

// ── Days-until-auto-expiry helper for the Connections / Map UI ───────
export function daysUntilInactivityExpiry(link: PairLink, inactiveDays: number = 90): number | null {
  if (link.permanent) return null;
  const last = new Date(link.lastActivityAt).getTime();
  const due = last + inactiveDays * 24 * 60 * 60_000;
  const now = Date.now();
  return Math.max(0, Math.ceil((due - now) / (24 * 60 * 60_000)));
}

export function expiryUrgencyClass(daysLeft: number | null): string {
  if (daysLeft == null) return "text-emerald-300";
  if (daysLeft <= 10) return "text-rose-300";
  if (daysLeft <= 30) return "text-amber-300";
  return "text-foreground/70";
}

export const PAIR_KIND_LABEL: Record<PairKind, string> = {
  in_squadron: "In-squadron",
  sqn_to_wing: "Sqn ↔ Wing",
  wing_to_base: "Wing ↔ Base",
  cross_squadron_ops: "Cross-squadron Ops (time-bound)",
  peer_flight: "Peer (Flight)",
  peer_sqn: "Peer (Sqn Cmdr)",
  peer_wing: "Peer (Wing)",
  peer_base: "Peer (Base)",
};
