import { useMemo } from "react";
import { Plus, X } from "lucide-react";

// Multi-segment text input with a pre-printed separator between
// segments. Built for the qualification field on the Add Pilot form
// so the operator types each tag (e.g. "AC", "IP") into its own box
// instead of having to type "AC / IP" with the slash by hand. The
// underlying value is still a single joined string — backwards
// compatible with the existing pilot.qualifications storage.

export interface MultiSegmentFieldProps {
  value: string[];
  onChange: (next: string[]) => void;
  separator?: "/" | "-";
  maxSegments?: number;
  placeholder?: string;
  testIdPrefix?: string;
  className?: string;
}

export default function MultiSegmentField({
  value,
  onChange,
  separator = "/",
  maxSegments = 6,
  placeholder = "",
  testIdPrefix = "segment",
  className = "",
}: MultiSegmentFieldProps) {
  // Always render at least one box so the operator has somewhere to
  // start typing; cap at `maxSegments` so the row stays compact.
  const segments = useMemo(() => {
    const list = (value ?? []).slice(0, maxSegments);
    return list.length === 0 ? [""] : list;
  }, [value, maxSegments]);

  const update = (i: number, v: string) => {
    const next = [...segments];
    next[i] = v.toUpperCase();
    // Keep trailing empty boxes in place while editing — only filter
    // empties on save (handled by the Roster form). Here we just emit
    // the current snapshot.
    onChange(next);
  };

  const add = () => {
    if (segments.length >= maxSegments) return;
    onChange([...segments, ""]);
  };

  const remove = (i: number) => {
    const next = segments.filter((_, idx) => idx !== i);
    onChange(next.length === 0 ? [] : next);
  };

  const canAdd = segments.length < maxSegments;

  return (
    <div className={`flex flex-wrap items-center gap-1 ${className}`}>
      {segments.map((seg, i) => (
        <div key={i} className="flex items-center gap-1">
          <input
            type="text"
            value={seg}
            onChange={(e) => update(i, e.target.value)}
            placeholder={placeholder}
            data-testid={`${testIdPrefix}-${i}`}
            className="w-16 px-2 py-1.5 rounded-md bg-input border border-border text-sm font-mono tracking-wider text-center uppercase"
          />
          {segments.length > 1 ? (
            <button
              type="button"
              onClick={() => remove(i)}
              aria-label={`Remove segment ${i + 1}`}
              data-testid={`${testIdPrefix}-remove-${i}`}
              className="p-1 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
              title="Remove"
            >
              <X className="h-3 w-3" />
            </button>
          ) : null}
          {i < segments.length - 1 ? (
            <span className="text-muted-foreground font-mono select-none px-0.5">{separator}</span>
          ) : null}
        </div>
      ))}
      {canAdd ? (
        <button
          type="button"
          onClick={add}
          data-testid={`${testIdPrefix}-add`}
          className="ms-1 inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border bg-secondary text-xs hover:bg-secondary/70"
          title="Add segment"
        >
          <Plus className="h-3 w-3" /> Add
        </button>
      ) : null}
    </div>
  );
}

// Tolerant split: turns "AC / IP", "AC/IP", "AC - IP", "AC, IP",
// "AC|IP" or an existing string[] into a clean string[] of segments.
// Used when loading an existing pilot record into the form so legacy
// values display correctly in the multi-segment editor.
export function splitQualificationSegments(input: string | string[] | undefined | null): string[] {
  if (!input) return [];
  const flat = Array.isArray(input) ? input.join(" / ") : String(input);
  return flat
    .split(/[/\-,|]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

// Joiner — used on save to fold the segments back into the value the
// rest of the app expects. Pilot.qualifications is an array, so we
// keep it as an array (no schema change) and just trim/dedup.
export function joinQualificationSegments(segments: string[]): string[] {
  const cleaned = (segments ?? [])
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return Array.from(new Set(cleaned));
}
