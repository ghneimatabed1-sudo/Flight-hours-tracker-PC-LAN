import { type ReactNode, useState, useEffect } from "react";
import { useAuth } from "@/lib/auth";
import {
  getFlightBinding,
  setFlightBinding,
  getAdminFlightBindingFor,
  syncAdminFlightBindingsFromRemote,
  syncSquadronFlightGroupForFlightPc,
  getLocalPcId,
  type FlightBinding,
} from "@/lib/cross-pc";
import { Plane, Link2 } from "lucide-react";

// Gate that the Flight Commander PC must pass through before any
// dashboard surface is reachable. It pins this PC to ONE specific
// Squadron Commander PC. Once chosen, every cross-PC surface (schedule
// sharing recipient picker, messages composer) automatically reshapes
// to address only that squadron commander — the operator never has to
// pick a recipient again. The binding lives in localStorage on this
// PC; the squadron commander needs no advance setup.
export function FlightBindingGate({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const isFlight = user?.role === "commander" && user?.scope === "flight";
  const [binding, setBinding] = useState<FlightBinding | null>(() => getFlightBinding());
  const [syncing, setSyncing] = useState<boolean>(false);

  // Admin-controlled binding (April 2026): Super Admin → Commanders is the
  // ONLY place this binding can be set. The flight commander's PC pulls
  // the override from the cross-PC channel on every sign-in, applies it
  // locally, and renders the locked-out screen if HQ hasn't published one
  // yet. The manual picker that used to live here was removed per the CO
  // brief — no flight-side override is allowed.
  useEffect(() => {
    if (!isFlight) return;
    let cancelled = false;
    setSyncing(true);
    void (async () => {
      try { await syncAdminFlightBindingsFromRemote(); } catch { /* offline ok */ }
      if (cancelled) return;
      // Admin-driven override wins when present (Super Admin explicitly
      // pinned this flight commander to a squadron).
      const override = getAdminFlightBindingFor(user?.username);
      if (override) {
        setFlightBinding(override);
        setBinding(override);
        setSyncing(false);
        return;
      }
      // Otherwise: honour the squadron-commander-published group. When a
      // Squadron Commander ticks this flight PC in their Setup dialog,
      // the commander PC broadcasts a "xpc.squadron.flight.group.set"
      // event every 30s; we listen for one that lists our canonical id
      // and auto-apply the squadron PC as our binding. This is what ties
      // the ops PC + squadron commander + linked flight commanders into
      // one messaging group without any admin step.
      const myPcId = getLocalPcId();
      let groupBinding: FlightBinding | null = null;
      if (myPcId) {
        try {
          groupBinding = await syncSquadronFlightGroupForFlightPc(myPcId);
        } catch { /* offline ok */ }
      }
      if (cancelled) return;
      if (groupBinding) {
        setFlightBinding(groupBinding);
        setBinding(groupBinding);
      } else {
        setFlightBinding(null);
        setBinding(null);
      }
      setSyncing(false);
    })();
    return () => { cancelled = true; };
  }, [user?.username, isFlight]);

  if (!isFlight) return <>{children}</>;
  if (binding) return <>{children}</>;

  return (
    <div className="max-w-2xl mx-auto mt-6 rounded-md border border-border bg-card p-6 space-y-4" data-testid="flight-binding-gate">
      <div className="flex items-start gap-3">
        <div className="rounded-full bg-amber-500/15 text-amber-500 p-2">
          <Plane className="h-5 w-5" />
        </div>
        <div className="flex-1 space-y-2">
          <div className="text-base font-semibold flex items-center gap-2">
            <Link2 className="h-4 w-4" /> Awaiting squadron link-up
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            This Flight Commander PC ({user?.username}) is not yet linked
            to a Squadron Commander. There are two ways to complete the
            link — either one will unlock this PC automatically:
          </p>
          <ol className="text-xs text-muted-foreground leading-relaxed space-y-1 list-decimal ms-5">
            <li>
              <span className="text-foreground font-medium">Recommended:</span> ask the Squadron
              Commander to sign in on the squadron PC, open
              <span className="font-mono"> Setup → Flight commanders</span>,
              and tick this PC. The link applies on this PC within ~30 seconds.
            </li>
            <li>
              Or ask Super Admin to open
              <span className="font-mono"> Commanders → Flight bindings </span>
              and assign this account to a squadron.
            </li>
          </ol>
          {syncing && (
            <p className="text-[11px] text-muted-foreground italic">
              Checking for an updated link…
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// Small toolbar control letting a flight commander operator review and
// change the current binding (e.g. after a squadron rename). Mounts
// only on flight-scope PCs that already have a binding — first-run
// setup goes through FlightBindingGate above.
export function FlightBindingBadge() {
  const { user } = useAuth();
  const isFlight = user?.role === "commander" && user?.scope === "flight";
  const [binding] = useState<FlightBinding | null>(() => getFlightBinding());
  if (!isFlight || !binding) return null;
  // Read-only badge — changing the binding is a Super Admin action only.
  return (
    <span
      className="text-[11px] inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border bg-secondary/40"
      data-testid="badge-flight-binding"
      title="Bound by Super Admin — contact HQ to change"
    >
      <Link2 className="h-3 w-3" /> Bound to: <span className="font-semibold">{binding.pcName}</span>
    </span>
  );
}
