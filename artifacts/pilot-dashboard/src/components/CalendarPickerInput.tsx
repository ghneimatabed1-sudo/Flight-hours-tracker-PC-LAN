import { useMemo, useState } from "react";
import { Calendar as CalendarIcon } from "lucide-react";
import { DayPicker } from "react-day-picker";
import "react-day-picker/style.css";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

// Click-only calendar picker. Drop-in replacement for the typed
// <DateInput> on the Unavailable Pilots and Leaves pages: same string
// contract (ISO yyyy-mm-dd in / out, "" for empty) but the visible
// surface is a button that opens a month grid. The operator never has
// to type a date.
//
// The visible button shows DD/MM/YYYY so squadrons that prefer
// day-first see a familiar format regardless of OS locale, matching
// DateInput's display rules.

function pad2(n: number): string { return n < 10 ? `0${n}` : String(n); }

function isoToDDMMYYYY(iso: string): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function isoToDate(iso: string): Date | undefined {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return undefined;
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function dateToIso(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export interface CalendarPickerInputProps {
  value: string;
  onChange: (iso: string) => void;
  className?: string;
  disabled?: boolean;
  placeholder?: string;
  "data-testid"?: string;
}

export default function CalendarPickerInput({
  value,
  onChange,
  className = "",
  disabled,
  placeholder = "dd/mm/yyyy",
  ...rest
}: CalendarPickerInputProps) {
  const testId = (rest as { "data-testid"?: string })["data-testid"];
  const [open, setOpen] = useState(false);
  const selected = useMemo(() => isoToDate(value), [value]);
  const display = isoToDDMMYYYY(value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          data-testid={testId}
          className={`relative inline-flex items-center justify-between text-left ${className}`}
        >
          <span className={display ? "" : "text-muted-foreground"}>
            {display || placeholder}
          </span>
          <CalendarIcon className="h-4 w-4 ms-2 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-2" align="start">
        <DayPicker
          mode="single"
          selected={selected}
          defaultMonth={selected}
          onSelect={(d) => {
            if (d) {
              onChange(dateToIso(d));
              setOpen(false);
            } else {
              onChange("");
            }
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
