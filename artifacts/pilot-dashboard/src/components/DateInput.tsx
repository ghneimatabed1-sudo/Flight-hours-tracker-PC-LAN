import { useEffect, useMemo, useRef, useState } from "react";
import { Calendar } from "lucide-react";

// Drop-in replacement for `<input type="date">` that always displays
// DD/MM/YYYY regardless of OS locale, while still emitting and storing
// ISO yyyy-mm-dd values so the rest of the app (DB, validation, fmtDate)
// keeps working without any other change.
//
// Behaviour:
//   • Visible input is text-mode, placeholder "dd/mm/yyyy".
//   • User can type the date directly. We accept dd/mm/yyyy or dd-mm-yyyy
//     (separator and zero-padding both optional). Invalid input clears
//     itself on blur.
//   • Calendar button opens the OS-native date picker via showPicker().
//     The picker still uses OS locale internally, but its result is
//     translated back to DD/MM/YYYY in the visible field — so even
//     operators on en-US Windows see day-first throughout.
//   • value: ISO yyyy-mm-dd or "" (matches the existing native input
//     contract). onChange returns the same.
//
// Why not just set <html lang="en-GB">? Chromium's date-input format
// follows the OS locale, not the document lang. On any Windows machine
// configured for en-US (which is most of them) the placeholder and the
// inline editor stay mm/dd/yyyy. The wrapper below is the only reliable
// cross-OS way to enforce DD/MM/YYYY.

function pad2(n: number): string { return n < 10 ? `0${n}` : String(n); }

function isoToDDMMYYYY(iso: string): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

// Parses dd/mm/yyyy or dd-mm-yyyy (separator and zero-padding optional).
// Returns ISO yyyy-mm-dd or null if the date is invalid.
function ddmmyyyyToIso(s: string): string | null {
  const t = s.trim();
  if (!t) return null;
  const m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (!m) return null;
  let dd = parseInt(m[1], 10);
  let mm = parseInt(m[2], 10);
  let yyyy = parseInt(m[3], 10);
  if (yyyy < 100) yyyy += 2000;
  if (!Number.isFinite(dd) || !Number.isFinite(mm) || !Number.isFinite(yyyy)) return null;
  if (mm < 1 || mm > 12) return null;
  if (dd < 1 || dd > 31) return null;
  // Round-trip via Date to catch impossible combinations like 31/02.
  const d = new Date(yyyy, mm - 1, dd);
  if (
    d.getFullYear() !== yyyy ||
    d.getMonth() !== mm - 1 ||
    d.getDate() !== dd
  ) return null;
  return `${yyyy}-${pad2(mm)}-${pad2(dd)}`;
}

export interface DateInputProps {
  value: string;
  onChange: (iso: string) => void;
  className?: string;
  disabled?: boolean;
  id?: string;
  min?: string;
  max?: string;
  autoFocus?: boolean;
  placeholder?: string;
  "data-testid"?: string;
}

export default function DateInput({
  value,
  onChange,
  className = "",
  disabled,
  id,
  min,
  max,
  autoFocus,
  placeholder = "dd/mm/yyyy",
  ...rest
}: DateInputProps) {
  const testId = (rest as { "data-testid"?: string })["data-testid"];
  const [text, setText] = useState<string>(() => isoToDDMMYYYY(value));
  const lastEmittedRef = useRef<string>(value);
  const hiddenRef = useRef<HTMLInputElement | null>(null);

  // Keep visible text in sync when the parent controls the value externally
  // (e.g. resetting a form). Skip when the change is the one we just
  // emitted ourselves to avoid clobbering an in-progress edit.
  useEffect(() => {
    if (value === lastEmittedRef.current) return;
    setText(isoToDDMMYYYY(value));
    lastEmittedRef.current = value;
  }, [value]);

  const commit = (raw: string) => {
    const iso = ddmmyyyyToIso(raw);
    if (iso === null) {
      // Empty string clears the value; otherwise reject and revert.
      if (!raw.trim()) {
        lastEmittedRef.current = "";
        onChange("");
        setText("");
      } else {
        setText(isoToDDMMYYYY(value));
      }
      return;
    }
    lastEmittedRef.current = iso;
    onChange(iso);
    setText(isoToDDMMYYYY(iso));
  };

  // Live DD/MM/YYYY mask: the operator just types digits and the slashes
  // appear automatically in the right places. Backspace removes the
  // previous digit (skipping back over slashes). Anything that isn't a
  // digit is dropped silently. Result is always shaped DD, DD/M, DD/MM,
  // DD/MM/Y…YYYY so the cursor never has to navigate over a separator.
  const formatMask = (raw: string): string => {
    const digits = raw.replace(/\D/g, "").slice(0, 8);
    if (digits.length <= 2) return digits;
    if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
    return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4, 8)}`;
  };

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setText(formatMask(e.target.value));
  };

  const openPicker = () => {
    if (disabled) return;
    const el = hiddenRef.current;
    if (!el) return;
    // showPicker() is supported in Chromium 99+ (Electron) and modern
    // browsers. Falls back to a focus+click which still pops the picker
    // on most platforms.
    try {
      const picker = (el as HTMLInputElement & { showPicker?: () => void }).showPicker;
      if (typeof picker === "function") picker.call(el);
      else { el.focus(); el.click(); }
    } catch {
      el.focus(); el.click();
    }
  };

  const wrapperCls = useMemo(() => {
    // Strip width / padding from the user-supplied className and reapply
    // them to the visible input — the wrapper handles layout, and the
    // input fills it. Anything else (border, bg, font, etc.) stays on the
    // wrapper so the existing visual styling is preserved.
    return className;
  }, [className]);

  return (
    <div className={`relative inline-flex items-stretch w-full ${wrapperCls}`}>
      <input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        value={text}
        onChange={onInputChange}
        onBlur={e => commit(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); commit((e.target as HTMLInputElement).value); } }}
        placeholder={placeholder}
        disabled={disabled}
        id={id}
        autoFocus={autoFocus}
        data-testid={testId}
        className="flex-1 bg-transparent outline-none border-0 p-0 text-inherit font-inherit placeholder:text-muted-foreground"
      />
      <button
        type="button"
        tabIndex={-1}
        onClick={openPicker}
        disabled={disabled}
        aria-label="Open calendar"
        className="ms-2 shrink-0 text-muted-foreground hover:text-amber-400 disabled:opacity-50"
      >
        <Calendar className="h-4 w-4" />
      </button>
      {/* Hidden native date input — only used as the picker source. Its
          value is mirrored from / to the visible text field so the OS
          calendar still works for users who prefer to click rather than
          type. */}
      <input
        ref={hiddenRef}
        type="date"
        tabIndex={-1}
        aria-hidden="true"
        value={value}
        min={min}
        max={max}
        onChange={e => commit(isoToDDMMYYYY(e.target.value))}
        className="absolute opacity-0 pointer-events-none w-0 h-0"
      />
    </div>
  );
}
