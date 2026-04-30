// Edge function: heal-claims
//
// v1.1.73 — Critical Bug 1 root-cause companion to the 0030 backfill
// migration. The migration handles the bulk case server-side; this
// function closes the gap whenever the migration has not been
// applied yet (older self-hosted installs) or when an auth user was
// created out-of-band by an admin and is missing the
// app_metadata.squadron_id / role claims that every squadron-scoped
// edge function (provision-user, register-license, ...) and every
// RLS policy depend on.
//
// Idempotent: if the caller's app_metadata already carries both
// squadron_id and role, the function returns ok without touching
// anything. Operates ONLY on the JWT-authenticated caller — there is
// no path here to mutate any other user's claims, so it is safe to
// expose to every signed-in user.

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  // Caller identification — pulls user_id straight from the JWT, never
  // trusts any payload field.
  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: caller, error: callerErr } = await userClient.auth.getUser();
  if (callerErr || !caller?.user) {
    return json({ ok: false, error: "unauthenticated", detail: callerErr?.message }, 401);
  }
  const userId = caller.user.id;
  const meta = (caller.user.app_metadata ?? {}) as {
    squadron_id?: string;
    role?: string;
    tier?: string;
    squadron_ids?: unknown;
  };
  const tier = (meta.tier ?? "").toString();
  const existingIds = Array.isArray(meta.squadron_ids)
    ? (meta.squadron_ids as unknown[]).filter((x) => typeof x === "string" && x.length > 0) as string[]
    : [];
  // Multi-squadron tiers (wing/base/hq) need a squadron_ids allow-list to
  // pass the migration 0061 SELECT policy on xpc_squadron_snapshot.
  // Single-squadron tiers (ops/squadron/flight/deputy) are already covered
  // by squadron_id alone, so the original early-return still applies to them.
  const needsSquadronIds =
    existingIds.length === 0 && (tier === "wing" || tier === "base" || tier === "hq");
  if (meta.squadron_id && meta.role && !needsSquadronIds) {
    return json({ ok: true, healed: false, reason: "already_stamped" });
  }

  // Service-role client to (a) look up the public.users row and (b) call
  // auth.admin.updateUserById. Both are gated by the JWT-derived userId
  // above so a caller can only heal their OWN claims.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  const { data: pu, error: puErr } = await admin
    .from("users")
    .select("squadron_id, role")
    .eq("id", userId)
    .maybeSingle();
  if (puErr) return json({ ok: false, error: "lookup_failed", detail: puErr.message }, 500);

  // Resolve the squadron_ids allow-list when needed. For multi-squadron
  // tiers we look up license_registry by the caller's username (email
  // prefix) and translate authorizedSquadronIds (uuids) → squadron names.
  // The names match the snapshot.squadron_id text column the migration
  // 0061 SELECT policy compares against.
  let squadronIds = existingIds;
  if (needsSquadronIds) {
    const email = (caller.user.email ?? "").toLowerCase();
    const username = email.split("@")[0] ?? "";
    if (username) {
      const { data: regRows } = await admin
        .from("license_registry")
        .select("meta");
      const wantUuids = new Set<string>();
      for (const row of (regRows ?? []) as Array<{ meta: any }>) {
        const m = row.meta ?? {};
        const assigned = (m.assignedUsername ?? "").toString().trim().toLowerCase();
        if (assigned !== username) continue;
        const ids = Array.isArray(m.authorizedSquadronIds) ? m.authorizedSquadronIds : [];
        for (const id of ids) if (typeof id === "string" && id.length > 0) wantUuids.add(id);
      }
      if (wantUuids.size > 0) {
        const { data: sqRows } = await admin
          .from("squadrons")
          .select("name")
          .in("id", Array.from(wantUuids));
        const names = (sqRows ?? [])
          .map((r: any) => r.name as string)
          .filter((n) => typeof n === "string" && n.length > 0);
        if (names.length > 0) {
          squadronIds = Array.from(new Set(names)).sort();
        }
      } else if (tier === "hq") {
        // HQ commander with no registry mapping defaults to every known
        // squadron — operationally HQ sees everything.
        const { data: allSq } = await admin.from("squadrons").select("name");
        const names = (allSq ?? [])
          .map((r: any) => r.name as string)
          .filter((n) => typeof n === "string" && n.length > 0);
        if (names.length > 0) squadronIds = Array.from(new Set(names)).sort();
      }
    }
  }

  // squadron_id is required for the legacy claim path (single-tenant RLS
  // policies on most squadron-scoped tables). If public.users carries no
  // squadron_id AND we have nothing else to heal, refuse — the caller
  // must be re-provisioned.
  if (!pu?.squadron_id && squadronIds.length === 0) {
    return json({ ok: false, error: "no_squadron_for_user", detail: "public.users row is missing or has no squadron_id — re-provision required" }, 422);
  }

  // Multi-squadron caller asked us to fill in squadron_ids but we found no
  // license_registry mapping AND no HQ-default expansion applied. Surface
  // an explicit error rather than returning healed=true — the dashboard
  // would still be empty, and a silent success here would mask the gap.
  if (needsSquadronIds && squadronIds.length === 0) {
    return json(
      {
        ok: false,
        error: "no_squadron_ids_mapping",
        detail: "tier requires a squadron_ids allow-list but no license_registry rows are assigned to this username — re-issue the license key or stamp squadron_ids manually",
      },
      422,
    );
  }

  // Read squadron number for app_metadata.squadron_number (used by the
  // license-key flow). LOWER() so it matches the convention provision-
  // user already follows.
  let squadronNumber = (caller.user.app_metadata as any)?.squadron_number ?? null;
  if (pu?.squadron_id) {
    const { data: sq } = await admin
      .from("squadrons")
      .select("number")
      .eq("id", pu.squadron_id)
      .maybeSingle();
    squadronNumber = (sq?.number ?? "rjaf").toString().toLowerCase();
  }

  const nextMeta: Record<string, unknown> = {
    ...(caller.user.app_metadata ?? {}),
    squadron_id: pu?.squadron_id ?? meta.squadron_id ?? null,
    role: pu?.role ?? meta.role ?? "ops",
    squadron_number: squadronNumber,
  };
  if (squadronIds.length > 0) nextMeta.squadron_ids = squadronIds;

  const { error: updErr } = await admin.auth.admin.updateUserById(userId, {
    app_metadata: nextMeta,
  });
  if (updErr) return json({ ok: false, error: "update_failed", detail: updErr.message }, 500);

  return json({ ok: true, healed: true, app_metadata: nextMeta });
});
