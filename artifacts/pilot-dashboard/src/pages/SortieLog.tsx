import { useMemo, useState } from "react";
import DateInput from "@/components/DateInput";
import { Card, PageHead } from "@/components/Layout";
import { useI18n } from "@/lib/i18n";
import { usePilots, useSorties, useUpdateSortie, useDeleteSortie, useRestoreSortie } from "@/lib/squadron-data";
import { useAuth } from "@/lib/auth";
import { loadSquadronDefaults } from "@/lib/squadron-defaults";
import { DataUnavailableBanner } from "@/components/DataUnavailableBanner";
import { SortieDiffDialog } from "@/components/SortieDiffDialog";
import { showUndo } from "@/lib/undo-store";
import { useToast } from "@/hooks/use-toast";
import { Search, Filter, Pencil, Trash2, Lock, Unlock, Calendar, X as XIcon, Printer, FileDown } from "lucide-react";
import { fmtDateTimeDDMM } from "@/lib/format";
import { PrintHeader } from "@/components/PrintHeader";
import type { Pilot, Sortie } from "@/lib/mock";
import { useFrozenAccess } from "@/lib/monthly-close";

export default function SortieLog() {
  const { t, rankOf } = useI18n();
  const { user, squadron } = useAuth();
  const sqdnDefaults = useMemo(
    () => loadSquadronDefaults(squadron?.number),
    [squadron?.number],
  );
  const acTypeOptions = sqdnDefaults.airframes.length
    ? sqdnDefaults.airframes
    : ["UH-60M", "UH-60L", "UH-60AIL", "AS332"];
  const [q, setQ] = useState("");
  const [type, setType] = useState("All");
  // "Imported only" toggle — mirrors the same control on the Roster page so
  // operators reviewing a fresh CSV migration can flick to just the rows
  // tagged by `useImportLegacy`. Disabled while no migrated sorties exist
  // so the chip never lies about what it'll filter to.
  const [importedOnly, setImportedOnly] = useState(false);
  // Sortie date picker — defaults to today, blank means "all days".
  // Operators flick this to review any past day's flying or to peek at
  // pre-scheduled sorties on a future date.
  const todayIso = useMemo(() => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }, []);
  const [pickedDate, setPickedDate] = useState<string>(todayIso);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [editing, setEditing] = useState<Sortie | null>(null);
  const [deleting, setDeleting] = useState<Sortie | null>(null);
  // Stage of the diff/undo flow once the inline edit form has been
  // submitted: holds the proposed `after` so the change-summary dialog
  // can render the before/after comparison before commit.
  const [pendingEdit, setPendingEdit] = useState<{ before: Sortie; after: Sortie } | null>(null);
  const pilotsQ = usePilots();
  const sortiesQ = useSorties();
  const { data: PILOTS } = pilotsQ;
  const { data: SORTIES } = sortiesQ;
  const updateMut = useUpdateSortie();
  const deleteMut = useDeleteSortie();
  const restoreMut = useRestoreSortie();
  const { toast } = useToast();
  const frozen = useFrozenAccess();

  const lockedMessage =
    "Hours older than 12 months are frozen. Ask the super admin to authorize this PC from Settings.";
  const tryEdit = (s: Sortie) => {
    if (!frozen.canEdit(s.date)) {
      toast({ title: "Frozen records", description: lockedMessage, variant: "destructive" });
      return;
    }
    setEditing(s);
  };
  const tryDelete = (s: Sortie) => {
    if (!frozen.canEdit(s.date)) {
      toast({ title: "Frozen records", description: lockedMessage, variant: "destructive" });
      return;
    }
    setDeleting(s);
  };

  const pilotMap = useMemo(() => Object.fromEntries(PILOTS.map(p => [p.id, p.name])), [PILOTS]);
  const types = useMemo(() => ["All", ...Array.from(new Set(SORTIES.map(s => s.sortieType)))], [SORTIES]);
  const nameOf = (id: string, ext?: { name: string; squadron: string }) => ext ? `${ext.name}${ext.squadron ? ` (${ext.squadron})` : ""}` : (pilotMap[id] || "");

  const rows = SORTIES
    .filter(s => !pickedDate || s.date === pickedDate)
    .filter(s => type === "All" || s.sortieType === type)
    .filter(s => !importedOnly || s.imported)
    .filter(s => !q || (nameOf(s.pilotId, s.pilotExternal) + " " + nameOf(s.coPilotId, s.coPilotExternal) + " " + s.acNumber + " " + s.name).toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => b.date.localeCompare(a.date));
  const importedCount = useMemo(() => SORTIES.filter(s => s.imported).length, [SORTIES]);

  // ── Paper-form field derivations ───────────────────────────────────────
  // The Squadron Sortie Log on paper uses a specific column layout
  // (Action Before Flight | Action After Flight). We keep the underlying
  // data identical — pilot hours, currencies and all downstream reports
  // continue to use the legacy numeric buckets — but the visible columns
  // here match the paper form one-for-one. Fields that the Add Sortie
  // form does not yet capture (initials, take-off/landed clock times,
  // S/B, N/F, Sign) render as "—" until we capture them; the calculation
  // side is untouched.
  const DASH = "—";
  // "Captain Of Aircraft And Pilot" — whichever seat carries the captain
  // flag; fall back to the 1st-seat pilot when neither flag is set (older
  // records). Shows both names separated when captain is the 2nd seat.
  const captainPilot = (s: Sortie) => {
    if (s.coPilotIsCaptain && !s.pilotIsCaptain)
      return nameOf(s.coPilotId, s.coPilotExternal);
    return nameOf(s.pilotId, s.pilotExternal);
  };
  // "CREW" — the non-captain seat. External pilots keep their "(squadron)"
  // tag so the ops officer can tell them apart at a glance.
  const crewOf = (s: Sortie) => {
    if (s.coPilotIsCaptain && !s.pilotIsCaptain)
      return nameOf(s.pilotId, s.pilotExternal);
    return nameOf(s.coPilotId, s.coPilotExternal);
  };
  // "DUTY OR PRACTICE ORDER" — sortie-type + name (e.g. "Training — NVG
  // pattern"). msnDuty (the newer free-text field) wins when present.
  const dutyOrder = (s: Sortie) => {
    if (s.msnDuty && s.msnDuty.trim()) return s.msnDuty.trim();
    const parts = [s.sortieType, s.name].filter(Boolean);
    return parts.join(" — ") || DASH;
  };
  // "APPROXIMATE Duration of Flight" — the ops-entered flight time. Uses
  // the same number the hours engine already derives D1/D2/DD/... from.
  const fmtHrs = (n: number | undefined) =>
    typeof n === "number" && n > 0 ? n.toFixed(1) : DASH;
  const durationOf = (s: Sortie) => {
    if (typeof s.time === "number" && s.time > 0) return fmtHrs(s.time);
    // Legacy records: reconstruct from the 9-bucket breakdown.
    const sum = [s.day1, s.day2, s.dayDual, s.night1, s.night2, s.nightDual, s.nvg]
      .reduce((a, b) => a + (b || 0), 0);
    return fmtHrs(sum);
  };
  // "ACTUAL INSTRUMENT FLY — In The Air" — total IF hours logged on the
  // sortie. When instrumentFlight=true, that is the full sortie duration;
  // when SIM/ACT are broken out independently we sum those instead.
  const ifAir = (s: Sortie) => {
    if (s.instrumentFlight && typeof s.time === "number") return fmtHrs(s.time);
    const sum = (s.ifSim || 0) + (s.ifAct || 0);
    return sum > 0 ? fmtHrs(sum) : DASH;
  };
  // "IF APPROACHES — TYPE / NO." — derived from the existing ILS/VOR
  // counters that AddSortie already captures. Type cell lists the kinds
  // flown, No. cell shows the total count.
  const ifApprType = (s: Sortie) => {
    const kinds: string[] = [];
    if ((s.ils ?? 0) > 0) kinds.push("ILS");
    if ((s.vor ?? 0) > 0) kinds.push("VOR");
    return kinds.length ? kinds.join("+") : DASH;
  };
  const ifApprNo = (s: Sortie) => {
    const n = (s.ils ?? 0) + (s.vor ?? 0);
    return n > 0 ? String(n) : DASH;
  };
  // "Duty Carried out And Reason for not" — free-text remarks field.
  const dutyDone = (s: Sortie) => (s.remarks && s.remarks.trim()) || DASH;

  const snapshotPilots = (s: Sortie): Pilot[] => {
    const ids = [s.pilotId, s.coPilotId].filter(Boolean);
    return ids
      .map(id => PILOTS.find(p => p.id === id))
      .filter((p): p is Pilot => !!p)
      .map(p => structuredClone(p));
  };

  const registerUndo = (snapshot: { sortie: Sortie; pilots: Pilot[] }, label: string) => {
    showUndo({
      message: label,
      undo: async () => {
        try {
          await restoreMut.mutateAsync({
            sortie: snapshot.sortie,
            pilots: snapshot.pilots,
            actor: user?.username,
            reason: "undo",
          });
          toast({ title: "Action undone" });
        } catch {
          toast({ title: "Undo failed", variant: "destructive" });
        }
      },
    });
  };

  const onConfirmDelete = async () => {
    if (!deleting) return;
    const snapshot = { sortie: deleting, pilots: snapshotPilots(deleting) };
    await deleteMut.mutateAsync({ id: deleting.id, date: deleting.date, actor: user?.username });
    setDeleting(null);
    registerUndo(snapshot, "Sortie deleted.");
  };

  const onConfirmEdit = async () => {
    if (!pendingEdit) return;
    const snapshot = { sortie: pendingEdit.before, pilots: snapshotPilots(pendingEdit.before) };
    await updateMut.mutateAsync({ sortie: pendingEdit.after, actor: user?.username });
    setPendingEdit(null);
    registerUndo(snapshot, "Sortie edited.");
  };

  return (
    <div>
      <PageHead
        title={t("nav_sortielog")}
        subtitle={pickedDate ? `${rows.length} flights · ${pickedDate}` : `${rows.length} flights`}
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            {/* Calendar icon → opens an inline date picker. The chosen
                date filters the table to sorties flown that day. */}
            <div className="relative inline-flex items-center gap-1">
              <button
                onClick={() => setShowDatePicker(v => !v)}
                className={`inline-flex items-center gap-1 px-2 py-1.5 rounded-md text-sm border ${pickedDate ? "bg-primary/15 border-primary text-primary" : "bg-input border-border"}`}
                title="Filter by date"
                data-testid="button-sortie-date-toggle"
              >
                <Calendar className="h-3.5 w-3.5" />
                <span className="font-mono text-xs">{pickedDate || "All days"}</span>
              </button>
              {showDatePicker && (
                <div className="absolute z-30 top-full mt-1 right-0 bg-card border border-border rounded-md p-2 shadow-lg flex items-center gap-2">
                  <DateInput
                    value={pickedDate}
                    onChange={(v) => setPickedDate(v)}
                    className="px-2 py-1 rounded bg-input border border-border text-sm font-mono"
                    data-testid="input-sortie-date"
                  />
                  <button
                    onClick={() => { setPickedDate(todayIso); }}
                    className="px-2 py-1 rounded text-xs bg-secondary border border-border hover:bg-secondary/70"
                    data-testid="button-sortie-date-today"
                  >Today</button>
                  <button
                    onClick={() => { setPickedDate(todayIso); }}
                    className="px-2 py-1 rounded text-xs bg-secondary border border-border hover:bg-secondary/70"
                    data-testid="button-sortie-date-clear"
                    title="Reset to today"
                  ><XIcon className="h-3 w-3" /></button>
                </div>
              )}
            </div>
            <div className="relative">
              <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input value={q} onChange={e => setQ(e.target.value)} placeholder={t("search")} className="pl-7 pr-2 py-1.5 rounded-md bg-input border border-border text-sm" />
            </div>
            <div className="relative">
              <Filter className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <select value={type} onChange={e => setType(e.target.value)} className="pl-7 pr-2 py-1.5 rounded-md bg-input border border-border text-sm">
                {types.map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
            <button
              onClick={() => setImportedOnly(v => !v)}
              disabled={importedCount === 0}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border ${importedOnly ? "bg-primary text-primary-foreground border-primary" : "bg-secondary text-foreground border-border"} disabled:opacity-40 disabled:cursor-not-allowed`}
              title={importedCount === 0 ? t("noImportedYet") : ""}
              data-testid="toggle-imported-only"
            >
              <FileDown className="h-3.5 w-3.5" /> {t("importedOnly")} ({importedCount})
            </button>
            <button
              onClick={() => window.print()}
              className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md bg-primary text-primary-foreground text-sm hover:bg-primary/90"
              data-testid="button-sortielog-print"
              title="Print"
            >
              <Printer className="h-3.5 w-3.5" /> {t("print")}
            </button>
          </div>
        }
      />

      <DataUnavailableBanner queries={[pilotsQ, sortiesQ]} testId="banner-sortielog-unavailable" />

      {/* PrintHeader must live INSIDE data-print-area so the global
          print isolation rules keep it visible on paper. */}
      <div data-print-area>
      <PrintHeader
        title={t("nav_sortielog")}
        context={`${rows.length} flights${type !== "All" ? ` · ${type}` : ""}`}
        dateRange={pickedDate || "All days"}
      />
      <Card className="!p-0 overflow-hidden">
        <div className="overflow-x-auto">
          {/* Squadron Sortie Log — column layout mirrors the official RJAF
              paper form (Action Before Flight | Action After Flight). The
              underlying hours, currencies and reports are unchanged; this
              is purely the ops-officer's viewing / printing surface. */}
          <table className="w-full text-xs border-collapse">
            <thead className="bg-secondary/50 text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <Th center rowSpan={2}>Serial<br/>No./Order</Th>
                <Th center rowSpan={2}>Date</Th>
                <Th center colSpan={2}>Air Craft</Th>
                <Th center rowSpan={2}>Captain Of Air Craft<br/>And Pilot</Th>
                <Th center rowSpan={2}>CREW</Th>
                <Th center rowSpan={2}>Duty Or<br/>Practice Order</Th>
                <Th center colSpan={2}>Approximate</Th>
                <Th center colSpan={2}>Time</Th>
                <Th center colSpan={3}>Actual Instrument Fly</Th>
                <Th center colSpan={2}>IF Approaches</Th>
                <Th center rowSpan={2}>S/B</Th>
                <Th center rowSpan={2}>N/F</Th>
                <Th center rowSpan={2}>Duty Carried out<br/>And Reason for not</Th>
                <Th center rowSpan={2}>Sign</Th>
                <Th center rowSpan={2}>{t("actions")}</Th>
              </tr>
              <tr>
                {/* Air Craft */}
                <Th center>Type</Th>
                <Th center>No.</Th>
                {/* Approximate */}
                <Th center>Time to<br/>Start</Th>
                <Th center>Duration<br/>of Flight</Th>
                {/* Time */}
                <Th center>Time of<br/>Take off</Th>
                <Th center>Time<br/>Landed</Th>
                {/* Actual Instrument Fly */}
                <Th center>In The<br/>Air</Th>
                <Th center>SIM</Th>
                <Th center>ACT</Th>
                {/* IF Approaches */}
                <Th center>TYPE</Th>
                <Th center>NO.</Th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={22} className="px-3 py-6 text-center text-xs text-muted-foreground" data-testid="empty-sorties">
                    {pilotsQ.isError || sortiesQ.isError ? "—" : t("no_records")}
                  </td>
                </tr>
              )}
              {rows.map((s, idx) => {
                const isFrozen = frozen.isFrozen(s.date);
                const canEdit = frozen.canEdit(s.date);
                const locked = isFrozen && !canEdit;
                const captain = captainPilot(s);
                return (
                <tr key={s.id} className={`border-t border-border row-hover ${locked ? "opacity-90" : ""}`} data-testid={`row-sortie-${s.id}`}>
                  <Td mono center>
                    <span className="inline-flex items-center gap-1.5">
                      {idx + 1}
                      {s.imported && (
                        <span
                          className="text-[9px] px-1 py-0.5 rounded-full bg-amber-400/15 border border-amber-400/40 text-amber-300 font-medium uppercase tracking-wider"
                          title={s.importedAt ? `Imported ${fmtDateTimeDDMM(s.importedAt)}` : t("importedBadge")}
                          data-testid={`badge-imported-sortie-${s.id}`}
                        >
                          {t("importedBadge")}
                        </span>
                      )}
                    </span>
                  </Td>
                  <Td mono center>
                    <span className="inline-flex items-center gap-1">
                      {s.date}
                      {locked && <Lock className="h-3 w-3 text-muted-foreground" aria-label="Frozen (older than 12 months)" />}
                      {isFrozen && canEdit && <Unlock className="h-3 w-3 text-amber-300" aria-label="Frozen — this PC is authorized to edit" />}
                    </span>
                  </Td>
                  <Td>{s.acType || DASH}</Td>
                  <Td mono>{s.acNumber || DASH}</Td>
                  <Td>{captain || DASH}</Td>
                  <Td>{crewOf(s) || DASH}</Td>
                  <Td>{dutyOrder(s)}</Td>
                  <Td mono center>{DASH}</Td>
                  <Td mono center>{durationOf(s)}</Td>
                  <Td mono center>{DASH}</Td>
                  <Td mono center>{DASH}</Td>
                  <Td mono center>{ifAir(s)}</Td>
                  <Td mono center>{fmtHrs(s.ifSim)}</Td>
                  <Td mono center>{fmtHrs(s.ifAct)}</Td>
                  <Td mono center>{ifApprType(s)}</Td>
                  <Td mono center>{ifApprNo(s)}</Td>
                  <Td mono center>{DASH}</Td>
                  <Td mono center>{DASH}</Td>
                  <Td>{dutyDone(s)}</Td>
                  <Td mono center>{DASH}</Td>
                  <Td right>
                    <div className="inline-flex gap-1 items-center">
                      <button
                        onClick={() => tryEdit(s)}
                        disabled={locked}
                        className={`p-1 rounded ${locked ? "opacity-40 cursor-not-allowed" : "hover:bg-secondary"}`}
                        title={locked ? lockedMessage : t("edit")}
                        aria-disabled={locked}
                        data-testid={`button-edit-sortie-${s.id}`}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => tryDelete(s)}
                        disabled={locked}
                        className={`p-1 rounded ${locked ? "opacity-40 cursor-not-allowed" : "hover:bg-destructive/20 text-destructive"}`}
                        title={locked ? lockedMessage : t("delete")}
                        aria-disabled={locked}
                        data-testid={`button-delete-sortie-${s.id}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </Td>
                </tr>
              );})}
            </tbody>
          </table>
        </div>
      </Card>
      </div>

      {editing && (
        <SortieEditDialog
          sortie={editing}
          pilots={PILOTS.map(p => ({ id: p.id, label: `${rankOf(p)} ${p.name}` }))}
          acTypeOptions={acTypeOptions}
          busy={updateMut.isPending}
          onCancel={() => setEditing(null)}
          onSave={(next) => {
            // Defer to the change-summary dialog before committing.
            setPendingEdit({ before: editing, after: next });
            setEditing(null);
          }}
        />
      )}

      {pendingEdit && (
        <SortieDiffDialog
          mode="edit"
          before={pendingEdit.before}
          after={pendingEdit.after}
          onCancel={() => setPendingEdit(null)}
          onConfirm={onConfirmEdit}
          busy={updateMut.isPending}
          pilotName={(id) => pilotMap[id] || id}
        />
      )}

      {deleting && (
        <SortieDiffDialog
          mode="delete"
          before={deleting}
          onCancel={() => setDeleting(null)}
          onConfirm={onConfirmDelete}
          busy={deleteMut.isPending}
          pilotName={(id) => pilotMap[id] || id}
        />
      )}
    </div>
  );
}

function SeatCell({ id, ext, nameMap }: { id: string; ext?: { name: string; squadron: string }; nameMap: Record<string, string> }) {
  if (ext) {
    return (
      <span className="inline-flex items-center gap-1 text-amber-200" title="External pilot">
        <span className="text-[10px] px-1 rounded bg-amber-400/20 border border-amber-400/40 font-semibold">EXT</span>
        <span>{ext.name}{ext.squadron ? ` · ${ext.squadron}` : ""}</span>
      </span>
    );
  }
  return <>{nameMap[id] || id}</>;
}

function Th({ children, right, center, cls = "", rowSpan, colSpan }: { children: React.ReactNode; right?: boolean; center?: boolean; cls?: string; rowSpan?: number; colSpan?: number }) {
  const align = center ? "text-center" : right ? "text-right" : "text-left";
  return <th rowSpan={rowSpan} colSpan={colSpan} className={`px-2 py-1.5 border border-border ${align} font-medium ${cls}`}>{children}</th>;
}
function Td({ children, mono, right, center, cls = "" }: { children: React.ReactNode; mono?: boolean; right?: boolean; center?: boolean; cls?: string }) {
  const align = center ? "text-center" : right ? "text-right" : "text-left";
  return <td className={`px-2 py-1.5 border border-border ${mono ? "font-mono" : ""} ${align} ${cls}`}>{children}</td>;
}

interface PilotOpt { id: string; label: string; }
interface SortieEditDialogProps {
  sortie: Sortie;
  pilots: PilotOpt[];
  acTypeOptions: string[];
  busy?: boolean;
  onCancel: () => void;
  onSave: (next: Sortie) => void;
}
function SortieEditDialog({ sortie, pilots, acTypeOptions, busy, onCancel, onSave }: SortieEditDialogProps) {
  const { t, rankOf } = useI18n();
  const [form, setForm] = useState<Sortie>(sortie);
  const set = <K extends keyof Sortie>(k: K, v: Sortie[K]) => setForm(f => ({ ...f, [k]: v }));
  const num = (v: string) => Number.isFinite(Number(v)) ? Number(v) : 0;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onCancel}>
      <div className="bg-card border border-border rounded-lg shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="p-4 border-b border-border">
          <div className="text-base font-semibold">{t("editSortieTitle")}</div>
          <div className="text-xs text-muted-foreground mt-0.5">{sortie.id}</div>
        </div>
        <form
          onSubmit={(e) => { e.preventDefault(); onSave(form); }}
          className="p-4 space-y-3"
        >
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <L label={t("date")}><DateInput value={form.date} onChange={(v) => set("date", v)} className={I} data-testid="input-edit-date" /></L>
            <L label={t("acType")}>
              <select value={form.acType} onChange={e => set("acType", e.target.value)} className={I}>
                {acTypeOptions.map(o => <option key={o}>{o}</option>)}
              </select>
            </L>
            <L label={t("acNumber")}><input value={form.acNumber} onChange={e => set("acNumber", e.target.value)} className={I} data-testid="input-edit-acnum" /></L>
            <L label={t("pilot")}>
              <select value={form.pilotId} onChange={e => set("pilotId", e.target.value)} className={I}>
                {pilots.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </L>
            <L label={t("coPilot")}>
              <select value={form.coPilotId} onChange={e => set("coPilotId", e.target.value)} className={I}>
                {pilots.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </L>
            <L label={t("sortieType")}>
              <select value={form.sortieType} onChange={e => set("sortieType", e.target.value)} className={I}>
                {["Training", "Mission", "Check Ride", "FCF", "Transport"].map(o => <option key={o}>{o}</option>)}
              </select>
            </L>
            <L label={t("sortieName")} className="md:col-span-3"><input value={form.name} onChange={e => set("name", e.target.value)} className={I} /></L>
          </div>
          <div className="border-t border-border pt-3">
            <div className="text-xs text-muted-foreground mb-1">{t("condition")}</div>
            <div className="flex items-center gap-2">
              {(["Day", "Night", "NVG"] as const).map(opt => (
                <button
                  type="button"
                  key={opt}
                  onClick={() => set("condition", opt)}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium border ${
                    form.condition === opt
                      ? opt === "NVG" ? "bg-rose-500/20 border-rose-400 text-rose-200" : "bg-primary/20 border-primary text-primary"
                      : "bg-secondary border-border text-muted-foreground"
                  }`}
                >
                  {t(opt === "Day" ? "conditionDay" : opt === "Night" ? "conditionNight" : "conditionNVG")}
                </button>
              ))}
            </div>
          </div>
          <L label={t("remarks")}>
            <textarea value={form.remarks ?? ""} onChange={e => set("remarks", e.target.value)} rows={2} className={I + " resize-none"} />
          </L>
          <div className="grid grid-cols-3 gap-3 border-t border-border pt-3">
            {(["day1","day2","dayDual","night1","night2","nightDual","nvg","sim","actual"] as const).map(k => (
              <L key={k} label={t(k as never) ?? k}>
                <input type="number" step="0.1" value={form[k]} onChange={e => set(k, num(e.target.value))} className={I + " font-mono"} />
              </L>
            ))}
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
            <button type="button" onClick={onCancel} className="px-4 py-2 rounded-md bg-secondary border border-border text-sm" data-testid="button-edit-cancel">{t("cancel")}</button>
            <button type="submit" disabled={busy} className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50" data-testid="button-edit-save">
              {busy ? "…" : t("save")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const I = "w-full mt-1 px-3 py-2 rounded-md bg-input border border-border text-sm";
function L({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return <label className={`block ${className}`}><span className="text-xs text-muted-foreground">{label}</span>{children}</label>;
}
