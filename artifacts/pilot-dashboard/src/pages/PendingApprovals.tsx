import { useMemo, useState } from "react";
import { Card, PageHead } from "@/components/Layout";
import { useAuth } from "@/lib/auth";
import { composeIdentityLabel } from "@/lib/types";
import {
  usePendingApprovals,
  useDecidePending,
  type PendingSortie,
} from "@/lib/cross-pc";
import { useToast } from "@/hooks/use-toast";
import { useCreateSortie, usePilots } from "@/lib/squadron-data";
import { useI18n } from "@/lib/i18n";
import { fmtDateTimeDDMM } from "@/lib/format";
import { matchGuestPilot, guestMilitaryNumberHasNoMatch } from "@/lib/match-guest-pilot";
import { Inbox, Check, X, PauseCircle, Pencil, AlertTriangle, History } from "lucide-react";
import { Link } from "wouter";
import { useGuestEntriesNeedingBackfill, isGuestMilUnknown } from "@/lib/cross-pc";

// Pending Approvals — home-squadron ops officer reviews sorties that
// another (hosting) squadron logged for one of her pilots. Accept cascades
// through the local calc engine via useCreateSortie; reject / hold / edit
// propagate the decision back through the cross-PC layer.
export default function PendingApprovals() {
  const { rankOf } = useI18n();
  const { user, squadron } = useAuth();
  const { toast } = useToast();
  // The local PC's "home squadron id" is the configured squadron's name —
  // good enough for the localStorage simulation. When the central server is
  // wired up this becomes a real squadron uuid.
  const homeSquadronId = squadron?.name ?? null;
  const pendingQ = usePendingApprovals(homeSquadronId);
  const backfillQ = useGuestEntriesNeedingBackfill(homeSquadronId);
  const decide = useDecidePending();
  const createSortie = useCreateSortie();
  const { data: PILOTS } = usePilots();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [reasonFor, setReasonFor] = useState<string | null>(null);
  const [reasonText, setReasonText] = useState("");
  // Per-row pilot mapping: the home ops officer must pick which local
  // roster pilot the guest entry should be credited to before the
  // cascade. Defaults to a fuzzy name match when one exists.
  const [pilotChoice, setPilotChoice] = useState<Record<string, string>>({});
  // Per-row dismissal of the "military number doesn't match anyone" warning.
  // The warning also auto-hides once the ops officer makes a manual pick
  // (handled in the render below by checking pilotChoice[row.id]).
  const [dismissedMilWarn, setDismissedMilWarn] = useState<Record<string, boolean>>({});

  const pilotOpts = useMemo(
    () => PILOTS.map(p => ({
      value: p.id,
      // Show the military number alongside the name so the ops officer can
      // tell apart roster pilots that share a name (e.g. multiple "Ahmad
      // Khalil"s) at a glance from the dropdown.
      label: `${rankOf(p)} ${p.name}${p.militaryNumber ? ` · #${p.militaryNumber}` : ""}`,
    })),
    [PILOTS],
  );
  const matchFor = (row: PendingSortie) =>
    matchGuestPilot(PILOTS, {
      name: row.guestPilotName,
      militaryNumber: row.guestPilotMilitaryNumber,
    });

  const decideAndCascade = async (row: PendingSortie, action: "accepted" | "rejected" | "deleted" | "edited", reason?: string) => {
    if (action === "accepted") {
      const pickId = pilotChoice[row.id] ?? matchFor(row)?.id ?? "";
      if (!pickId) {
        toast({
          title: "Pick a local pilot first",
          description: "Map the guest to one of your roster pilots so totals and currencies credit the right person.",
          variant: "destructive",
        });
        return;
      }
      // Stamp the resolved local pilot id onto the right seat so the
      // calc engine credits the correct totals/currencies/captain hours.
      const cascade = {
        ...row.sortie,
        pilotId: row.guestSeat === "pilot" ? pickId : row.sortie.pilotId,
        coPilotId: row.guestSeat === "coPilot" ? pickId : row.sortie.coPilotId,
        // Clear the external marker on the accepted local copy — the
        // hours now belong to a real local pilot.
        pilotExternal: row.guestSeat === "pilot" ? undefined : row.sortie.pilotExternal,
        coPilotExternal: row.guestSeat === "coPilot" ? undefined : row.sortie.coPilotExternal,
      };
      // Cascade through the local calc engine: writing the sortie locally
      // bumps totals, currencies, captain hours and the audit trail via
      // squadron-data.useCreateSortie's existing pipeline.
      await createSortie.mutateAsync(cascade);
    }
    await decide.mutateAsync({
      id: row.id,
      decision: action,
      decidedBy: user?.username ?? "ops",
      reason,
    });
    toast({ title: `Marked ${action}` });
  };

  return (
    <div>
      <PageHead
        title="Pending Approvals"
        subtitle={`Cross-squadron sorties awaiting your review · ${pendingQ.data.length} pending`}
      />
      {backfillQ.data.length > 0 && (
        <div
          className="mb-3 flex items-center justify-between gap-3 rounded-md border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100"
          data-testid="backfill-prompt"
        >
          <div className="flex items-start gap-2">
            <History className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <div>
              <strong>{backfillQ.data.length}</strong> legacy guest entr{backfillQ.data.length === 1 ? "y is" : "ies are"} missing a military number.
              These still rely on name-only matching — backfill them to credit hours safely.
            </div>
          </div>
          <Link
            href="/pending/backfill"
            className="shrink-0 px-2.5 py-1 rounded-md bg-amber-500/20 border border-amber-400/40 text-amber-100 font-semibold hover:bg-amber-500/30"
            data-testid="link-open-backfill"
          >
            Open backfill queue
          </Link>
        </div>
      )}
      {pendingQ.data.length === 0 ? (
        <Card>
          <div className="text-sm text-muted-foreground text-center py-10 inline-flex items-center gap-2 w-full justify-center">
            <Inbox className="h-4 w-4" /> No pending cross-squadron sorties.
          </div>
        </Card>
      ) : (
        <div className="space-y-2">
          {pendingQ.data.map(row => {
            const open = expanded === row.id;
            const s = row.sortie;
            const time = (s.time ?? s.actual ?? 0).toFixed(1);
            return (
              <Card key={row.id} className="!p-0 overflow-hidden" data-testid={`pending-${row.id}`}>
                <button
                  type="button"
                  onClick={() => setExpanded(open ? null : row.id)}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-secondary/30 text-left"
                >
                  <div className="min-w-0">
                    <div className="font-semibold text-amber-200 truncate">
                      {row.guestPilotName}
                      {row.guestPilotMilitaryNumber
                        ? (isGuestMilUnknown(row.guestPilotMilitaryNumber)
                            ? <span className="text-xs text-muted-foreground"> · # unknown</span>
                            : <span className="text-xs text-muted-foreground"> · #{row.guestPilotMilitaryNumber}</span>)
                        : null}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      hosted by <span className="text-foreground">{row.hostingSquadronName}</span> · {s.date} · {s.acType} {s.acNumber} · {time}h {s.condition}
                    </div>
                    {(() => {
                      // Task #137: render the rich submitter identity so
                      // the home ops officer instantly sees which person
                      // (rank + name + seat label) sent this entry.
                      const lbl = composeIdentityLabel({
                        rank: row.submittedByRank,
                        displayName: row.submittedByDisplayName,
                        username: row.submittedBy,
                        seatLabel: row.submittedBySeatLabel,
                      });
                      return lbl ? (
                        <div className="text-[11px] text-muted-foreground mt-0.5">
                          Submitted by <span className="text-foreground">{lbl}</span>
                        </div>
                      ) : null;
                    })()}
                  </div>
                  <span className="text-[10px] uppercase tracking-wider px-2 py-1 rounded bg-amber-500/20 text-amber-200 border border-amber-400/30">PENDING</span>
                </button>
                {open && (
                  <div className="border-t border-border p-4 space-y-3">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                      <Field label="Sortie type" value={s.sortieType} />
                      <Field label="Mission / duty" value={s.msnDuty || s.name || "—"} />
                      <Field label="Condition" value={s.condition || "—"} />
                      <Field label="Time" value={`${time} hrs`} />
                      <Field label="Day" value={(s.day1 + s.day2 + s.dayDual).toFixed(1)} />
                      <Field label="Night" value={(s.night1 + s.night2 + s.nightDual).toFixed(1)} />
                      <Field label="NVG" value={(s.nvg ?? 0).toFixed(1)} />
                      <Field label="Submitted" value={fmtDateTimeDDMM(row.submittedAt)} />
                    </div>
                    {s.remarks && (
                      <div className="text-xs">
                        <div className="text-muted-foreground mb-1">Remarks</div>
                        <div className="bg-secondary/30 rounded p-2 whitespace-pre-wrap">{s.remarks}</div>
                      </div>
                    )}
                    <div className="border border-border rounded p-2 bg-secondary/20">
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                        Credit hours / currencies to local pilot
                      </div>
                      {!isGuestMilUnknown(row.guestPilotMilitaryNumber) &&
                        guestMilitaryNumberHasNoMatch(PILOTS, { militaryNumber: row.guestPilotMilitaryNumber }) &&
                        !pilotChoice[row.id] &&
                        !dismissedMilWarn[row.id] && (
                          <div
                            className="mb-2 flex items-start gap-2 rounded border border-amber-400/40 bg-amber-500/10 p-2 text-xs text-amber-100"
                            data-testid={`mil-warn-${row.id}`}
                          >
                            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                            <div className="flex-1">
                              No roster pilot matches military number #{row.guestPilotMilitaryNumber} — pick manually or contact the hosting squadron.
                            </div>
                            <button
                              type="button"
                              onClick={() => setDismissedMilWarn(d => ({ ...d, [row.id]: true }))}
                              className="text-amber-200/80 hover:text-amber-100"
                              aria-label="Dismiss warning"
                              data-testid={`mil-warn-dismiss-${row.id}`}
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        )}
                      <select
                        value={pilotChoice[row.id] ?? matchFor(row)?.id ?? ""}
                        onChange={e => setPilotChoice(c => ({ ...c, [row.id]: e.target.value }))}
                        className="w-full px-2 py-1.5 rounded-md bg-input border border-border text-xs"
                        data-testid={`pilot-pick-${row.id}`}
                      >
                        <option value="">— pick a roster pilot —</option>
                        {pilotOpts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <button
                        onClick={() => decideAndCascade(row, "accepted")}
                        disabled={decide.isPending || createSortie.isPending}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-500/20 border border-emerald-400/40 text-emerald-100 text-xs font-semibold hover:bg-emerald-500/30 disabled:opacity-50"
                        data-testid={`accept-${row.id}`}
                      >
                        <Check className="h-3.5 w-3.5" /> Accept · cascade hours & currency
                      </button>
                      <button
                        onClick={() => { setReasonFor(row.id); setReasonText(""); }}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-rose-500/20 border border-rose-400/40 text-rose-100 text-xs font-semibold hover:bg-rose-500/30"
                        data-testid={`reject-${row.id}`}
                      >
                        <X className="h-3.5 w-3.5" /> Reject
                      </button>
                      <button
                        onClick={() => decide.mutateAsync({ id: row.id, decision: "edited", decidedBy: user?.username ?? "ops" }).then(() => toast({ title: "Returned to host with edits" }))}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-secondary border border-border text-xs hover:bg-secondary/80"
                      >
                        <Pencil className="h-3.5 w-3.5" /> Edit & return
                      </button>
                      <button
                        onClick={() => decideAndCascade(row, "deleted")}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-secondary border border-border text-xs hover:bg-secondary/80"
                      >
                        <PauseCircle className="h-3.5 w-3.5" /> Drop
                      </button>
                    </div>
                    {reasonFor === row.id && (
                      <div className="border border-border rounded p-3 bg-rose-500/5">
                        <div className="text-xs text-rose-100 mb-1">Reason (sent back to {row.hostingSquadronName})</div>
                        <textarea
                          value={reasonText}
                          onChange={e => setReasonText(e.target.value)}
                          rows={2}
                          className="w-full text-xs bg-input border border-border rounded p-2"
                          placeholder="e.g. duplicate of sortie #1234"
                          data-testid={`reason-${row.id}`}
                        />
                        <div className="flex gap-2 mt-2">
                          <button
                            onClick={() => decideAndCascade(row, "rejected", reasonText.trim() || undefined).then(() => { setReasonFor(null); setReasonText(""); })}
                            className="px-3 py-1 rounded-md bg-rose-500/30 border border-rose-400/40 text-rose-100 text-xs font-semibold"
                          >Send rejection</button>
                          <button
                            onClick={() => { setReasonFor(null); setReasonText(""); }}
                            className="px-3 py-1 rounded-md bg-secondary border border-border text-xs"
                          >Cancel</button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="font-mono">{value}</div>
    </div>
  );
}
