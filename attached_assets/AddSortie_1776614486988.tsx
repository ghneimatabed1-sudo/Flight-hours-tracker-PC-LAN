import { useEffect, useMemo, useState } from "react";
import { Card, PageHead } from "@/components/Layout";
import { useI18n } from "@/lib/i18n";
import {
  usePilots,
  useSorties,
  useCreateSortie,
  useUpdateSortie,
  useDeleteSortie,
} from "@/lib/squadron-data";
import { useToast } from "@/hooks/use-toast";
import type { Sortie } from "@/lib/mock";
import { Plane, Pencil, Trash2, X } from "lucide-react";

const SORTIE_TYPES = [
  "GH","MTF","NF","NVG","NAV","NAV FOR","EMER","EVAL","IF",
  "MSN DAY","MSN NIGHT","MSN NVG",
  "TRG DAY","TRG NIGHT","TRG NVG",
  "CRS DAY","CRS NVG","GP.C DAY","CPC NVG",
  "FCF","ACADEMIC","INSTR","CHECK RIDE","TRANSPORT","SAR","MEDEVAC","Other…",
];

type Condition  = "Day" | "Night" | "NVG";
type SeatStatus = "1st" | "2nd" | "dual";

interface FormState {
  id: string | null;
  date: string; acType: string; acNumber: string;
  pilot: string; pilotStatus: SeatStatus; pilotIsCaptain: boolean;
  coPilot: string; coPilotStatus: SeatStatus; coPilotIsCaptain: boolean;
  sortieType: string; sortieTypeOther: string; msnDuty: string;
  condition: Condition; time: string;
  instrumentFlight: boolean; ifSim: string; ifAct: string; ils: string; vor: string;
  remarks: string;
}

const blankForm = (): FormState => ({
  id: null,
  date: new Date().toISOString().slice(0, 10),
  acType: "UH-60M", acNumber: "",
  pilot: "", pilotStatus: "1st", pilotIsCaptain: false,
  coPilot: "", coPilotStatus: "2nd", coPilotIsCaptain: false,
  sortieType: "TRG DAY", sortieTypeOther: "", msnDuty: "",
  condition: "Day", time: "",
  instrumentFlight: false, ifSim: "", ifAct: "", ils: "", vor: "",
  remarks: "",
});

export default function AddSortie() {
  const { t } = useI18n();
  const { toast } = useToast();
  const { data: PILOTS } = usePilots();
  const { data: SORTIES } = useSorties();
  const create = useCreateSortie();
  const update = useUpdateSortie();
  const del = useDeleteSortie();

  const [form, setForm] = useState<FormState>(blankForm);
  const [confirmDel, setConfirmDel] = useState<Sortie | null>(null);

  useEffect(() => {
    if (!form.pilot && PILOTS[0]) {
      setForm(f => ({ ...f, pilot: PILOTS[0].id, coPilot: PILOTS[1]?.id ?? PILOTS[0].id }));
    }
  }, [PILOTS, form.pilot]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm(f => ({ ...f, [k]: v }));

  const pilotOpts = useMemo(
    () => PILOTS.map(p => ({ value: p.id, label: `${p.rank} ${p.name}` })),
    [PILOTS],
  );
  const pilotById = (id: string) => PILOTS.find(p => p.id === id);

  const todaySorties = useMemo(() => {
    return [...SORTIES.filter(s => s.date === form.date)].sort((a, b) => (a.id < b.id ? 1 : -1));
  }, [SORTIES, form.date]);

  const totals = useMemo(() => {
    let s = 0, h = 0;
    for (const r of todaySorties) {
      s++;
      const t = Number(r.time ?? r.actual ?? 0);
      h += Number.isFinite(t) ? t : 0;
    }
    return { s, h: +h.toFixed(1) };
  }, [todaySorties]);

  const resetForm = () =>
    setForm(f => ({
      ...blankForm(),
      date: f.date, acType: f.acType, acNumber: f.acNumber,
      pilot: f.pilot, coPilot: f.coPilot,
      pilotStatus: f.pilotStatus, coPilotStatus: f.coPilotStatus,
    }));

  // Route hours into the correct bucket for one seat based on status + condition
  function routeHours(status: SeatStatus, cond: Condition, t: number) {
    return {
      day1:      cond === "Day"   && status === "1st"  ? t : 0,
      day2:      cond === "Day"   && status === "2nd"  ? t : 0,
      dayDual:   cond === "Day"   && status === "dual" ? t : 0,
      night1:    cond === "Night" && status === "1st"  ? t : 0,
      night2:    cond === "Night" && status === "2nd"  ? t : 0,
      nightDual: cond === "Night" && status === "dual" ? t : 0,
      nvg1:      cond === "NVG"   && status === "1st"  ? t : 0,
      nvg2:      cond === "NVG"   && status === "2nd"  ? t : 0,
      nvgDual:   cond === "NVG"   && status === "dual" ? t : 0,
    };
  }

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const time = parseFloat(form.time || "0");
    if (!(time > 0)) {
      toast({ title: "Hours required", description: "Enter flight time.", variant: "destructive" });
      return;
    }
    if (form.pilot === form.coPilot && form.pilot) {
      toast({ title: "Pilot and Co-Pilot cannot be the same person", variant: "destructive" });
      return;
    }

    const pb = routeHours(form.pilotStatus,   form.condition, time);
    const cb = routeHours(form.coPilotStatus, form.condition, time);

    const merged = {
      day1:      pb.day1      + cb.day1,
      day2:      pb.day2      + cb.day2,
      dayDual:   pb.dayDual   + cb.dayDual,
      night1:    pb.night1    + cb.night1,
      night2:    pb.night2    + cb.night2,
      nightDual: pb.nightDual + cb.nightDual,
      nvg1:      pb.nvg1      + cb.nvg1,
      nvg2:      pb.nvg2      + cb.nvg2,
      nvgDual:   pb.nvgDual   + cb.nvgDual,
    };

    const nvgTotal = merged.nvg1 + merged.nvg2 + merged.nvgDual;
    const sortieType = form.sortieType === "Other…"
      ? form.sortieTypeOther.trim() || "OTHER"
      : form.sortieType;
    const ifSim = parseFloat(form.ifSim || "0") || 0;
    const ifAct = parseFloat(form.ifAct || "0") || 0;

    const payload: Omit<Sortie, "id"> = {
      date: form.date, acType: form.acType, acNumber: form.acNumber.trim(),
      pilotId: form.pilot, coPilotId: form.coPilot,
      sortieType, name: form.msnDuty.trim() || sortieType,
      condition: form.condition,
      remarks: form.remarks.trim() || undefined,
      day1: merged.day1, day2: merged.day2, dayDual: merged.dayDual,
      night1: merged.night1, night2: merged.night2, nightDual: merged.nightDual,
      nvg: nvgTotal, nvg1: merged.nvg1, nvg2: merged.nvg2, nvgDual: merged.nvgDual,
      sim: ifSim, actual: time, time,
      pilotStatus: form.pilotStatus, coPilotStatus: form.coPilotStatus,
      pilotIsCaptain: form.pilotIsCaptain, coPilotIsCaptain: form.coPilotIsCaptain,
      pilotPosition: form.pilotStatus === "1st" ? "1st" : "2nd",
      coPilotPosition: form.coPilotStatus === "1st" ? "1st" : "2nd",
      msnDuty: form.msnDuty.trim() || undefined,
      instrumentFlight: form.instrumentFlight,
      ifSim: form.instrumentFlight ? ifSim : undefined,
      ifAct: form.instrumentFlight ? ifAct : undefined,
      ils: form.instrumentFlight ? (parseInt(form.ils || "0") || 0) : undefined,
      vor: form.instrumentFlight ? (parseInt(form.vor || "0") || 0) : undefined,
    };

    try {
      if (form.id) {
        await update.mutateAsync({ sortie: { ...payload, id: form.id } as Sortie });
        toast({ title: "Sortie updated" });
      } else {
        await create.mutateAsync(payload);
        toast({ title: "Sortie added" });
      }
      resetForm();
    } catch { /* surfaced by global error toast */ }
  };

  const loadForEdit = (s: Sortie) => {
    setForm({
      id: s.id, date: s.date,
      acType: s.acType || "UH-60M", acNumber: s.acNumber || "",
      pilot: s.pilotId,
      pilotStatus: s.pilotStatus ?? (s.pilotPosition === "1st" ? "1st" : "2nd"),
      pilotIsCaptain: !!s.pilotIsCaptain,
      coPilot: s.coPilotId,
      coPilotStatus: s.coPilotStatus ?? (s.coPilotPosition === "1st" ? "1st" : "2nd"),
      coPilotIsCaptain: !!s.coPilotIsCaptain,
      sortieType: SORTIE_TYPES.includes(s.sortieType) ? s.sortieType : "Other…",
      sortieTypeOther: SORTIE_TYPES.includes(s.sortieType) ? "" : s.sortieType,
      msnDuty: s.msnDuty ?? s.name ?? "",
      condition: s.condition ?? "Day",
      time: String(s.time ?? s.actual ?? ""),
      instrumentFlight: !!s.instrumentFlight,
      ifSim: s.ifSim != null ? String(s.ifSim) : "",
      ifAct: s.ifAct != null ? String(s.ifAct) : "",
      ils: s.ils != null ? String(s.ils) : "",
      vor: s.vor != null ? String(s.vor) : "",
      remarks: s.remarks || "",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const doDelete = async () => {
    if (!confirmDel) return;
    try { await del.mutateAsync({ id: confirmDel.id }); toast({ title: "Sortie deleted" }); }
    finally { setConfirmDel(null); }
  };

  const seatLabel = (id: string, ext?: { name: string }) => {
    if (ext?.name) return ext.name;
    const p = pilotById(id);
    return p ? `${p.rank} ${p.name}` : id || "—";
  };

  return (
    <div>
      <PageHead title={t("nav_addsortie")} subtitle="New flight entry · auto-syncs to Supabase" />

      <Card className="mb-4">
        <form onSubmit={submit} className="space-y-4" data-testid="form-add-sortie">

          {/* Flight info */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            <Mini label="Date" type="date" value={form.date} onChange={v => set("date", v)} />
            <MiniSelect label="A/C Type" value={form.acType} onChange={v => set("acType", v)}
              opts={["UH-60M","UH-60L","UH-60AIL","AS332"]} />
            <Mini label="A/C No" value={form.acNumber} onChange={v => set("acNumber", v)} placeholder="e.g. 832" />
            <MiniSelect label="Sortie Type" value={form.sortieType} onChange={v => set("sortieType", v)} opts={SORTIE_TYPES} />
            <Mini label="Time (hrs)" type="number" step="0.1" value={form.time} onChange={v => set("time", v)} placeholder="0.0" />
          </div>

          {form.sortieType === "Other…" && (
            <Mini label="Custom sortie type" value={form.sortieTypeOther} onChange={v => set("sortieTypeOther", v)} placeholder="Type your own…" />
          )}
          <Mini label="MSN / Duty (optional)" value={form.msnDuty} onChange={v => set("msnDuty", v)} placeholder="Mission name" />

          {/* Condition */}
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Flight Condition</div>
            <div className="flex gap-2">
              {(["Day","Night","NVG"] as Condition[]).map(c => (
                <button key={c} type="button" onClick={() => set("condition", c)}
                  className={`px-4 py-2 rounded-md text-xs font-bold border transition-colors ${
                    form.condition === c
                      ? c === "Day" ? "bg-amber-400/20 border-amber-400 text-amber-200"
                      : c === "Night" ? "bg-indigo-500/20 border-indigo-400 text-indigo-200"
                      : "bg-rose-500/20 border-rose-400 text-rose-200"
                      : "bg-secondary border-border text-muted-foreground"
                  }`}>
                  {c === "Day" ? "☀ DAY" : c === "Night" ? "🌙 NIGHT" : "👁 NVG"}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">
              {form.condition === "NVG" ? "NVG is fully separate from Night — hours go only to the NVG bucket."
               : form.condition === "Night" ? "Night flight without NVG goggles. Fully separate from NVG."
               : "Daylight flight."}
            </p>
          </div>

          {/* Crew — per-pilot independent status */}
          <div className="grid lg:grid-cols-2 gap-3">
            <CrewCard label="PILOT"
              pilotOpts={pilotOpts} selectedId={form.pilot} onSelectId={v => set("pilot", v)}
              status={form.pilotStatus} onStatus={v => set("pilotStatus", v)}
              isCaptain={form.pilotIsCaptain} onCaptain={v => set("pilotIsCaptain", v)}
              testPrefix="pilot" />
            <CrewCard label="CO-PILOT"
              pilotOpts={pilotOpts} selectedId={form.coPilot} onSelectId={v => set("coPilot", v)}
              status={form.coPilotStatus} onStatus={v => set("coPilotStatus", v)}
              isCaptain={form.coPilotIsCaptain} onCaptain={v => set("coPilotIsCaptain", v)}
              testPrefix="copilot" />
          </div>

          {/* Instrument flight */}
          <div className="border border-border rounded-md p-3 bg-sky-500/5">
            <label className="inline-flex items-center gap-2 cursor-pointer select-none mb-2">
              <input type="checkbox" checked={form.instrumentFlight}
                onChange={e => set("instrumentFlight", e.target.checked)}
                className="h-4 w-4 accent-sky-400" />
              <span className="text-xs font-semibold uppercase tracking-wider">Instrument Flight</span>
            </label>
            {form.instrumentFlight && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <Mini label="SIM (hrs)"      type="number" step="0.1" value={form.ifSim} onChange={v => set("ifSim", v)} placeholder="0.0" />
                <Mini label="Actual (hrs)"   type="number" step="0.1" value={form.ifAct} onChange={v => set("ifAct", v)} placeholder="0.0" />
                <Mini label="ILS approaches" type="number" step="1"   value={form.ils}   onChange={v => set("ils", v)}   placeholder="0" />
                <Mini label="VOR approaches" type="number" step="1"   value={form.vor}   onChange={v => set("vor", v)}   placeholder="0" />
              </div>
            )}
          </div>

          {/* Remarks + Submit */}
          <div className="flex flex-col sm:flex-row gap-2 items-end">
            <div className="flex-1">
              <label className="block">
                <span className="text-[11px] text-muted-foreground">Remarks (optional)</span>
                <textarea value={form.remarks} onChange={e => set("remarks", e.target.value)}
                  placeholder="Weather, aborts, maintenance notes…" rows={2}
                  className="w-full mt-1 px-3 py-1.5 rounded-md bg-input border border-border text-xs resize-none" />
              </label>
            </div>
            <div className="flex items-center gap-2 pb-0.5">
              {form.id && (
                <button type="button" onClick={() => setForm(blankForm())}
                  className="px-3 py-2 rounded-md bg-secondary border border-border text-xs font-medium inline-flex items-center gap-1">
                  <X className="h-3.5 w-3.5" /> Cancel
                </button>
              )}
              <button disabled={create.isPending || update.isPending}
                className="px-5 py-2 rounded-md bg-primary text-primary-foreground font-bold inline-flex items-center gap-2 disabled:opacity-50">
                <Plane className="h-4 w-4" />
                {form.id ? "Save changes" : "ADD SORTIE"}
              </button>
            </div>
          </div>
        </form>
      </Card>

      {/* Sortie log */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-semibold">Log · {form.date} · {form.acType}</div>
          <div className="text-[11px] text-muted-foreground">Click <span className="text-primary">Edit</span> to load a sortie into the form.</div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] font-mono">
            <thead>
              <tr className="text-left text-muted-foreground border-b border-border">
                <th className="py-1.5 pr-2">DATE</th>
                <th className="pr-2">A/C</th>
                <th className="pr-2">PILOT</th>
                <th className="pr-2">ST</th>
                <th className="pr-2">CO-PILOT</th>
                <th className="pr-2">ST</th>
                <th className="pr-2">TYPE</th>
                <th className="pr-2">COND</th>
                <th className="pr-2">IF</th>
                <th className="pr-2 text-right">TIME</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {todaySorties.length === 0 && (
                <tr><td colSpan={11} className="py-3 text-center text-muted-foreground italic">No sorties on this date yet.</td></tr>
              )}
              {todaySorties.map(s => {
                const time = s.time ?? s.actual ?? 0;
                const cond = s.condition ?? "Day";
                return (
                  <tr key={s.id} className={`border-b border-border/50 hover:bg-secondary/30 ${form.id === s.id ? "bg-primary/10" : ""}`}>
                    <td className="py-1.5 pr-2">{s.date}</td>
                    <td className="pr-2">{s.acType} {s.acNumber}</td>
                    <td className="pr-2">
                      {seatLabel(s.pilotId, s.pilotExternal)}
                      {s.pilotIsCaptain && <span className="ml-1 text-[9px] text-amber-300 font-bold">CAP</span>}
                    </td>
                    <td className="pr-2"><SBadge status={s.pilotStatus ?? (s.pilotPosition === "1st" ? "1st" : "2nd")} /></td>
                    <td className="pr-2">
                      {seatLabel(s.coPilotId, s.coPilotExternal)}
                      {s.coPilotIsCaptain && <span className="ml-1 text-[9px] text-amber-300 font-bold">CAP</span>}
                    </td>
                    <td className="pr-2"><SBadge status={s.coPilotStatus ?? (s.coPilotPosition === "1st" ? "1st" : "2nd")} /></td>
                    <td className="pr-2">{s.sortieType}</td>
                    <td className="pr-2">
                      <span className={cond === "NVG" ? "text-rose-300" : cond === "Night" ? "text-indigo-300" : "text-amber-300"}>
                        {cond === "NVG" ? "NVG" : cond === "Night" ? "NIGHT" : "DAY"}
                      </span>
                    </td>
                    <td className="pr-2">{s.instrumentFlight ? "✓" : ""}</td>
                    <td className="pr-2 text-right">{Number(time || 0).toFixed(1)}</td>
                    <td className="pr-2 text-right whitespace-nowrap">
                      <button onClick={() => loadForEdit(s)} className="px-1.5 py-0.5 rounded border border-border bg-secondary text-[10px] inline-flex items-center gap-0.5 mr-1">
                        <Pencil className="h-3 w-3" /> Edit
                      </button>
                      <button onClick={() => setConfirmDel(s)} className="px-1.5 py-0.5 rounded border border-rose-400/40 bg-rose-500/10 text-rose-200 text-[10px] inline-flex items-center gap-0.5">
                        <Trash2 className="h-3 w-3" /> Del
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {todaySorties.length > 0 && (
              <tfoot>
                <tr className="border-t-2 border-border font-semibold">
                  <td colSpan={9} className="py-2 text-right">TOTALS</td>
                  <td className="pr-2 text-right">{totals.h.toFixed(1)} hrs · {totals.s} sorties</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </Card>

      {confirmDel && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => setConfirmDel(null)}>
          <div className="bg-card border border-border rounded-lg p-4 max-w-md w-full" onClick={e => e.stopPropagation()}>
            <div className="font-semibold mb-1">Delete this sortie?</div>
            <div className="text-xs text-muted-foreground mb-3">
              {confirmDel.date} · {confirmDel.acType} {confirmDel.acNumber} · {confirmDel.sortieType}
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmDel(null)} className="px-3 py-1.5 rounded-md bg-secondary border border-border text-xs">Cancel</button>
              <button onClick={doDelete} className="px-3 py-1.5 rounded-md bg-rose-600 text-white text-xs font-semibold">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── CrewCard ─────────────────────────────────────────────────────────────────
interface CrewCardProps {
  label: string;
  pilotOpts: { value: string; label: string }[];
  selectedId: string; onSelectId: (v: string) => void;
  status: SeatStatus; onStatus: (v: SeatStatus) => void;
  isCaptain: boolean; onCaptain: (v: boolean) => void;
  testPrefix: string;
}
function CrewCard({ label, pilotOpts, selectedId, onSelectId, status, onStatus, isCaptain, onCaptain, testPrefix }: CrewCardProps) {
  const opts: { value: SeatStatus; label: string }[] = [
    { value: "1st",  label: "1st Officer" },
    { value: "2nd",  label: "2nd Officer" },
    { value: "dual", label: "Dual" },
  ];
  return (
    <div className="border border-border rounded-md p-3 bg-secondary/20 space-y-2">
      <div className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{label}</div>
      <select className="w-full px-2 py-1.5 rounded-md bg-input border border-border text-xs"
        value={selectedId} onChange={e => onSelectId(e.target.value)} data-testid={`select-${testPrefix}`}>
        {pilotOpts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <div>
        <div className="text-[10px] text-muted-foreground mb-1 uppercase tracking-wider">Status</div>
        <div className="flex gap-1.5">
          {opts.map(opt => (
            <button key={opt.value} type="button" onClick={() => onStatus(opt.value)}
              data-testid={`button-${testPrefix}-${opt.value}`}
              className={`flex-1 px-2 py-1.5 rounded-md text-[11px] font-semibold border transition-colors ${
                status === opt.value
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-secondary border-border hover:bg-secondary/80 text-muted-foreground"
              }`}>
              {opt.value === "1st" ? "1st" : opt.value === "2nd" ? "2nd" : "Dual"}
            </button>
          ))}
        </div>
      </div>
      <label className={`inline-flex items-center gap-2 cursor-pointer select-none px-3 py-1.5 rounded-md border text-xs w-full ${
        isCaptain ? "bg-amber-500/20 border-amber-400 text-amber-200" : "bg-secondary border-border text-muted-foreground"
      }`} data-testid={`toggle-captain-${testPrefix}`}>
        <input type="checkbox" checked={isCaptain} onChange={e => onCaptain(e.target.checked)} className="h-4 w-4 accent-amber-400" />
        <span className="font-semibold">Captain (CAP)</span>
      </label>
    </div>
  );
}

function SBadge({ status }: { status: string }) {
  return (
    <span className={`text-[10px] font-bold ${
      status === "dual" ? "text-sky-300" : status === "1st" ? "text-green-300" : "text-orange-300"
    }`}>
      {status === "1st" ? "1st" : status === "2nd" ? "2nd" : "Dual"}
    </span>
  );
}

type MiniProps = { label: string; value: string | number; onChange: (v: string) => void; type?: string; placeholder?: string; step?: string; };
function Mini({ label, value, onChange, type = "text", placeholder, step }: MiniProps) {
  return (
    <label className="block">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <input type={type} step={step} value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)}
        className="w-full mt-0.5 px-2 py-1.5 rounded-md bg-input border border-border text-xs font-mono" />
    </label>
  );
}

function MiniSelect({ label, value, onChange, opts }: { label: string; value: string; onChange: (v: string) => void; opts: string[] }) {
  return (
    <label className="block">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <select value={value} onChange={e => onChange(e.target.value)}
        className="w-full mt-0.5 px-2 py-1.5 rounded-md bg-input border border-border text-xs">
        {opts.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}
