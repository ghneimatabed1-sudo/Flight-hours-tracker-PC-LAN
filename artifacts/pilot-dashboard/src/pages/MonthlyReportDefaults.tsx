import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Save, Plus, Trash2, ArrowLeft } from "lucide-react";
import { PageHead } from "@/components/Layout";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import {
  loadSquadronDefaults, saveSquadronDefaults, factoryDefaults,
  hydrateSquadronDefaultsFromDb,
  type SquadronDefaults,
} from "@/lib/squadron-defaults";
import { isLanSessionLoginEnabled } from "@/lib/internal-migration";

/**
 * Per-squadron Monthly Report defaults editor — operations pilot only.
 *
 * The squadron operates on a single PC. The operations pilot edits these
 * values once for their squadron (lectures, exercises, fuel-burn rates per
 * airframe, default morale, ammo placeholders, REMARKS auto-suggest toggle)
 * and they prefill every month after. Other squadrons can deploy the same
 * APK and keep their own baseline because storage is keyed by squadron
 * number.
 */
export default function MonthlyReportDefaults() {
  const { t } = useI18n();
  const { squadron, user } = useAuth();
  // Task #137: no NO.8 fallback — if there is no bound squadron number
  // we use the neutral "default" cache key so a fresh install is never
  // pre-flavoured with NO.8 SQDN data.
  const sqdnNumber = squadron?.number || "default";

  const [d, setD] = useState<SquadronDefaults>(() => loadSquadronDefaults(sqdnNumber));
  const [saved, setSaved] = useState(false);

  // Task #137 — overlay DB-backed defaults (`squadrons.default_aircraft`,
  // `squadrons.default_monthly_targets`) from migration 0039 on top of
  // the local cache so a sibling PC sees the same config without
  // re-running the Setup Wizard.
  useEffect(() => {
    let cancelled = false;
    void hydrateSquadronDefaultsFromDb(sqdnNumber).then(ok => {
      if (!cancelled && ok) setD(loadSquadronDefaults(sqdnNumber));
    });
    return () => { cancelled = true; };
  }, [sqdnNumber]);

  if (user?.role !== "ops") {
    return (
      <div className="p-6">
        <PageHead
          title="Monthly Report Defaults"
          subtitle="Operations Pilot PC only"
          actions={null}
        />
        <div className="bg-card border border-border rounded-lg p-8 text-center text-sm text-muted-foreground">
          This page is locked to the Operations Pilot account on the squadron
          PC. Other roles do not edit Monthly Report defaults.
        </div>
      </div>
    );
  }

  const update = <K extends keyof SquadronDefaults>(k: K, v: SquadronDefaults[K]) =>
    setD(p => ({ ...p, [k]: v }));

  const onSave = async () => {
    saveSquadronDefaults(sqdnNumber, d);
    try {
      if (isLanSessionLoginEnabled()) {
        setSaved(true);
        setTimeout(() => setSaved(false), 1800);
        return;
      }
      const { supabase, supabaseConfigured } = await import("@/lib/supabase");
      if (supabaseConfigured && supabase && sqdnNumber) {
        const aircraftPayload = d.airframes.map(model => ({
          model,
          fuelBurn: d.fuelBurnByAirframe[model] ?? 0,
        }));
        const monthlyPerPilot = Math.max(1, Math.round(d.minSixMonthHours / 6));
        const targetsPayload: Record<string, number> = {};
        for (const m of d.airframes) targetsPayload[m] = monthlyPerPilot;
        await supabase.from("squadrons").upsert({
          number: sqdnNumber,
          name: squadron?.name || sqdnNumber,
          base: d.base || d.airbase || "",
          wing: d.wing || null,
          default_aircraft: aircraftPayload,
          default_monthly_targets: targetsPayload,
        }, { onConflict: "number" });
      }
    } catch { /* offline-tolerant */ }
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  };

  const onResetFactory = () => {
    if (!confirm("Reset all defaults to the factory baseline? This does not affect any saved monthly reports.")) return;
    setD(factoryDefaults());
  };

  const airframes = Object.keys(d.fuelBurnByAirframe);

  return (
    <div className="p-6 max-w-4xl">
      <PageHead
        title="Monthly Report Defaults"
        subtitle={`${squadron?.name || "Squadron"} — values that almost never change month-to-month, edit once and they prefill every report.`}
        actions={
          <div className="flex gap-2">
            <Link href="/monthly-report"
              className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-secondary inline-flex items-center gap-1"
              data-testid="link-back-to-monthly-report">
              <ArrowLeft className="h-3.5 w-3.5" /> Back to report
            </Link>
            <button onClick={onResetFactory}
              className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-secondary"
              data-testid="button-reset-factory">
              Reset to factory
            </button>
            <button onClick={onSave}
              className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground font-medium inline-flex items-center gap-1"
              data-testid="button-save-defaults">
              <Save className="h-3.5 w-3.5" /> {saved ? "Saved" : "Save defaults"}
            </button>
          </div>
        }
      />

      <div className="space-y-4">
        {/* Squadron-level baseline text */}
        <Section title="Squadron baseline" hint="These prefill the Form 3 header every month — operator can still override per-month.">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Field label="Default morale">
              <select value={d.morale} onChange={e => update("morale", e.target.value as any)}
                className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm"
                data-testid="select-default-morale">
                <option>HIGH</option><option>MEDIUM</option><option>LOW</option>
              </select>
            </Field>
            <Field label="Default INCIDENTS text">
              <input value={d.incidentsDefault} onChange={e => update("incidentsDefault", e.target.value)}
                className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm"
                data-testid="input-default-incidents" />
            </Field>
            <Field label="Default ACCIDENTS text">
              <input value={d.accidentsDefault} onChange={e => update("accidentsDefault", e.target.value)}
                className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm"
                data-testid="input-default-accidents" />
            </Field>
            <Field label="Ammo placeholder (when none)">
              <input value={d.ammoPlaceholder} onChange={e => update("ammoPlaceholder", e.target.value)}
                className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm"
                data-testid="input-default-ammo-placeholder" />
            </Field>
            <Field label="Auto-suggest per-pilot REMARKS">
              <label className="inline-flex items-center gap-2 text-xs cursor-pointer">
                <input type="checkbox" checked={d.autoSuggestRemarks}
                  onChange={e => update("autoSuggestRemarks", e.target.checked)}
                  data-testid="toggle-auto-suggest-remarks" />
                Suggest "X DAYS ANNUAL LEAVE / TDY / SICK" from leave records
              </label>
            </Field>
            <Field label="Min 6-month flying hours (currency floor)">
              <input type="number" step="1" min="0" value={d.minSixMonthHours}
                onChange={e => update("minSixMonthHours", parseFloat(e.target.value) || 0)}
                className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm"
                data-testid="input-default-min-six-month-hours" />
              <div className="text-[11px] text-muted-foreground mt-1">
                Threshold for the SIX-MONTHS sheet status flag. Pilots at or above
                this floor across the rolling 6-month window print as <b>OK</b>;
                within 20% as <b>LOW</b>; below as <b>UNDER</b>.
              </div>
            </Field>
            <Field label="Parent group / wing — full name">
              <input value={d.groupName} onChange={e => update("groupName", e.target.value)}
                className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm"
                data-testid="input-default-group-name"
                placeholder="e.g. ATTACK HELICOPTER GROUP" />
              <div className="text-[11px] text-muted-foreground mt-1">
                Printed at the top of every Monthly Report sheet, above the
                squadron name. Edit once per APK install for the unit.
              </div>
            </Field>
            <Field label="Parent group / wing — acronym">
              <input value={d.groupAcronym} onChange={e => update("groupAcronym", e.target.value)}
                className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm"
                data-testid="input-default-group-acronym"
                placeholder="e.g. AHG" />
              <div className="text-[11px] text-muted-foreground mt-1">
                Used as the prefix on every form name (e.g. <b>QRFG</b> RCN FORM 1,
                <b>QRFG</b> FUEL, <b>QRFG</b> AUTHORIZATION) and on the unit block.
              </div>
            </Field>
            <Field label="Sortie Log header label">
              <input value={d.sortieLogLabel} onChange={e => update("sortieLogLabel", e.target.value)}
                className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm"
                data-testid="input-default-sortie-log-label"
                placeholder="e.g. SQNLOG" />
              <div className="text-[11px] text-muted-foreground mt-1">
                Short tag shown above the daily Sortie Log on Add Sortie
                (e.g. <b>SQNLOG</b> · 2026-04-23 · {d.primaryAirframe || "your airframe"}).
                Each squadron picks its own short tag — examples include
                "SQNREG", "FLTLOG", or any short identifier.
              </div>
            </Field>
            <Field label="Primary airframe">
              <input value={d.primaryAirframe} onChange={e => update("primaryAirframe", e.target.value)}
                className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm"
                data-testid="input-default-primary-airframe"
                placeholder="e.g. UH-60M / AH-1F / F-16C/D" />
              <div className="text-[11px] text-muted-foreground mt-1">
                Squadron's main aircraft model. Used as the F1 unit-cell fallback,
                the Arabic-roster column header, and the FUEL helper text. Add the
                burn rate for it in the airframe table below.
              </div>
            </Field>
          </div>
        </Section>

        {/* Lecture topics */}
        <Section title="Lecture syllabus" hint="The standard lecture topics taught every month. Operator fills hours and quiz % per month — these are the topic names.">
          <ListEditor
            items={d.lectures}
            onChange={v => update("lectures", v)}
            placeholder="Lecture topic (EN/AR)"
            testId="lecture"
          />
        </Section>

        {/* Next-month plan exercises */}
        <Section title="Next-month plan exercises" hint="Standard exercise list shown on Form 4 — the operator fills pilots × sorties × duration × fuel/hr per row.">
          <ListEditor
            items={d.exercises}
            onChange={v => update("exercises", v)}
            placeholder="Exercise (e.g. GH, IF, NVG)"
            testId="exercise"
          />
        </Section>

        {/* Aircraft models the squadron flies */}
        <Section title="Aircraft models flown by this squadron"
          hint="Drives the A/C Type dropdown on Add Sortie, the Sortie Log edit form, and the seed value on every new Flight Program row. List every airframe your squadron flies — for example a UH-60 squadron might list UH-60M / UH-60L / UH-60AIL / AS332, while an AH-1F squadron would list its own variants. Whatever you list here also feeds the fuel-burn table below — add a burn rate for each one.">
          <ListEditor
            items={d.airframes}
            onChange={v => update("airframes", v)}
            placeholder="Airframe (e.g. UH-60M, AH-1F, CH-47D)"
            testId="airframe"
          />
        </Section>

        {/* Fuel-burn per airframe */}
        <Section title="Fuel burn rate (lb/hr) by airframe"
          hint="Used in the Form 4 / FUEL block to compute total fuel: pilots × sorties/pilot × duration × lb/hr. Add a row for every airframe your squadron flies — each row's rate is editable.">
          <div className="space-y-1">
            {airframes.map(a => (
              <div key={a} className="grid grid-cols-12 gap-2 items-center text-xs">
                <input value={a} disabled
                  className="col-span-5 bg-muted/30 border border-border rounded px-2 py-1.5 text-muted-foreground"
                  data-testid={`fuel-airframe-name-${a}`} />
                <div className="col-span-5 inline-flex items-center gap-2">
                  <input type="number" step="1" min="0" value={d.fuelBurnByAirframe[a]}
                    onChange={e => update("fuelBurnByAirframe", { ...d.fuelBurnByAirframe, [a]: parseFloat(e.target.value) || 0 })}
                    className="flex-1 bg-background border border-border rounded px-2 py-1.5"
                    data-testid={`fuel-burn-${a}`} />
                  <span className="text-muted-foreground">lb/hr</span>
                </div>
                <button onClick={() => {
                    if (!confirm(`Remove airframe "${a}"?`)) return;
                    const next = { ...d.fuelBurnByAirframe };
                    delete next[a];
                    update("fuelBurnByAirframe", next);
                  }}
                  className="col-span-2 text-destructive hover:bg-secondary rounded p-1 inline-flex items-center justify-center"
                  data-testid={`fuel-del-${a}`} title="Remove airframe">
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
            <AddAirframeRow
              existing={airframes}
              onAdd={(name, rate) => update("fuelBurnByAirframe", { ...d.fuelBurnByAirframe, [name]: rate })}
            />
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="bg-card border border-border rounded-lg p-4">
      <div className="text-sm font-semibold mb-1">{title}</div>
      {hint && <div className="text-xs text-muted-foreground mb-3">{hint}</div>}
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

function ListEditor({ items, onChange, placeholder, testId }: {
  items: string[]; onChange: (v: string[]) => void; placeholder: string; testId: string;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    onChange([...items, v]);
    setDraft("");
  };
  return (
    <div className="space-y-1">
      {items.map((it, i) => (
        <div key={i} className="grid grid-cols-12 gap-2 items-center text-xs">
          <input value={it}
            onChange={e => {
              const next = [...items];
              next[i] = e.target.value;
              onChange(next);
            }}
            className="col-span-10 bg-background border border-border rounded px-2 py-1.5"
            dir="auto"
            data-testid={`${testId}-item-${i}`} />
          <button onClick={() => {
              if (!confirm("Remove this item?")) return;
              onChange(items.filter((_, idx) => idx !== i));
            }}
            className="col-span-2 text-destructive hover:bg-secondary rounded p-1 inline-flex items-center justify-center"
            data-testid={`${testId}-del-${i}`}>
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      ))}
      <div className="grid grid-cols-12 gap-2 items-center text-xs pt-1">
        <input value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder={placeholder}
          dir="auto"
          className="col-span-10 bg-background border border-border rounded px-2 py-1.5"
          data-testid={`${testId}-new`} />
        <button onClick={add}
          className="col-span-2 px-2 py-1.5 rounded border border-border hover:bg-secondary inline-flex items-center justify-center gap-1"
          data-testid={`${testId}-add`}>
          <Plus className="h-3 w-3" /> Add
        </button>
      </div>
    </div>
  );
}

function AddAirframeRow({ existing, onAdd }: { existing: string[]; onAdd: (name: string, rate: number) => void }) {
  const [name, setName] = useState("");
  const [rate, setRate] = useState<number>(576);
  const submit = () => {
    const n = name.trim().toUpperCase();
    if (!n || existing.includes(n)) return;
    onAdd(n, rate || 0);
    setName("");
    setRate(576);
  };
  return (
    <div className="grid grid-cols-12 gap-2 items-center text-xs pt-2 border-t border-border mt-2">
      <input value={name} onChange={e => setName(e.target.value)} placeholder="New airframe (e.g. AH-1, OH-58)"
        className="col-span-5 bg-background border border-border rounded px-2 py-1.5"
        data-testid="new-airframe-name" />
      <div className="col-span-5 inline-flex items-center gap-2">
        <input type="number" step="1" min="0" value={rate}
          onChange={e => setRate(parseFloat(e.target.value) || 0)}
          className="flex-1 bg-background border border-border rounded px-2 py-1.5"
          data-testid="new-airframe-rate" />
        <span className="text-muted-foreground">lb/hr</span>
      </div>
      <button onClick={submit}
        className="col-span-2 px-2 py-1.5 rounded border border-border hover:bg-secondary inline-flex items-center justify-center gap-1"
        data-testid="new-airframe-add">
        <Plus className="h-3 w-3" /> Add
      </button>
    </div>
  );
}
