import { useMemo, useState, type ReactNode } from "react";
import { Redirect } from "wouter";
import {
  useScheduleShares,
  makePcMatcher,
  canUseScheduleChain,
  getLocalPcId,
  isFinalSchedule,
  type ScheduleShare,
} from "@/lib/cross-pc";
import { useAuth } from "@/lib/auth";
import { composeIdentityLabel } from "@/lib/types";
import FlightScheduleSheet from "@/components/FlightScheduleSheet";
import { Eye, EyeOff, Check, X, History as HistoryIcon, Printer } from "lucide-react";
import { useI18n } from "@/lib/i18n";

type FilterKey = "all" | "approved" | "rejected" | "in_flight";

export default function ScheduleHistory() {
  const { t } = useI18n();
  const { user, squadron } = useAuth();
  const allowed = canUseScheduleChain(user?.role, user?.scope);
  const myPcId = getLocalPcId() || (squadron?.name ?? user?.username ?? "self");
  // v1.1.108 — Audit page needs every share this PC ever touched:
  // forwarded (no longer current), rejected (status=rejected),
  // approved-and-passed-on, and in-flight rows further up the chain.
  // The default query is too narrow (ball-in-my-court only); the new
  // includeHistoryParticipant option widens both the server-side OR
  // clause and the client-side visible() filter to match.
  const sharesQ = useScheduleShares(myPcId, { includeHistoryParticipant: true });
  const matchesMe = useMemo(() => makePcMatcher(myPcId), [myPcId]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>("all");

  const acted = useMemo(() => {
    const list = (sharesQ.data ?? []).filter(s => {
      // Include approved + rejected (terminals) AND any share whose
      // history shows this PC took an action on it (forward, hold,
      // edit, submitted) — those are the in-flight items the user
      // wants to look up later.
      const involvedAsActor = (s.history ?? []).some(h => matchesMe(h.by));
      const involvedAsParticipant =
        matchesMe(s.originSquadronId)
        || matchesMe(s.currentPcId)
        || (s.chainPcIds ?? []).some(id => matchesMe(id));
      const isFinalApproval = s.status === "approved" && isFinalSchedule(s);
      const isTerminal = isFinalApproval || s.status === "rejected";
      const hasMovement = (s.history ?? []).length > 1; // beyond the initial "submitted"
      // Show terminals always (when this PC participated in any way),
      // plus in-flight items where this PC made at least one move.
      if (!(involvedAsActor || involvedAsParticipant)) return false;
      return isTerminal || hasMovement;
    });
    if (filter === "all") return list;
    if (filter === "in_flight") {
      // In flight = not yet rejected and not yet Wing-finalized.
      // Sqn-/Flight-only approvals that are still being passed
      // upward count as in-flight here.
      return list.filter(s => s.status !== "rejected" && !(s.status === "approved" && isFinalSchedule(s)));
    }
    if (filter === "approved") {
      return list.filter(s => s.status === "approved" && isFinalSchedule(s));
    }
    return list.filter(s => s.status === filter);
  }, [sharesQ.data, matchesMe, filter]);

  const sorted = useMemo(() => {
    const ts = (s: ScheduleShare) =>
      s.approvedAt
      ?? s.history[s.history.length - 1]?.at
      ?? s.date;
    return [...acted].sort((a, b) => (ts(b) > ts(a) ? 1 : -1));
  }, [acted]);

  if (!allowed) {
    return <Redirect to="/" />;
  }

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h1 className="text-lg font-semibold inline-flex items-center gap-2">
          <HistoryIcon className="h-5 w-5" />
          {t("nav_schedule_history")}
        </h1>
        <div className="inline-flex rounded-md overflow-hidden border border-border text-xs">
          {(["all", "approved", "rejected", "in_flight"] as const).map(k => (
            <button
              key={k}
              type="button"
              onClick={() => setFilter(k)}
              data-testid={`sh-filter-${k}`}
              className={`px-3 py-1.5 ${filter === k ? "bg-primary text-primary-foreground font-semibold" : "bg-background text-foreground"}`}
            >
              {k === "all" ? t("sh_filter_all")
                : k === "approved" ? t("sh_filter_approved")
                : k === "rejected" ? t("sh_filter_rejected")
                : t("sh_filter_inflight")}
            </button>
          ))}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">{t("sh_intro")}</p>

      {sorted.length === 0 && (
        <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground" data-testid="sh-empty">
          {t("sh_empty")}
        </div>
      )}

      {sorted.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-xs">
            <thead className="text-[10px] uppercase tracking-wider text-muted-foreground bg-secondary/30">
              <tr>
                <th className="px-2 py-1.5 text-left">{t("sh_col_date")}</th>
                <th className="px-2 py-1.5 text-left">{t("sh_col_squadron")}</th>
                <th className="px-2 py-1.5 text-left">{t("sh_col_tier")}</th>
                <th className="px-2 py-1.5 text-left">{t("sh_col_action")}</th>
                <th className="px-2 py-1.5 text-left">{t("sh_col_actor")}</th>
                <th className="px-2 py-1.5 text-left">{t("sh_col_status")}</th>
                <th className="px-2 py-1.5 text-right">{t("sh_col_actions")}</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                // v1.1.108 — group rows under sticky date headers so a
                // long audit list stays scannable. The list is already
                // sorted newest-first; we emit a header tr each time
                // the share.date changes.
                const out: ReactNode[] = [];
                let lastDate = "";
                for (const share of sorted) {
                  if (share.date !== lastDate) {
                    out.push(
                      <tr key={`hdr-${share.date}`} className="bg-secondary/50 border-t border-border">
                        <td colSpan={7} className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                          {share.date}
                        </td>
                      </tr>,
                    );
                    lastDate = share.date;
                  }
                  const isOpen = openId === share.id;
                  const lastAction = [...(share.history ?? [])].reverse()[0];
                  const isFinal = share.status === "approved" && isFinalSchedule(share);
                  const isReject = share.status === "rejected";
                  out.push(
                    <FragmentRows
                      key={share.id}
                      share={share}
                      isOpen={isOpen}
                      isFinal={isFinal}
                      isReject={isReject}
                      lastAction={lastAction}
                      onToggle={() => setOpenId(isOpen ? null : share.id)}
                      t={t}
                    />,
                  );
                }
                return out;
              })()}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface FragmentRowsProps {
  share: ScheduleShare;
  isOpen: boolean;
  isFinal: boolean;
  isReject: boolean;
  lastAction: ScheduleShare["history"][number] | undefined;
  onToggle: () => void;
  t: (k: import("@/lib/i18n").Key) => string;
}

function FragmentRows({ share, isOpen, isFinal, isReject, lastAction, onToggle, t }: FragmentRowsProps) {
  const handlePrint = () => {
    // Open the row first if it's collapsed so the printable content
    // exists in the DOM, then trigger the browser print dialog.
    if (!isOpen) onToggle();
    setTimeout(() => window.print(), 80);
  };
  return (
    <>
      <tr className="border-t border-border" data-testid={`sh-row-${share.id}`}>
        <td className="px-2 py-1.5 font-mono whitespace-nowrap">{share.date}</td>
        <td className="px-2 py-1.5">{share.originSquadronName}</td>
        <td className="px-2 py-1.5 uppercase">{share.currentTier}</td>
        <td className="px-2 py-1.5">{lastAction?.action ?? "—"}</td>
        <td className="px-2 py-1.5 text-muted-foreground">
          {lastAction
            ? (composeIdentityLabel({
                rank: lastAction.byRank,
                displayName: lastAction.byDisplayName,
                username: lastAction.by,
                seatLabel: lastAction.bySeatLabel,
              }) || lastAction.by)
            : "—"}
        </td>
        <td className="px-2 py-1.5">
          {isFinal && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-200 text-[10px] font-semibold">
              <Check className="h-3 w-3" /> {t("sh_status_final")}
            </span>
          )}
          {isReject && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-200 text-[10px] font-semibold">
              <X className="h-3 w-3" /> {t("sh_status_rejected")}
            </span>
          )}
          {!isFinal && !isReject && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-200 text-[10px] font-semibold">
              {t("sh_status_inflight")}
            </span>
          )}
        </td>
        <td className="px-2 py-1.5 text-right">
          <div className="inline-flex items-center gap-1">
            <button
              type="button"
              onClick={onToggle}
              className="px-2 py-1 rounded bg-sky-500/20 border border-sky-400/40 text-sky-100 text-[11px] font-semibold inline-flex items-center gap-1"
              data-testid={`sh-view-${share.id}`}
            >
              {isOpen ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              {isOpen ? t("sh_hide") : t("sh_view")}
            </button>
            <button
              type="button"
              onClick={handlePrint}
              className="px-2 py-1 rounded bg-secondary text-foreground text-[11px] font-semibold inline-flex items-center gap-1"
              data-testid={`sh-print-${share.id}`}
              title={t("sh_print")}
            >
              <Printer className="h-3 w-3" /> {t("sh_print")}
            </button>
          </div>
        </td>
      </tr>
      {isOpen && (
        <tr className="bg-background/40">
          <td colSpan={7} className="p-3 space-y-3">
            {share.program ? (
              <FlightScheduleSheet
                prog={share.program}
                pilotOptions={[]}
                approvedAt={share.approvedAt}
                approvedBy={share.approvedBy}
                statusLabel={share.status}
              />
            ) : (
              <SimpleRowsTable share={share} />
            )}

            {share.history && share.history.length > 0 && (
              <div className="rounded border border-border">
                <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground bg-secondary/30">
                  {t("sh_decision_log")}
                </div>
                <ol className="divide-y divide-border text-xs">
                  {share.history.map((h, i) => (
                    <li key={i} className="px-3 py-1.5 flex items-center justify-between gap-3">
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {new Date(h.at).toLocaleString()}
                      </span>
                      <span className="font-semibold">{h.action}</span>
                      <span className="text-muted-foreground">
                        {composeIdentityLabel({
                          rank: h.byRank,
                          displayName: h.byDisplayName,
                          username: h.by,
                          seatLabel: h.bySeatLabel,
                        }) || h.by} · {h.tier}
                      </span>
                      <span className="flex-1 text-right truncate text-muted-foreground italic">
                        {h.note ?? ""}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function SimpleRowsTable({ share }: { share: ScheduleShare }) {
  const rows = share.rows ?? [];
  if (rows.length === 0) {
    return <div className="text-xs text-muted-foreground">No rows.</div>;
  }
  return (
    <div className="overflow-x-auto rounded border border-border">
      <table className="w-full text-xs">
        <thead className="text-[10px] uppercase tracking-wider text-muted-foreground bg-secondary/30">
          <tr>
            <th className="px-2 py-1 text-left">NO</th>
            <th className="px-2 py-1 text-left">D/N</th>
            <th className="px-2 py-1 text-left">A/C</th>
            <th className="px-2 py-1 text-left">PILOT</th>
            <th className="px-2 py-1 text-left">CO-PILOT</th>
            <th className="px-2 py-1 text-left">ROUTE</th>
            <th className="px-2 py-1 text-right">T/O</th>
            <th className="px-2 py-1 text-right">DUR</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => (
            <tr key={r.id ?? idx} className="border-t border-border">
              <td className="px-2 py-1 text-center font-mono">{idx + 1}</td>
              <td className="px-2 py-1 font-mono">{r.dn ?? ""}</td>
              <td className="px-2 py-1 font-mono">{r.ac}</td>
              <td className="px-2 py-1">{(r.crew ?? [])[0] ?? ""}</td>
              <td className="px-2 py-1">{(r.crew ?? [])[1] ?? ""}</td>
              <td className="px-2 py-1">{r.route ?? ""}</td>
              <td className="px-2 py-1 text-right font-mono">{r.takeoff ?? ""}</td>
              <td className="px-2 py-1 text-right font-mono">{r.dur ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
