import { useEffect, useMemo, useState } from "react";
import { Card, PageHead } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { ChevronLeft, ChevronRight, Plus, Trash2, StickyNote } from "lucide-react";

/**
 * Sticky Notes Calendar
 *
 * A monthly calendar where each day cell can hold any number of small
 * sticky notes (text + color). Stored in localStorage on the operator's
 * PC — these are private working notes (e.g. "engine wash AM", "bring
 * NOTAM ZA-23"), not synced to the cloud.
 *
 * Storage shape:
 *   rjaf.stickyNotes.v1 = { [YYYY-MM-DD]: StickyNote[] }
 */

const STORAGE_KEY = "rjaf.stickyNotes.v1";

const COLORS = [
  { id: "amber",   bg: "bg-amber-200",   text: "text-amber-950",   border: "border-amber-400" },
  { id: "rose",    bg: "bg-rose-200",    text: "text-rose-950",    border: "border-rose-400" },
  { id: "sky",     bg: "bg-sky-200",     text: "text-sky-950",     border: "border-sky-400" },
  { id: "emerald", bg: "bg-emerald-200", text: "text-emerald-950", border: "border-emerald-400" },
  { id: "violet",  bg: "bg-violet-200",  text: "text-violet-950",  border: "border-violet-400" },
] as const;
type ColorId = typeof COLORS[number]["id"];
function colorFor(id: string) { return COLORS.find(c => c.id === id) ?? COLORS[0]; }

interface Note { id: string; text: string; color: ColorId; }
type Store = Record<string, Note[]>;

function loadStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Store;
  } catch { return {}; }
}
function saveStore(s: Store) { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); }

function isoKey(d: Date): string {
  const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, "0"); const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const MONTHS_EN = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DOW_EN = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

export default function StickyNotes() {
  const { t, lang } = useI18n();
  const [store, setStore] = useState<Store>(() => loadStore());
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [selected, setSelected] = useState<string>(() => isoKey(today));

  useEffect(() => { saveStore(store); }, [store]);

  // Calendar layout: build a Sun-leading 6-row grid (some months span 6 weeks)
  const cells = useMemo(() => {
    const first = new Date(year, month, 1);
    const start = new Date(first);
    start.setDate(1 - first.getDay());
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start); d.setDate(start.getDate() + i);
      return d;
    });
  }, [year, month]);

  function shiftMonth(delta: number) {
    let m = month + delta, y = year;
    if (m < 0) { m += 12; y -= 1; }
    if (m > 11) { m -= 12; y += 1; }
    setMonth(m); setYear(y);
  }
  function addNote(dayKey: string, text: string, color: ColorId) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setStore(prev => ({
      ...prev,
      [dayKey]: [...(prev[dayKey] ?? []), { id: crypto.randomUUID(), text: trimmed, color }],
    }));
  }
  function deleteNote(dayKey: string, noteId: string) {
    setStore(prev => {
      const list = (prev[dayKey] ?? []).filter(n => n.id !== noteId);
      const next = { ...prev };
      if (list.length === 0) delete next[dayKey]; else next[dayKey] = list;
      return next;
    });
  }
  function updateNote(dayKey: string, noteId: string, text: string) {
    setStore(prev => ({
      ...prev,
      [dayKey]: (prev[dayKey] ?? []).map(n => n.id === noteId ? { ...n, text } : n),
    }));
  }

  const selectedNotes = store[selected] ?? [];
  const monthLabel = lang === "ar"
    ? `${MONTHS_EN[month]} ${year}`
    : `${MONTHS_EN[month]} ${year}`;

  return (
    <div>
      <PageHead title={t("nav_sticky")} subtitle="Calendar with daily sticky notes (this PC only)" />
      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-4">
        <Card>
          <div className="flex items-center justify-between mb-3">
            <Button size="sm" variant="outline" onClick={() => shiftMonth(-1)} data-testid="button-sticky-prev">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <div className="text-base font-semibold gold-grad">{monthLabel}</div>
            <Button size="sm" variant="outline" onClick={() => shiftMonth(1)} data-testid="button-sticky-next">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          <div className="grid grid-cols-7 text-[11px] uppercase tracking-wider text-muted-foreground mb-1">
            {DOW_EN.map(d => <div key={d} className="text-center py-1">{d}</div>)}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {cells.map((d, i) => {
              const k = isoKey(d);
              const inMonth = d.getMonth() === month;
              const isToday = k === isoKey(today);
              const isSelected = k === selected;
              const notes = store[k] ?? [];
              return (
                <button
                  key={i}
                  onClick={() => setSelected(k)}
                  className={`min-h-[80px] rounded border p-1.5 text-left transition relative ${
                    isSelected ? "border-amber-400 ring-1 ring-amber-400" :
                    isToday    ? "border-emerald-500" :
                                 "border-border hover:bg-secondary/40"
                  } ${inMonth ? "" : "opacity-40"}`}
                  data-testid={`day-${k}`}
                >
                  <div className="flex items-center justify-between text-[11px] font-mono">
                    <span className={isToday ? "text-emerald-400 font-bold" : ""}>{d.getDate()}</span>
                    {notes.length > 0 && (
                      <span className="text-[9px] px-1 rounded bg-amber-500/30 text-amber-100">{notes.length}</span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-0.5 mt-1">
                    {notes.slice(0, 3).map(n => {
                      const c = colorFor(n.color);
                      return <span key={n.id} className={`block w-1.5 h-1.5 rounded-sm ${c.bg} border ${c.border}`} />;
                    })}
                  </div>
                </button>
              );
            })}
          </div>
        </Card>

        <Card>
          <div className="flex items-center gap-2 mb-2">
            <StickyNote className="h-4 w-4 text-amber-400" />
            <div className="text-sm font-semibold">{selected}</div>
          </div>
          <NoteEditor onAdd={(text, color) => addNote(selected, text, color)} />
          <div className="space-y-2 mt-3 max-h-[420px] overflow-y-auto">
            {selectedNotes.length === 0 && (
              <div className="text-xs text-muted-foreground text-center py-6" data-testid="empty-sticky-day">
                No notes for this day yet.
              </div>
            )}
            {selectedNotes.map(n => {
              const c = colorFor(n.color);
              return (
                <div key={n.id} className={`rounded-md p-2 ${c.bg} ${c.text} border ${c.border} flex gap-2`} data-testid={`note-${n.id}`}>
                  <textarea
                    value={n.text}
                    onChange={e => updateNote(selected, n.id, e.target.value)}
                    rows={2}
                    className="flex-1 bg-transparent outline-none resize-none text-sm font-medium"
                  />
                  <button
                    onClick={() => deleteNote(selected, n.id)}
                    className="self-start p-1 rounded hover:bg-black/10"
                    title="Delete"
                    data-testid={`button-delete-note-${n.id}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        </Card>
      </div>
    </div>
  );
}

function NoteEditor({ onAdd }: { onAdd: (text: string, color: ColorId) => void }) {
  const [text, setText] = useState("");
  const [color, setColor] = useState<ColorId>("amber");
  return (
    <div className="space-y-2 border-b border-border pb-3">
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="Write a note for this day…"
        rows={2}
        className="w-full px-2 py-1.5 rounded bg-input border border-border text-sm"
        data-testid="input-sticky-note"
      />
      <div className="flex items-center gap-1.5 flex-wrap">
        {COLORS.map(c => (
          <button
            key={c.id}
            onClick={() => setColor(c.id)}
            className={`w-6 h-6 rounded-full ${c.bg} border ${c.border} ${color === c.id ? "ring-2 ring-offset-1 ring-offset-background ring-foreground" : ""}`}
            title={c.id}
            data-testid={`color-${c.id}`}
          />
        ))}
        <Button
          size="sm"
          className="ms-auto"
          onClick={() => { onAdd(text, color); setText(""); }}
          disabled={!text.trim()}
          data-testid="button-add-note"
        >
          <Plus className="h-3.5 w-3.5 me-1" /> Add
        </Button>
      </div>
    </div>
  );
}
