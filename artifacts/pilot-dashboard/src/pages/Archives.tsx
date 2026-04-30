import { useMemo, useState } from "react";
import DateInput from "@/components/DateInput";
import { Archive, Download, FolderArchive, FileJson, Pencil, Plus, Trash2, Save, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { PageHead } from "@/components/Layout";
import {
  listArchives, downloadArchive, runArchiveCheck, getArchive, saveArchive,
  type ArchiveEntry,
} from "@/lib/archive";
import type { Sortie, Pilot } from "@/lib/mock";

export default function Archives() {
  const { t, lang, rankOf } = useI18n();
  const [tick, setTick] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const items = useMemo(() => listArchives(), [tick]);

  const months = items.filter(i => i.kind === "month");
  const years = items.filter(i => i.kind === "year");

  const fmtPeriod = (p: string) => {
    if (p.length === 4) return p;
    // MM-YYYY (DD-MM-YYYY without the day for monthly archives) — keeps
    // archive labels in the same family as every other date in the app.
    const [y, m] = p.split("-");
    const d = new Date(Number(y), Number(m) - 1, 1);
    return d.toLocaleDateString(lang === "ar" ? "ar-EG" : "en-US", { year: "numeric", month: "long" });
  };

  const onCheckNow = () => { runArchiveCheck(); setTick(x => x + 1); };
  const refresh = () => setTick(x => x + 1);

  return (
    <div>
      <PageHead
        title={t("archivesTitle")}
        subtitle={t("archivesSubtitle")}
        actions={
          <button onClick={onCheckNow}
            className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-secondary"
            data-testid="button-archive-check-now">
            {t("archivesCheckNow")}
          </button>
        }
      />

      <div className="grid gap-6 md:grid-cols-2 mt-4">
        {[
          { title: t("archivesYearly"), icon: FolderArchive, list: years, empty: t("archivesEmptyYearly") },
          { title: t("archivesMonthly"), icon: Archive, list: months, empty: t("archivesEmptyMonthly") },
        ].map((sec, idx) => (
          <section key={idx} className="bg-card border border-border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-3">
              <sec.icon className="h-4 w-4 text-primary" />
              <h3 className="font-semibold">{sec.title}</h3>
              <span className="text-xs text-muted-foreground">({sec.list.length})</span>
            </div>
            {sec.list.length === 0 ? (
              <p className="text-sm text-muted-foreground">{sec.empty}</p>
            ) : (
              <ul className="divide-y divide-border">
                {sec.list.map(it => (
                  <li key={it.key} className="flex items-center justify-between py-2 text-sm gap-2" data-testid={`row-archive-${it.period}`}>
                    <div className="min-w-0">
                      <div className="font-medium flex items-center gap-2">
                        {it.kind === "month" && <FileJson className="h-3.5 w-3.5 text-muted-foreground" />}
                        {fmtPeriod(it.period)}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {t("archivesTotals")
                          .replace("{s}", String(it.totals.sortieCount))
                          .replace("{p}", String(it.totals.pilotCount))
                          .replace("{h}", String(it.totals.flightHours))}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={() => setEditing(it.period)}
                        className="text-xs px-2 py-1 rounded-md border border-border hover:bg-secondary inline-flex items-center gap-1"
                        data-testid={`button-edit-${it.period}`}>
                        <Pencil className="h-3.5 w-3.5" /> {t("edit")}
                      </button>
                      <button onClick={() => downloadArchive(it.period)}
                        className="text-xs px-2 py-1 rounded-md border border-border hover:bg-secondary inline-flex items-center gap-1"
                        data-testid={`button-download-${it.period}`}>
                        <Download className="h-3.5 w-3.5" /> {t("archivesDownload")}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>

      <p className="text-xs text-muted-foreground mt-4">{t("archivesNote")}</p>

      {editing && (
        <ArchiveEditor period={editing} onClose={() => { setEditing(null); refresh(); }} />
      )}
    </div>
  );
}

function ArchiveEditor({ period, onClose }: { period: string; onClose: () => void }) {
  const { t, rankOf } = useI18n();
  const initial = useMemo(() => getArchive(period), [period]);
  const [pilots, setPilots] = useState<Pilot[]>(() => initial?.pilots ?? []);
  const [sorties, setSorties] = useState<Sortie[]>(() => initial?.sorties ?? []);
  const [confirmSave, setConfirmSave] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  if (!initial) return null;

  const pilotName = (id: string) => pilots.find(p => p.id === id)?.name || id;

  const updateSortie = (id: string, patch: Partial<Sortie>) => {
    setSorties(arr => arr.map(s => s.id === id ? { ...s, ...patch } : s));
    setDirty(true);
  };
  const removeSortie = (id: string) => {
    setSorties(arr => arr.filter(s => s.id !== id));
    setConfirmDeleteId(null);
    setDirty(true);
  };
  const addSortie = () => {
    const today = new Date().toISOString().slice(0, 10);
    const newSortie: Sortie = {
      id: `arc-${Date.now()}`,
      date: period.length === 7 ? `${period}-01` : today,
      acType: "UH-60M", acNumber: "",
      pilotId: pilots[0]?.id || "", coPilotId: "",
      sortieType: "Training", name: "",
      day1: 0, day2: 0, dayDual: 0,
      night1: 0, night2: 0, nightDual: 0,
      nvg: 0, sim: 0, actual: 0,
    } as Sortie;
    setSorties(arr => [newSortie, ...arr]);
    setDirty(true);
  };
  const updatePilot = (id: string, name: string) => {
    setPilots(arr => arr.map(p => p.id === id ? { ...p, name } : p));
    setDirty(true);
  };

  const doSave = () => {
    const next: ArchiveEntry = initial.kind === "month"
      ? { ...initial, pilots, sorties }
      : { ...initial, pilots, sorties };
    saveArchive(period, next);
    setConfirmSave(false);
    onClose();
  };

  const num = (v: string) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  };

  return (
    <div className="fixed inset-0 z-40 bg-black/70 flex items-center justify-center p-4" data-testid="modal-archive-editor">
      <div className="bg-card border border-border rounded-lg w-full max-w-5xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div>
            <h3 className="font-semibold">{t("archiveEditTitle")} — {period}</h3>
            <p className="text-xs text-muted-foreground">{t("archiveEditBlurb")}</p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-secondary" data-testid="button-archive-editor-close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="overflow-y-auto p-4 space-y-6 flex-1">
          <section>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-semibold">{t("archivePilots")} ({pilots.length})</h4>
            </div>
            {pilots.length === 0 ? (
              <p className="text-xs text-muted-foreground">—</p>
            ) : (
              <div className="space-y-1">
                {pilots.map(p => (
                  <div key={p.id} className="flex items-center gap-2 text-sm" data-testid={`row-archive-pilot-${p.id}`}>
                    <span className="text-xs text-muted-foreground w-16 shrink-0">{p.id}</span>
                    <input value={p.name}
                      onChange={e => updatePilot(p.id, e.target.value)}
                      className="flex-1 bg-background border border-border rounded px-2 py-1 text-sm"
                      data-testid={`input-archive-pilot-name-${p.id}`} />
                    <span className="text-xs text-muted-foreground w-20 truncate">{rankOf(p)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-semibold">{t("archiveSorties")} ({sorties.length})</h4>
              <button onClick={addSortie}
                className="text-xs px-2 py-1 rounded-md border border-border hover:bg-secondary inline-flex items-center gap-1"
                data-testid="button-archive-add-sortie">
                <Plus className="h-3.5 w-3.5" /> {t("archiveAddSortie")}
              </button>
            </div>
            {sorties.length === 0 ? (
              <p className="text-xs text-muted-foreground">—</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-muted-foreground">
                    <tr className="border-b border-border">
                      <th className="text-left p-1.5">{t("date")}</th>
                      <th className="text-left p-1.5">{t("pilot")}</th>
                      <th className="text-left p-1.5">{t("coPilot")}</th>
                      <th className="text-right p-1.5">D1</th>
                      <th className="text-right p-1.5">D2</th>
                      <th className="text-right p-1.5">DD</th>
                      <th className="text-right p-1.5">N1</th>
                      <th className="text-right p-1.5">N2</th>
                      <th className="text-right p-1.5">ND</th>
                      <th className="text-right p-1.5">NVG</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {sorties.map(s => (
                      <tr key={s.id} className="border-b border-border/50" data-testid={`row-archive-sortie-${s.id}`}>
                        <td className="p-1"><DateInput value={s.date}
                          onChange={(v) => updateSortie(s.id, { date: v })}
                          className="bg-background border border-border rounded px-1 py-0.5 w-32"
                          data-testid={`input-archive-sortie-date-${s.id}`} /></td>
                        <td className="p-1"><select value={s.pilotId}
                          onChange={e => updateSortie(s.id, { pilotId: e.target.value })}
                          className="bg-background border border-border rounded px-1 py-0.5 max-w-[140px]">
                          {pilots.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                          {!pilots.some(p => p.id === s.pilotId) && <option value={s.pilotId}>{pilotName(s.pilotId)}</option>}
                        </select></td>
                        <td className="p-1"><select value={s.coPilotId}
                          onChange={e => updateSortie(s.id, { coPilotId: e.target.value })}
                          className="bg-background border border-border rounded px-1 py-0.5 max-w-[140px]">
                          <option value="">—</option>
                          {pilots.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                          {s.coPilotId && !pilots.some(p => p.id === s.coPilotId) && <option value={s.coPilotId}>{pilotName(s.coPilotId)}</option>}
                        </select></td>
                        {(["day1","day2","dayDual","night1","night2","nightDual","nvg"] as const).map(k => (
                          <td key={k} className="p-1">
                            <input type="number" step="0.1" min="0" value={s[k]}
                              onChange={e => updateSortie(s.id, { [k]: num(e.target.value) } as Partial<Sortie>)}
                              className="bg-background border border-border rounded px-1 py-0.5 w-14 text-right"
                              data-testid={`input-archive-sortie-${k}-${s.id}`} />
                          </td>
                        ))}
                        <td className="p-1 text-right">
                          <button onClick={() => setConfirmDeleteId(s.id)}
                            className="p-1 rounded hover:bg-destructive/20 text-destructive"
                            data-testid={`button-archive-sortie-delete-${s.id}`}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        <div className="flex items-center justify-between p-4 border-t border-border">
          <span className="text-xs text-muted-foreground">{dirty ? t("archiveUnsaved") : t("archiveNoChanges")}</span>
          <div className="flex items-center gap-2">
            <button onClick={onClose}
              className="px-3 py-1.5 rounded-md border border-border text-sm hover:bg-secondary"
              data-testid="button-archive-cancel">{t("cancel")}</button>
            <button onClick={() => setConfirmSave(true)} disabled={!dirty}
              className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium inline-flex items-center gap-1 disabled:opacity-40"
              data-testid="button-archive-save">
              <Save className="h-3.5 w-3.5" /> {t("save_changes")}
            </button>
          </div>
        </div>
      </div>

      {confirmSave && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" data-testid="modal-archive-confirm-save">
          <div className="bg-card border border-border rounded-lg p-5 max-w-md w-full">
            <h3 className="font-semibold mb-2">{t("areYouSure")}</h3>
            <p className="text-sm text-muted-foreground mb-4">{t("archiveSaveConfirm")}</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmSave(false)}
                className="px-3 py-1.5 rounded-md border border-border text-sm"
                data-testid="button-archive-confirm-cancel">{t("cancel")}</button>
              <button onClick={doSave}
                className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium"
                data-testid="button-archive-confirm-save">{t("yesSaveChanges")}</button>
            </div>
          </div>
        </div>
      )}

      {confirmDeleteId && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" data-testid="modal-archive-confirm-delete">
          <div className="bg-card border border-border rounded-lg p-5 max-w-md w-full">
            <h3 className="font-semibold mb-2">{t("areYouSure")}</h3>
            <p className="text-sm text-muted-foreground mb-4">{t("archiveDeleteSortieConfirm")}</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmDeleteId(null)}
                className="px-3 py-1.5 rounded-md border border-border text-sm"
                data-testid="button-archive-delete-cancel">{t("cancel")}</button>
              <button onClick={() => removeSortie(confirmDeleteId)}
                className="px-3 py-1.5 rounded-md bg-destructive text-destructive-foreground text-sm font-medium"
                data-testid="button-archive-delete-confirm">{t("yesDelete")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
