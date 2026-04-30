import { useMemo, useState } from "react";
import { Link } from "wouter";
import { Card, PageHead } from "@/components/Layout";
import { useAuth } from "@/lib/auth";
import {
  useGuestEntriesNeedingBackfill,
  useBackfillGuestMilNumber,
  GUEST_MIL_UNKNOWN,
  type PendingSortie,
} from "@/lib/cross-pc";
import { useToast } from "@/hooks/use-toast";
import { usePilots } from "@/lib/squadron-data";
import { useI18n } from "@/lib/i18n";
import { fmtDateTimeDDMM } from "@/lib/format";
import { matchGuestPilot } from "@/lib/match-guest-pilot";
import { ArrowLeft, Inbox, Save, HelpCircle, Search } from "lucide-react";

// Backfill helper for legacy guest sortie entries that pre-date the
// "military number required" rule on the mobile app. Any pending or
// accepted entry whose guestPilotMilitaryNumber is blank shows up here
// so the home-squadron ops officer can either type the missing number
// (the lookup helper suggests roster pilots whose name resembles the
// guest) or mark it explicitly unknown — both paths replace name-only
// matching with an auditable decision.
export default function GuestBackfill() {
  const { rankOf } = useI18n();
  const { user, squadron } = useAuth();
  const { toast } = useToast();
  const homeSquadronId = squadron?.name ?? null;
  const queueQ = useGuestEntriesNeedingBackfill(homeSquadronId);
  const backfill = useBackfillGuestMilNumber();
  const { data: PILOTS } = usePilots();
  // Per-row staged input. Defaults to the suggested roster pilot's
  // military number when a fuzzy name match exists, otherwise blank.
  const [staged, setStaged] = useState<Record<string, string>>({});

  const suggestionFor = (row: PendingSortie) =>
    matchGuestPilot(PILOTS, { name: row.guestPilotName });

  const valueFor = (row: PendingSortie) => {
    if (row.id in staged) return staged[row.id];
    const sug = suggestionFor(row);
    return sug?.militaryNumber ?? "";
  };

  const candidatesFor = (row: PendingSortie) => {
    const n = row.guestPilotName.toLowerCase().split(/\s+/).filter(Boolean);
    return PILOTS
      .filter(p => {
        if (!p.militaryNumber) return false;
        const hay = `${rankOf(p)} ${p.name}`.toLowerCase();
        return n.some(tok => tok.length >= 2 && hay.includes(tok));
      })
      .slice(0, 6);
  };

  const submit = async (row: PendingSortie, value: string) => {
    const v = value.trim();
    if (!v) {
      toast({
        title: "Enter a military number",
        description: "Type the visiting pilot's number, pick from the lookup helper, or mark unknown.",
        variant: "destructive",
      });
      return;
    }
    try {
      await backfill.mutateAsync({
        id: row.id,
        militaryNumber: v,
        by: user?.username ?? "ops",
      });
    } catch (err) {
      toast({
        title: "Couldn't save military number",
        description: err instanceof Error ? err.message : "The backfill write failed — try again or check your connection.",
        variant: "destructive",
      });
      return;
    }
    setStaged(s => {
      const next = { ...s };
      delete next[row.id];
      return next;
    });
    toast({
      title: v.toUpperCase() === GUEST_MIL_UNKNOWN ? "Marked as unknown" : "Military number saved",
      description: `Recorded in the audit log against ${row.guestPilotName}.`,
    });
  };

  const queue = queueQ.data;
  const totalPending = useMemo(() => queue.filter(r => r.status === "pending").length, [queue]);
  const totalAccepted = useMemo(() => queue.filter(r => r.status === "accepted").length, [queue]);

  return (
    <div>
      <PageHead
        title="Backfill missing military numbers"
        subtitle={`${queue.length} legacy guest entries · ${totalPending} pending · ${totalAccepted} accepted`}
      />
      <div className="mb-3">
        <Link
          href="/pending"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          data-testid="link-backfill-back"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Pending Approvals
        </Link>
      </div>
      {queue.length === 0 ? (
        <Card>
          <div className="text-sm text-muted-foreground text-center py-10 inline-flex items-center gap-2 w-full justify-center" data-testid="empty-backfill">
            <Inbox className="h-4 w-4" /> No legacy guest entries are missing a military number.
          </div>
        </Card>
      ) : (
        <div className="space-y-2">
          {queue.map(row => {
            const s = row.sortie;
            const time = (s.time ?? s.actual ?? 0).toFixed(1);
            const cands = candidatesFor(row);
            const value = valueFor(row);
            return (
              <Card key={row.id} className="!p-0 overflow-hidden" data-testid={`backfill-${row.id}`}>
                <div className="px-4 py-3 border-b border-border">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold text-amber-200 truncate">{row.guestPilotName}</div>
                      <div className="text-xs text-muted-foreground">
                        hosted by <span className="text-foreground">{row.hostingSquadronName}</span> · {s.date} · {s.acType} {s.acNumber} · {time}h {s.condition} · submitted {fmtDateTimeDDMM(row.submittedAt)}
                      </div>
                    </div>
                    <span className={`text-[10px] uppercase tracking-wider px-2 py-1 rounded border ${
                      row.status === "pending"
                        ? "bg-amber-500/20 text-amber-200 border-amber-400/30"
                        : "bg-emerald-500/20 text-emerald-200 border-emerald-400/30"
                    }`}>{row.status}</span>
                  </div>
                </div>
                <div className="p-4 space-y-3">
                  {cands.length > 0 && (
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 inline-flex items-center gap-1">
                        <Search className="h-3 w-3" /> Lookup helper · roster pilots with similar name
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {cands.map(p => (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => setStaged(st => ({ ...st, [row.id]: p.militaryNumber ?? "" }))}
                            className="text-xs px-2 py-1 rounded-md bg-secondary border border-border hover:bg-secondary/80"
                            data-testid={`suggest-${row.id}-${p.id}`}
                          >
                            {rankOf(p)} {p.name} · #{p.militaryNumber}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="text-xs text-muted-foreground">Military number</label>
                    <input
                      type="text"
                      value={value}
                      onChange={e => setStaged(st => ({ ...st, [row.id]: e.target.value }))}
                      placeholder="e.g. 12345"
                      className="px-2 py-1.5 rounded-md bg-input border border-border text-xs font-mono w-40"
                      data-testid={`input-${row.id}`}
                    />
                    <button
                      type="button"
                      onClick={() => submit(row, value)}
                      disabled={backfill.isPending}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-500/20 border border-emerald-400/40 text-emerald-100 text-xs font-semibold hover:bg-emerald-500/30 disabled:opacity-50"
                      data-testid={`save-${row.id}`}
                    >
                      <Save className="h-3.5 w-3.5" /> Save
                    </button>
                    <button
                      type="button"
                      onClick={() => submit(row, GUEST_MIL_UNKNOWN)}
                      disabled={backfill.isPending}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-secondary border border-border text-xs hover:bg-secondary/80 disabled:opacity-50"
                      data-testid={`unknown-${row.id}`}
                    >
                      <HelpCircle className="h-3.5 w-3.5" /> Mark unknown
                    </button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
