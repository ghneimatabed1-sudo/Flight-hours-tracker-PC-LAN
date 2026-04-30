import { useMemo, useState } from "react";
import DateInput from "@/components/DateInput";
import MultiSegmentField, { splitQualificationSegments, joinQualificationSegments } from "@/components/MultiSegmentField";
import { RJAF_RANKS, lookupRankEn } from "@/lib/ranks";
import { Card, PageHead } from "@/components/Layout";
import { useI18n } from "@/lib/i18n";
import {
  useAllLinkedDevices,
  usePilots,
  useUpdatePilot,
  useCreatePilot,
  useDeletePilot,
  useTransferPilot,
  type Pilot,
} from "@/lib/squadron-data";
import { useDashSquadrons } from "@/lib/dash-pilots";
import { useAuth } from "@/lib/auth";
import { canTransferPilot, transferDestinationCandidates } from "@/lib/pilot-transfer-policy";
import { EMPTY_INITIAL_HOURS, sumInitialHours, type InitialHours } from "@/lib/mock";
import { getCurrencyWindow } from "@/lib/currency-settings";
import { recordAuditEvent } from "@/lib/supabase";
import { fmtDateTimeDDMM } from "@/lib/format";
import { Link } from "wouter";
import { Plus, Search, Pencil, Trash2, X, Loader2, FileDown, ArrowRightLeft } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DataUnavailableBanner } from "@/components/DataUnavailableBanner";

// Per-pilot phone-pair status sourced directly from `pilot_devices`.
//
// The dot is binary by design (per ops): GREEN means the pilot has at
// least one active (revoked_at = null) device row — i.e. their phone
// is paired right now. GRAY means no active pairing exists (never
// paired, or every pairing has been revoked). The freshness/last-seen
// nuance is intentionally NOT shown on the roster — that lives on the
// pilot detail page. Realtime + 30 s polling fallback keep the dot
// in sync without a manual refresh.
interface PairRow {
  pilot_id:  string;
  linked_at: string | null;
}
function usePilotPairing() {
  const devicesQ = useAllLinkedDevices();
  const data = useMemo(() => {
    const m = new Map<string, PairRow>();
    for (const r of devicesQ.data ?? []) {
      const row: PairRow = {
        pilot_id: String(r.pilotId ?? ""),
        linked_at: r.linkedAt ?? null,
      };
      const prev = m.get(row.pilot_id);
      if (!prev || (row.linked_at ?? "") > (prev.linked_at ?? "")) {
        m.set(row.pilot_id, row);
      }
    }
    return m;
  }, [devicesQ.data]);
  return { ...devicesQ, data };
}
function pairDotInfo(row: PairRow | undefined):
  { color: string; label: string; tooltip: string } {
  if (!row) {
    return { color: "bg-zinc-500", label: "Not paired", tooltip: "Not paired" };
  }
  const when = row.linked_at ? fmtDateTimeDDMM(row.linked_at) : "—";
  return {
    color: "bg-emerald-500",
    label: "Paired",
    tooltip: `Paired ${when}`,
  };
}

export default function Roster() {
  const { t, rankOf } = useI18n();
  const [q, setQ] = useState("");
  const [importedOnly, setImportedOnly] = useState(false);
  const pilotsQ = usePilots();
  const { data: PILOTS, isLoading, isFetching } = pilotsQ;
  const syncQ = usePilotPairing();
  const updatePilot = useUpdatePilot();
  const createPilot = useCreatePilot();
  const deletePilot = useDeletePilot();
  const transferPilot = useTransferPilot();
  const allSquadrons = useDashSquadrons();
  const { user } = useAuth();
  const [editing, setEditing] = useState<Pilot | null>(null);
  const [adding, setAdding] = useState<Pilot | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Pilot | null>(null);
  const [transferring, setTransferring] = useState<Pilot | null>(null);
  const [err, setErr] = useState("");
  // Who can move a pilot between squadrons? See pilot-transfer-policy.ts —
  // ops/deputy/admin/super_admin only. The same predicate is asserted by
  // supabase/tests/test-pilot-transfer-rpc.ts so any drift fails the test.
  const canTransfer = canTransferPilot(user);
  const actor = user?.username;

  const blankPilot = (): Pilot => {
    const nextId = (() => {
      const nums = PILOTS.map(p => parseInt(p.id.replace(/\D/g, ""), 10)).filter(n => !isNaN(n));
      const max = nums.length ? Math.max(...nums) : 0;
      return `P${String(max + 1).padStart(3, "0")}`;
    })();
    return {
      id: nextId,
      name: "",
      arabicName: "",
      militaryNumber: "",
      rank: "",
      rankEn: "",
      phone: "",
      address: "",
      unit: "SQDN",
      openingDay: 0,
      openingNight: 0,
      openingNvg: 0,
      doctorNote: "",
      monthDay: 0,
      monthNight: 0,
      monthNvg: 0,
      monthSim: 0,
      monthCaptain: 0,
      totalDay: 0,
      totalNight: 0,
      totalNvg: 0,
      totalSim: 0,
      totalCaptain: 0,
      expiry: { day: "", night: "", nvg: "", irt: "", medical: "", sim: "" },
      available: true,
      qualifications: [],
      lastSimDate: "",
    };
  };

  const list = PILOTS
    .filter(p => !importedOnly || p.imported)
    .filter(p => !q || (p.name + p.arabicName + p.id).toLowerCase().includes(q.toLowerCase()));
  const importedCount = PILOTS.filter(p => p.imported).length;

  // Military number is the primary identifier the pilot types on their
  // phone to pair the mobile app. It MUST be non-empty and unique across
  // the squadron — duplicates would let two pilots collide on the same
  // login and the mobile pairing flow would be ambiguous. We enforce it
  // here on every create/edit. (A matching DB-level unique index ensures
  // multi-PC writes can't race past this guard either.)
  const validateMilitaryNumber = (next: Pilot): string | null => {
    const mil = (next.militaryNumber ?? "").trim();
    if (!mil) {
      return t("err_militaryNumberRequired");
    }
    const lower = mil.toLowerCase();
    const dup = PILOTS.find(
      x => x.id !== next.id && (x.militaryNumber ?? "").trim().toLowerCase() === lower,
    );
    if (dup) {
      return `${t("err_militaryNumberDuplicate")} (${rankOf(dup)} ${dup.name} · ${dup.id})`;
    }
    return null;
  };

  const onSave = async (next: Pilot) => {
    setErr("");
    const v = validateMilitaryNumber(next);
    if (v) { setErr(v); return; }
    try {
      // Pass the original pilot (`prev`) so the audit log can compute a
      // precise field-level diff instead of a full-row dump. `actor` is
      // the current operator's username — surfaces in the audit feed as
      // the responsible party.
      await updatePilot.mutateAsync({
        pilot: { ...next, militaryNumber: (next.militaryNumber ?? "").trim() },
        prev: editing ?? undefined,
        actor,
      });
      setEditing(null);
    } catch (e) {
      setErr((e as Error).message || "Update failed");
    }
  };

  const onCreate = async (next: Pilot) => {
    setErr("");
    const v = validateMilitaryNumber(next);
    if (v) { setErr(v); return; }
    try {
      await createPilot.mutateAsync({
        pilot: { ...next, militaryNumber: (next.militaryNumber ?? "").trim() },
        actor,
      });
      setAdding(null);
    } catch (e) {
      setErr((e as Error).message || "Create failed");
    }
  };

  const onDelete = async () => {
    if (!confirmDelete) return;
    setErr("");
    try {
      await deletePilot.mutateAsync({
        id: confirmDelete.id,
        pilotName: confirmDelete.name,
        actor,
      });
      setConfirmDelete(null);
    } catch (e) {
      setErr((e as Error).message || "Delete failed");
    }
  };

  // The Roster always reflects the operator's own squadron (RLS gates
  // every pilots query to `squadron_id = public.squadron_id()`), so the
  // pilot's current home is the first squadron id on the signed-in
  // user. Used to filter the destination picker so the operator can't
  // accidentally "transfer" a pilot to where they already are.
  const currentSquadronId = user?.squadronIds?.[0];

  // Confirm + execute an inter-squadron transfer. Defers all the heavy
  // lifting to the SECURITY DEFINER `transfer_pilot` RPC (see
  // 0053_pilot_transfer.sql) which atomically re-homes the pilot's
  // sorties / currencies / leaves / unavailable rows and writes paired
  // audit_log entries on both squadrons.
  const onTransfer = async (toSquadronId: string) => {
    if (!transferring) return;
    setErr("");
    try {
      await transferPilot.mutateAsync({
        pilotId: transferring.id,
        toSquadronId,
        pilotName: transferring.name,
        fromSquadronId: currentSquadronId,
        actor,
      });
      setTransferring(null);
    } catch (e) {
      setErr((e as Error).message || "Transfer failed");
    }
  };

  return (
    <div>
      <PageHead title={t("nav_roster")} subtitle={`${list.length} / ${PILOTS.length} pilots${isFetching && !isLoading ? " · " + t("syncing") : ""}`} actions={
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setImportedOnly(v => !v)}
            disabled={importedCount === 0}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border ${importedOnly ? "bg-primary text-primary-foreground border-primary" : "bg-secondary text-foreground border-border"} disabled:opacity-40 disabled:cursor-not-allowed`}
            title={importedCount === 0 ? t("noImportedYet") : ""}
            data-testid="toggle-imported-only"
          >
            <FileDown className="h-3.5 w-3.5" /> {t("importedOnly")} ({importedCount})
          </button>
          <div className="relative">
            <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder={t("search")} className="pl-7 pr-2 py-1.5 rounded-md bg-input border border-border text-sm" />
          </div>
          <button
            onClick={() => setAdding(blankPilot())}
            data-testid="button-add-pilot"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90"
          >
            <Plus className="h-4 w-4" /> {t("add")}
          </button>
        </div>
      } />
      {err && <div className="mb-3 text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">{err}</div>}
      <DataUnavailableBanner queries={[pilotsQ]} testId="banner-roster-unavailable" />
      {isLoading && PILOTS.length === 0 && (
        <div className="flex items-center justify-center py-12 text-sm text-muted-foreground" data-testid="loading-pilots">
          <Loader2 className="h-4 w-4 me-2 animate-spin" /> {t("loading")}
        </div>
      )}
      <Card className="!p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-secondary/50 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-2 py-2 text-center w-6" title="Mobile sync indicator">●</th>
                <th className="px-3 py-2 text-left">{t("militaryNumber")}</th>
                <th className="px-3 py-2 text-left">{t("rank")}</th>
                <th className="px-3 py-2 text-left">{t("name")}</th>
                <th className="px-3 py-2 text-left">{t("arabicName")}</th>
                <th className="px-3 py-2 text-left">Unit</th>
                <th className="px-3 py-2 text-left">{t("phone")}</th>
                {/* The 3 legacy "Opening Day/Night/NVG" columns were removed
                    from the roster grid in v1.1.88. Initial Hours covers
                    the same purpose with clearer wording, and the legacy
                    fields are still summed into lifetime totals by
                    calculations.ts so no existing pilot data is lost. */}
                <th className="px-3 py-2 text-left">{t("doctorNote")}</th>
                <th className="px-3 py-2 text-right">{t("actions")}</th>
              </tr>
            </thead>
            <tbody>
              {list.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={12} className="px-3 py-6 text-center text-xs text-muted-foreground" data-testid="empty-pilots">
                    {pilotsQ.isError ? "—" : t("no_records")}
                  </td>
                </tr>
              )}
              {list.map((p: Pilot) => {
                const dot = pairDotInfo(syncQ.data?.get(p.id));
                return (
                <tr key={p.id} className="border-t border-border row-hover">
                  <td className="px-2 py-2 text-center" data-testid={`sync-dot-${p.id}`}>
                    <span
                      className={`inline-block h-2.5 w-2.5 rounded-full ${dot.color}`}
                      title={dot.tooltip}
                      aria-label={dot.label}
                    />
                  </td>
                  <td className="px-3 py-2 font-mono">
                    <span className="inline-flex items-center gap-1.5">
                      {p.militaryNumber || p.id}
                      {p.imported && (
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-400/15 border border-amber-400/40 text-amber-300 font-medium uppercase tracking-wider"
                          title={p.importedAt ? `Imported ${fmtDateTimeDDMM(p.importedAt)}` : t("importedBadge")}
                          data-testid={`badge-imported-${p.id}`}
                        >
                          {t("importedBadge")}
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-3 py-2">{rankOf(p)}</td>
                  <td className="px-3 py-2"><Link href={`/pilot/${p.id}`} className="hover:text-primary">{p.name}</Link></td>
                  <td className="px-3 py-2 text-right rtl:text-left">{p.arabicName}</td>
                  <td className="px-3 py-2"><span className="text-[11px] px-2 py-0.5 rounded-full bg-secondary border border-border">{p.unit}</span></td>
                  <td className="px-3 py-2 font-mono">{p.phone}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{p.doctorNote || "—"}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <button onClick={() => setEditing(p)} className="p-1.5 rounded hover:bg-secondary" title={t("edit")} data-testid={`button-edit-${p.id}`}>
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    {canTransfer && (
                      <button
                        onClick={() => setTransferring(p)}
                        className="p-1.5 rounded hover:bg-secondary"
                        title="Transfer to another squadron"
                        data-testid={`button-transfer-${p.id}`}
                      >
                        <ArrowRightLeft className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <button onClick={() => setConfirmDelete(p)} className="p-1.5 rounded hover:bg-destructive/20 text-destructive" title={t("delete")} data-testid={`button-delete-${p.id}`}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {editing && (
        <PilotEditDialog
          pilot={editing}
          onClose={() => setEditing(null)}
          onSave={onSave}
          saving={updatePilot.isPending}
        />
      )}

      {adding && (
        <PilotEditDialog
          pilot={adding}
          onClose={() => setAdding(null)}
          onSave={onCreate}
          saving={createPilot.isPending}
          isNew
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={t("delete") + " " + confirmDelete.name + "?"}
          message={`This will remove pilot ${confirmDelete.id} (${confirmDelete.name}). This action cannot be undone.`}
          confirmLabel={t("delete")}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={onDelete}
          busy={deletePilot.isPending}
          danger
        />
      )}

      {transferring && (
        <TransferPilotDialog
          pilot={transferring}
          fromSquadronId={currentSquadronId}
          squadrons={allSquadrons}
          onCancel={() => setTransferring(null)}
          onConfirm={onTransfer}
          busy={transferPilot.isPending}
        />
      )}
    </div>
  );
}

// ── Inter-squadron transfer dialog ────────────────────────────────────
// Lists every squadron the operator's PC knows about (minus the
// pilot's current home), with a confirmation step that spells out
// exactly what will move (sorties + currencies + leaves +
// unavailable). The actual transfer is one transactional RPC — see
// 0053_pilot_transfer.sql — so partial moves are impossible.
export function TransferPilotDialog({
  pilot,
  fromSquadronId,
  squadrons,
  onCancel,
  onConfirm,
  busy,
}: {
  pilot: Pilot;
  fromSquadronId: string | undefined;
  squadrons: { id: string; name: string; nameAr: string; code: string }[];
  onCancel: () => void;
  onConfirm: (toSquadronId: string) => void | Promise<void>;
  busy: boolean;
}) {
  const { lang } = useI18n();
  // Same source-squadron exclusion the regression test asserts. See
  // pilot-transfer-policy.ts.
  const candidates = transferDestinationCandidates(squadrons, fromSquadronId);
  const [target, setTarget] = useState<string>(candidates[0]?.id ?? "");
  const targetSqn = candidates.find(s => s.id === target);
  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
      onClick={onCancel}
      data-testid="overlay-pilot-transfer"
    >
      <div
        className="bg-card border border-border rounded-lg shadow-2xl w-full max-w-md"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="text-base font-semibold gold-grad">Transfer pilot — {pilot.id}</div>
          <button onClick={onCancel} className="p-1 rounded hover:bg-secondary"><X className="h-4 w-4" /></button>
        </div>
        <div className="p-4 space-y-4 text-sm">
          <div>
            Move <span className="font-medium">{pilot.name}</span> ({pilot.id}) to a different
            squadron. Their full record — sorties, currencies, leaves, and unavailable periods
            — is moved atomically and a transfer entry is written to the audit log on both
            squadrons.
          </div>
          {candidates.length === 0 ? (
            <div className="text-xs text-muted-foreground italic">
              No other squadrons available on this PC. Add a squadron first.
            </div>
          ) : (
            <label className="block text-xs">
              <span className="text-muted-foreground">Destination squadron</span>
              <select
                value={target}
                onChange={e => setTarget(e.target.value)}
                className="w-full mt-1 px-3 py-2 rounded-md bg-input border border-border text-sm"
                data-testid="select-transfer-destination"
              >
                {candidates.map(s => (
                  <option key={s.id} value={s.id}>
                    {(lang === "ar" ? s.nameAr : s.name) || s.code} ({s.code})
                  </option>
                ))}
              </select>
            </label>
          )}
          {targetSqn && (
            <div className="text-xs text-muted-foreground">
              Confirming will hand pilot <span className="font-mono">{pilot.id}</span> to{" "}
              <span className="font-medium">{lang === "ar" ? targetSqn.nameAr : targetSqn.name}</span>.
              They will disappear from this roster immediately.
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 p-4 border-t border-border">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1.5 rounded-md text-sm bg-secondary text-foreground border border-border disabled:opacity-50"
            data-testid="button-transfer-cancel"
          >
            Cancel
          </button>
          <button
            onClick={() => target && onConfirm(target)}
            disabled={!target || busy}
            className="px-3 py-1.5 rounded-md text-sm bg-primary text-primary-foreground font-medium disabled:opacity-50 inline-flex items-center gap-1.5"
            data-testid="button-transfer-confirm"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Transfer
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Currency helpers ────────────────────────────────────────────────────────
// Given a "last flown" date (ISO string) and a validity window in days,
// compute the expiry date (also ISO string). Returns "" when the input is
// empty or unparseable.
function computeExpiry(lastFlownIso: string, windowDays: number): string {
  if (!lastFlownIso) return "";
  const [y, m, d] = lastFlownIso.split("-").map(Number);
  if (!y || !m || !d) return "";
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + windowDays);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}
// Reverse: given an expiry date, recover the approximate last-flown date so
// the form shows something sensible when editing an existing pilot.
function computeLastFlown(expiryIso: string, windowDays: number): string {
  if (!expiryIso) return "";
  const [y, m, d] = expiryIso.split("-").map(Number);
  if (!y || !m || !d) return "";
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - windowDays);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}
function fmtDate(iso: string): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

// Six "Last X flown" cells the operator edits on Add/Edit Pilot:
//   Day / Night / NVG / Simulator (informational, no expiry window)
//   + Instrument (IRT, 365d) + Medical (365d).
// `irt` is the canonical key for the instrument check; `medical` is
// the canonical key for the annual medical exam. The `sim` slot is
// kept as a date input so squadron commanders can monitor simulator
// recency, but it has NO currency window — see `.local/memory/currency-refresh.md`.
interface LastFlown { day: string; night: string; nvg: string; irt: string; medical: string; sim: string; }

function PilotEditDialog({ pilot, onClose, onSave, saving, isNew }: { pilot: Pilot; onClose: () => void; onSave: (p: Pilot) => void; saving: boolean; isNew?: boolean }) {
  const { t, rankOf } = useI18n();
  const [p, setP] = useState<Pilot>(pilot);
  // Qualification editor state — segmented input replaces the legacy
  // comma-separated text box. We keep it in local state so the operator
  // can add/remove boxes and toggle the separator without touching the
  // pilot record until save. The separator is purely a display choice;
  // the underlying tags array stays the same.
  const [qualSegments, setQualSegments] = useState<string[]>(() =>
    splitQualificationSegments(pilot.qualifications),
  );
  const [qualSep, setQualSep] = useState<"/" | "-">(pilot.qualificationSeparator ?? "/");
  // INITIAL HOURS — eleven-bucket baseline of pre-Hawk-Eye lifetime hours.
  // See `.local/memory/initial-hours.md` for the canonical rule. Folds into
  // lifetime totals only — never touches currency or Monthly Report.
  const [initialHours, setInitialHours] = useState<InitialHours>(
    pilot.initialHours ?? { ...EMPTY_INITIAL_HOURS },
  );
  const [ihExpanded, setIhExpanded] = useState<boolean>(false);
  // First-time confirmation: when the operator changes any baseline value
  // for the first time on this open, we hold submit and show a dialog
  // making the consequences explicit ("This adds NNN.N h to lifetime
  // totals; currency and Monthly Report are NOT affected"). Once they
  // confirm, subsequent saves on the same open skip the dialog.
  const baselineDirty = JSON.stringify(initialHours) !== JSON.stringify(pilot.initialHours ?? EMPTY_INITIAL_HOURS);
  const [baselineConfirmed, setBaselineConfirmed] = useState<boolean>(false);
  const [pendingBaselineConfirm, setPendingBaselineConfirm] = useState<boolean>(false);
  const currencyWin = getCurrencyWindow();

  // lastFlown is the UI state — what the operator types. On save we convert
  // to expiry dates (lastFlown + window) before passing to onSave, so the
  // rest of the system (auto-bump, Currency page, Reminders) is unchanged.
  const [lastFlown, setLastFlown] = useState<LastFlown>(() => ({
    day:         computeLastFlown(pilot.expiry.day,                 currencyWin.day),
    night:       computeLastFlown(pilot.expiry.night,               currencyWin.night),
    nvg:         computeLastFlown(pilot.expiry.nvg,                 currencyWin.nvg),
    irt:         computeLastFlown(pilot.expiry.irt,                 currencyWin.instrument),
    medical:     computeLastFlown(pilot.expiry.medical,             currencyWin.medical),
    // Sim is informational only — store the raw last-flown date directly
    // (no window subtraction) so the round-trip preserves what the
    // commander typed.
    sim:         pilot.lastSimDate ?? "",
  }));

  // Functional updater — without this, rapid keystrokes can read a stale `p`
  // closure when React batches updates inside Electron's renderer, making
  // the field appear "frozen" after the first character. Reported by ops.
  const set = <K extends keyof Pilot>(k: K, v: Pilot[K]) => setP(prev => ({ ...prev, [k]: v }));

  const setLF = (k: keyof LastFlown, v: string) => setLastFlown(prev => ({ ...prev, [k]: v }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    // Convert last-flown dates → expiry dates using the configured windows.
    // Sim has NO currency window — operator-only monitoring date that
    // round-trips through pilot.lastSimDate (set further down). The
    // legacy `missionQual` slot was retired in v1.1.77 in favour of the
    // proper Medical currency.
    const expiry = {
      day:         computeExpiry(lastFlown.day,         currencyWin.day),
      night:       computeExpiry(lastFlown.night,       currencyWin.night),
      nvg:         computeExpiry(lastFlown.nvg,         currencyWin.nvg),
      irt:         computeExpiry(lastFlown.irt,         currencyWin.instrument),
      medical:     computeExpiry(lastFlown.medical,     currencyWin.medical),
      sim:         "",
    };
    // Fold the segmented qualification editor back into both shapes:
    // - `qualifications` (string[]) keeps every render site working.
    // - `qualification`  (joined string with the operator's chosen
    //   separator) is the canonical persisted value per task #108.
    // - `qualificationSeparator` round-trips the toggle choice.
    const qualifications = joinQualificationSegments(qualSegments);
    const qualification = qualifications.join(` ${qualSep} `);
    // The dedicated "Last Sim" currency input (one of the 6) doubles as
    // the commander-only `lastSimDate` field — keep them in sync on save
    // so the visibility-restricted view still has a value.
    // Sim is now a pure monitoring date — operator's input lives only in
    // p.lastSimDate (commander-only view), never in expiry.sim.
    const lastSimDate = lastFlown.sim || "";
    // First-time baseline confirmation gate. We block the actual save and
    // surface the warning dialog. The operator confirms (or cancels) and
    // then submit() runs again with `baselineConfirmed === true`.
    if (baselineDirty && !baselineConfirmed) {
      setPendingBaselineConfirm(true);
      return;
    }
    // Only persist initialHours if it has any non-zero value; an all-zero
    // baseline is functionally identical to "not set" and we'd rather not
    // pollute the JSONB with empty objects on every plain-edit save.
    const ihToPersist = sumInitialHours(initialHours) > 0 ? initialHours : undefined;
    // Audit log — `.local/memory/initial-hours.md` requires every baseline
    // edit to write a `pilot:initial_hours` audit row capturing actor and
    // before/after. Fire-and-forget; the save itself shouldn't block on
    // the audit insert.
    if (baselineDirty) {
      void recordAuditEvent({
        type: "pilot:initial_hours",
        actor: undefined,
        detail: {
          pilotId: p.id,
          pilotName: p.name,
          before: pilot.initialHours ?? null,
          after: ihToPersist ?? null,
          deltaHours: +(sumInitialHours(initialHours) - sumInitialHours(pilot.initialHours)).toFixed(1),
        },
      }).catch(() => { /* swallow — audit is best-effort */ });
    }
    onSave({ ...p, expiry, qualifications, qualification, qualificationSeparator: qualSep, lastSimDate, initialHours: ihToPersist });
  };
  return (
    // NOTE: no backdrop-blur. Chromium's backdrop-filter on Windows w/ HW
    // accel can intermittently swallow keyboard events from inputs sitting
    // *behind* it (the inputs render in their own compositor layer). Pure
    // black/60 is just as visible and never breaks input.
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose} data-testid="overlay-pilot-edit">
      <div className="bg-card border border-border rounded-lg shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="text-base font-semibold gold-grad">{isNew ? t("add") : t("edit")} — {p.id}</div>
          <button onClick={onClose} className="p-1 rounded hover:bg-secondary"><X className="h-4 w-4" /></button>
        </div>
        <form onSubmit={submit} className="p-4 space-y-3" data-testid="form-edit-pilot">
          <div className="grid grid-cols-2 gap-3">
            {isNew && (
              <Field label="ID" value={p.id} onChange={v => set("id", v)} testId="input-id" autoFocus />
            )}
            <Field label={t("callSign")} value={p.callSign || ""} onChange={v => set("callSign", v)} testId="input-callSign" autoFocus={!isNew} />
            <Field label={t("flightName")} value={p.flightName || ""} onChange={v => set("flightName", v)} testId="input-flightName" />
            <Field label={t("name")} value={p.name} onChange={v => set("name", v)} testId="input-name" />
            <Field label={t("arabicName")} value={p.arabicName} onChange={v => set("arabicName", v)} testId="input-arabicName" />
            <Field label={`${t("militaryNumber")} *`} value={p.militaryNumber || ""} onChange={v => set("militaryNumber", v)} testId="input-militaryNumber" required />
            <label className="block text-xs">
              <span className="text-muted-foreground">{t("rank")} (AR)</span>
              <input
                type="text"
                list="rjaf-rank-list-ar"
                // CRITICAL: bind to the canonical Arabic rank, not the
                // English render value. `rankOf(p)` resolves to the
                // English string in EN mode; using it here would cause
                // typing in this box to overwrite `p.rank` with English
                // text and corrupt the canonical Arabic rank column.
                value={p.rank}
                onChange={e => {
                  const next = e.target.value;
                  setP(prev => {
                    const auto = lookupRankEn(next);
                    // Only auto-fill English rank when (a) the AR rank
                    // resolves to a known English value, AND (b) the
                    // operator hasn't customised the English rank yet
                    // (or the previous English value was the auto-fill
                    // for the previous AR rank). Prevents wiping a
                    // manual override when the operator tabs through
                    // the form.
                    const prevAuto = lookupRankEn(prev.rank);
                    const englishLooksAuto = !prev.rankEn || prev.rankEn === prevAuto;
                    return {
                      ...prev,
                      rank: next,
                      rankEn: englishLooksAuto && auto ? auto : (prev.rankEn ?? ""),
                    };
                  });
                }}
                placeholder="رائد طيار"
                data-testid="input-rank"
                className="w-full mt-1 px-3 py-2 rounded-md bg-input border border-border text-sm"
              />
              <datalist id="rjaf-rank-list-ar">
                {RJAF_RANKS.map(r => (
                  <option key={r.ar} value={r.ar}>{r.en}</option>
                ))}
              </datalist>
            </label>
            <Field label={`${t("rank")} (EN)`} value={p.rankEn || ""} onChange={v => set("rankEn", v)} testId="input-rankEn" />
            <Field label={t("phone")} value={p.phone} onChange={v => set("phone", v)} testId="input-phone" />
            <label className="block text-xs col-span-2">
              <span className="text-muted-foreground">Unit</span>
              <select value={p.unit} onChange={e => set("unit", e.target.value as Pilot["unit"])} className="w-full mt-1 px-3 py-2 rounded-md bg-input border border-border text-sm" data-testid="select-unit">
                <option value="SQDN">SQDN</option>
                <option value="HQ Attached">HQ Attached</option>
                <option value="UH-60M">UH-60M</option>
                <option value="UH-60AIL">UH-60AIL</option>
                <option value="Both">Both</option>
                <option value="RCN">RCN</option>
                <option value="Other">Other</option>
              </select>
            </label>
            <Field label={t("address")} value={p.address || ""} onChange={v => set("address", v)} testId="input-address" />
            <Field label={t("doctorNote")} value={p.doctorNote || ""} onChange={v => set("doctorNote", v)} testId="input-doctorNote" />
            <label className="block text-xs col-span-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">{t("qualifications")}</span>
                <div className="inline-flex items-center gap-1 text-[10px]">
                  <span className="text-muted-foreground">Separator:</span>
                  <button
                    type="button"
                    onClick={() => setQualSep("/")}
                    aria-pressed={qualSep === "/"}
                    data-testid="qual-sep-slash"
                    className={`px-2 py-0.5 rounded font-mono border ${qualSep === "/" ? "bg-primary text-primary-foreground border-primary" : "bg-secondary border-border text-muted-foreground"}`}
                  >/</button>
                  <button
                    type="button"
                    onClick={() => setQualSep("-")}
                    aria-pressed={qualSep === "-"}
                    data-testid="qual-sep-dash"
                    className={`px-2 py-0.5 rounded font-mono border ${qualSep === "-" ? "bg-primary text-primary-foreground border-primary" : "bg-secondary border-border text-muted-foreground"}`}
                  >-</button>
                </div>
              </div>
              <div className="mt-1">
                <MultiSegmentField
                  value={qualSegments}
                  onChange={setQualSegments}
                  separator={qualSep}
                  testIdPrefix="input-qualification"
                  placeholder="AC"
                />
              </div>
              <span className="block mt-1 text-[10px] text-muted-foreground">{t("qualificationsHelp")}</span>
            </label>
          </div>
          <InitialHoursSection
            value={initialHours}
            onChange={setInitialHours}
            expanded={ihExpanded}
            onToggle={() => setIhExpanded(v => !v)}
          />
          {/* Legacy "Opening Day/Night/NVG" hour fields were removed from
              the editor in v1.1.88. Initial Hours (above) covers the same
              purpose. Existing legacy values continue to add into lifetime
              totals via calculations.ts so no historic data is lost — the
              fields are simply hidden from the operator-facing form. */}
          <div className="grid grid-cols-3 gap-3 pt-2 border-t border-border">
            <div className="col-span-3">
              <div className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">Last Currency Flown</div>
              <div className="text-[11px] text-muted-foreground mt-1">
                Enter the <strong>date the check/flight was last performed</strong>. The expiry is calculated automatically
                using the currency windows configured in Settings (Day: {currencyWin.day}d · Night: {currencyWin.night}d · NVG: {currencyWin.nvg}d · Instrument: {currencyWin.instrument}d · Medical: {currencyWin.medical}d). Simulator is monitored only — no window.
              </div>
            </div>
            {([
              { label: "Last Day flown",     k: "day"     as const, days: currencyWin.day        },
              { label: "Last Night flown",   k: "night"   as const, days: currencyWin.night      },
              { label: "Last NVG flown",     k: "nvg"     as const, days: currencyWin.nvg        },
              { label: "Last Simulator",     k: "sim"     as const, days: 0                      },
              { label: "Last Instrument",    k: "irt"     as const, days: currencyWin.instrument },
              { label: "Last Medical",       k: "medical" as const, days: currencyWin.medical    },
            ] as { label: string; k: keyof LastFlown; days: number }[]).map(({ label, k, days }) => {
              // Sim has no expiry — surface only the raw date and a
              // "monitor only" hint. Every other slot computes its
              // expiry from the configured window.
              const isMonitorOnly = k === "sim";
              const expiry = isMonitorOnly ? "" : computeExpiry(lastFlown[k], days);
              return (
                <label key={k} className="block text-xs" data-testid={`field-currency-${k}`}>
                  <span className="text-muted-foreground">{label}</span>
                  <DateInput
                    value={lastFlown[k]}
                    onChange={(v) => setLF(k, v)}
                    data-testid={`input-lastFlown-${k}`}
                    className="w-full mt-1 px-3 py-2 rounded-md bg-input border border-border text-sm"
                  />
                  {isMonitorOnly ? (
                    <span className="block mt-0.5 text-[10px] text-muted-foreground/70 italic">
                      Monitor only — no currency window
                    </span>
                  ) : expiry ? (
                    <span className="block mt-0.5 text-[10px] text-emerald-400">
                      → Expires: {fmtDate(expiry)} ({days}d window)
                    </span>
                  ) : (
                    <span className="block mt-0.5 text-[10px] text-muted-foreground/50">No date set</span>
                  )}
                </label>
              );
            })}
          </div>
          <div className="text-[11px] text-muted-foreground -mt-1">
            {t("lastSimDateHelp")} · <span className="italic">{t("lastSimDateVisibility")}</span>
          </div>
          <div className="flex items-center justify-end gap-2 pt-3 border-t border-border">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-md bg-secondary border border-border text-sm">{t("cancel")}</button>
            <button type="submit" disabled={saving} className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50" data-testid="button-save-pilot">
              {saving ? t("syncing") : t("save_changes")}
            </button>
          </div>
        </form>
      </div>
      {pendingBaselineConfirm && (
        <BaselineConfirmDialog
          delta={sumInitialHours(initialHours) - sumInitialHours(pilot.initialHours)}
          newTotal={sumInitialHours(initialHours)}
          onCancel={() => setPendingBaselineConfirm(false)}
          onConfirm={() => {
            setBaselineConfirmed(true);
            setPendingBaselineConfirm(false);
            // Re-trigger the form submit now that the gate is open. We
            // call submit directly with a synthetic event to skip having
            // to round-trip through the DOM.
            setTimeout(() => submit({ preventDefault: () => {} } as React.FormEvent), 0);
          }}
        />
      )}
    </div>
  );
}

// ── Initial Hours collapsible section ─────────────────────────────
// Pre-Hawk-Eye baseline hours per pilot. Folds into lifetime totals
// only — never into currency or Monthly Report.
// See `.local/memory/initial-hours.md` for the canonical rule.
function InitialHoursSection({
  value,
  onChange,
  expanded,
  onToggle,
}: {
  value: InitialHours;
  onChange: (v: InitialHours) => void;
  expanded: boolean;
  onToggle: () => void;
}) {
  const total = sumInitialHours(value);
  const dayHours   = (value.day1 ?? 0)   + (value.day2 ?? 0)   + (value.dayDual ?? 0);
  const nightHours = (value.night1 ?? 0) + (value.night2 ?? 0) + (value.nightDual ?? 0);
  const nvgHours   = (value.nvg1 ?? 0)   + (value.nvg2 ?? 0)   + (value.nvgDual ?? 0);
  const plt1 = (value.day1 ?? 0) + (value.night1 ?? 0) + (value.nvg1 ?? 0);
  const plt2 = (value.day2 ?? 0) + (value.night2 ?? 0) + (value.nvg2 ?? 0);
  const set = <K extends keyof InitialHours>(k: K, v: number) =>
    onChange({ ...value, [k]: v });

  return (
    <div className="pt-2 border-t border-border" data-testid="section-initial-hours">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="w-full flex items-center justify-between gap-2 text-left px-2 py-2 rounded-md hover:bg-secondary/40"
        data-testid="toggle-initial-hours"
      >
        <div>
          <div className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">Initial Hours</div>
          <div className="text-[10px] text-muted-foreground/80">Pre-Hawk-Eye lifetime flight time (Day + Night + NVG) · CAP and Instrument are overlay labels, shown separately · does not affect currency or Monthly Report</div>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm tabular-nums text-emerald-300" data-testid="text-initial-hours-total">
            {total.toFixed(1)} h
          </span>
          <span className="text-muted-foreground text-xs">{expanded ? "▾" : "▸"}</span>
        </div>
      </button>
      {expanded && (
        <div className="mt-2 space-y-3 pl-2 pr-1">
          {/* Live derived summary — mirrors the operator's previous mobile
              app screen so the numbers feel familiar. */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[11px] font-mono px-2 py-2 rounded-md bg-secondary/30 border border-border/60">
            <div className="flex justify-between"><span className="text-muted-foreground">Total Flight Hours</span><span className="text-emerald-300">{total.toFixed(1)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">CAP (Captain)</span><span>{(value.captain ?? 0).toFixed(1)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Day Hours</span><span>{dayHours.toFixed(1)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Night Hours</span><span>{nightHours.toFixed(1)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">NVG Hours</span><span>{nvgHours.toFixed(1)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Instrument Hours</span><span>{(value.instrument ?? 0).toFixed(1)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">1st PLT Hours</span><span>{plt1.toFixed(1)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">2nd PLT Hours</span><span>{plt2.toFixed(1)}</span></div>
          </div>
          {/* Day group */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Day</div>
            <div className="grid grid-cols-3 gap-3">
              <NumField label="Day 1st PLT" value={value.day1} onChange={v => set("day1", v)} testId="input-ih-day1" />
              <NumField label="Day 2nd PLT" value={value.day2} onChange={v => set("day2", v)} testId="input-ih-day2" />
              <NumField label="Dual Day" value={value.dayDual} onChange={v => set("dayDual", v)} testId="input-ih-dayDual" />
            </div>
          </div>
          {/* Night group */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Night</div>
            <div className="grid grid-cols-3 gap-3">
              <NumField label="Night 1st PLT" value={value.night1} onChange={v => set("night1", v)} testId="input-ih-night1" />
              <NumField label="Night 2nd PLT" value={value.night2} onChange={v => set("night2", v)} testId="input-ih-night2" />
              <NumField label="Dual Night" value={value.nightDual} onChange={v => set("nightDual", v)} testId="input-ih-nightDual" />
            </div>
          </div>
          {/* NVG group */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">NVG</div>
            <div className="grid grid-cols-3 gap-3">
              <NumField label="NVG 1st PLT" value={value.nvg1} onChange={v => set("nvg1", v)} testId="input-ih-nvg1" />
              <NumField label="NVG 2nd PLT" value={value.nvg2} onChange={v => set("nvg2", v)} testId="input-ih-nvg2" />
              <NumField label="Dual NVG" value={value.nvgDual} onChange={v => set("nvgDual", v)} testId="input-ih-nvgDual" />
            </div>
          </div>
          {/* Specials */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Specials</div>
            <div className="grid grid-cols-2 gap-3">
              <NumField label="CAP (Captain Hours)" value={value.captain} onChange={v => set("captain", v)} testId="input-ih-captain" />
              <NumField label="Instrument Hours" value={value.instrument} onChange={v => set("instrument", v)} testId="input-ih-instrument" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// First-time confirmation dialog the operator sees the first time they
// touch any baseline value on a given open of the Edit Pilot dialog.
function BaselineConfirmDialog({
  delta,
  newTotal,
  onCancel,
  onConfirm,
}: {
  delta: number;
  newTotal: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const sign = delta >= 0 ? "+" : "−";
  const magnitude = Math.abs(delta).toFixed(1);
  return (
    <div className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-4" onClick={onCancel} data-testid="overlay-baseline-confirm">
      <div className="bg-card border border-border rounded-lg shadow-2xl w-full max-w-md p-5 space-y-4" onClick={e => e.stopPropagation()}>
        <div className="text-base font-semibold gold-grad">Confirm baseline change</div>
        <div className="text-sm space-y-2">
          <p>
            This will <strong>{sign}{magnitude} h</strong> the pilot's baseline.
            New baseline: <span className="font-mono text-emerald-300">{newTotal.toFixed(1)} h</span>.
          </p>
          <p className="text-muted-foreground text-xs">
            Baseline hours add to lifetime totals (Ranking & Totals, the pilot's printed record).
            They do <strong>NOT</strong> affect currency dates and they are <strong>NOT</strong> included in the Monthly Report.
          </p>
        </div>
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
          <button type="button" onClick={onCancel} className="px-4 py-2 rounded-md bg-secondary border border-border text-sm" data-testid="button-baseline-cancel">Cancel</button>
          <button type="button" onClick={onConfirm} className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium" data-testid="button-baseline-confirm">Continue</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, type = "text", testId, autoFocus, required }: { label: string; value: string; onChange: (v: string) => void; type?: string; testId?: string; autoFocus?: boolean; required?: boolean }) {
  return (
    <label className="block text-xs">
      <span className="text-muted-foreground">{label}</span>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        data-testid={testId}
        autoComplete="off"
        autoFocus={autoFocus}
        required={required}
        className="w-full mt-1 px-3 py-2 rounded-md bg-input border border-border text-sm"
      />
    </label>
  );
}

function NumField({ label, value, onChange, testId }: { label: string; value: number; onChange: (v: number) => void; testId?: string }) {
  return (
    <label className="block text-xs">
      <span className="text-muted-foreground">{label}</span>
      <input type="number" step="0.1" value={value} onChange={e => onChange(parseFloat(e.target.value) || 0)} data-testid={testId} className="w-full mt-1 px-3 py-2 rounded-md bg-input border border-border text-sm font-mono" />
    </label>
  );
}

