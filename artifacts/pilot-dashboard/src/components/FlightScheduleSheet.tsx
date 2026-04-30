import { useMemo } from "react";
import { Plus, X } from "lucide-react";
import emblem from "@assets/rjaf_emblem.png";
import heloCobra from "@assets/fp_media/image1.jpg";
import heloBlackhawk from "@assets/fp_media/image2.jpg";
import heloLittleBird from "@assets/fp_media/image3.jpg";
import heloHeavy from "@assets/fp_media/image4.jpg";
import type { ScheduleProgram, ScheduleProgramRow } from "@/lib/cross-pc";

// One reusable RJAF flight schedule paper. Used by:
//   • pages/FlightProgram.tsx — editable, on the squadron ops PC
//   • pages/ScheduleChain.tsx — read-only on receivers, editable in the
//     edit-and-return overlay
// The crew block is PILOT + CO-PILOT only (the legacy CREW-MEN column
// has been retired). The visual layout, helo header, airbase / squadron
// lines, briefing strip, A/C-needed strip and FLT.CMDR / SQDN.CMDR
// signature block are all identical across pages so the recipient sees
// the same paper the originator created.

export type Mode = ScheduleProgram["mode"];

export interface SheetRowOptions {
  pilotOptions: Array<{ value: string; label: string }>;
}

export interface FlightScheduleSheetProps {
  prog: ScheduleProgram;
  /** When set, the sheet renders editable inputs and calls back. */
  onChange?: (next: ScheduleProgram) => void;
  pilotOptions: Array<{ value: string; label: string }>;
  /** Approval banner shown across the top when set. */
  approvedAt?: string;
  approvedBy?: string;
  /** Subtle status badge (submitted / edited / etc) inside the sheet. */
  statusLabel?: string;
}

const dayOfWeek = (iso: string): string => {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { weekday: "long" });
};

const formatDate = (iso: string): string => {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
};

export function emptyProgramRow(dn: string, acType: string): ScheduleProgramRow {
  return {
    dn,
    acType,
    toTime: "",
    pilot: "",
    coPilot: "",
    msnDuty: "",
    duration: "",
    fuel: "",
    configuration: "",
    route: "",
    remarks: "",
    atcTakeoff: "",
    atcLanding: "",
  };
}

export default function FlightScheduleSheet({
  prog,
  onChange,
  pilotOptions,
  approvedAt,
  approvedBy,
  statusLabel,
}: FlightScheduleSheetProps) {
  const readOnly = !onChange;

  const showDay =
    prog.mode === "DAY" ||
    prog.mode === "DAY_AND_NVG" ||
    prog.mode === "DAY_AND_NIGHT";
  const showNight =
    prog.mode === "NIGHT" ||
    prog.mode === "NVG" ||
    prog.mode === "DAY_AND_NVG" ||
    prog.mode === "DAY_AND_NIGHT";
  const nightLabel =
    prog.mode === "NVG" || prog.mode === "DAY_AND_NVG" ? "NVG" : "NIGHT";
  const defaultNightDn = nightLabel === "NVG" ? "NVG" : "N";
  const seedAcType = useMemo(() => {
    return (
      prog.dayRows[0]?.acType ||
      prog.nightRows[0]?.acType ||
      "UH-60M"
    );
  }, [prog.dayRows, prog.nightRows]);

  const update = <K extends keyof ScheduleProgram>(k: K, v: ScheduleProgram[K]) => {
    if (!onChange) return;
    onChange({ ...prog, [k]: v });
  };
  const updateRow = (
    section: "dayRows" | "nightRows",
    idx: number,
    patch: Partial<ScheduleProgramRow>,
  ) => {
    if (!onChange) return;
    const rows = prog[section].slice();
    rows[idx] = { ...rows[idx], ...patch };
    onChange({ ...prog, [section]: rows });
  };
  const addRow = (section: "dayRows" | "nightRows") => {
    if (!onChange) return;
    const dn = section === "dayRows" ? "D" : defaultNightDn;
    onChange({ ...prog, [section]: [...prog[section], emptyProgramRow(dn, seedAcType)] });
  };
  const removeRow = (section: "dayRows" | "nightRows", idx: number) => {
    if (!onChange) return;
    const rows = prog[section].slice();
    rows.splice(idx, 1);
    const safe = rows.length
      ? rows
      : [emptyProgramRow(section === "dayRows" ? "D" : defaultNightDn, seedAcType)];
    onChange({ ...prog, [section]: safe });
  };

  return (
    <div
      id="flight-program-sheet"
      className="print-target bg-white text-black border border-black p-3 space-y-2 text-[11px] print:text-[9px] print:p-2 relative"
      dir="ltr"
    >
      {approvedAt && (
        <div
          className="absolute right-3 top-2 select-none rotate-[-12deg] text-emerald-700/90 border-2 border-emerald-700/80 px-3 py-1 text-[14px] font-extrabold tracking-[0.25em]"
          data-testid="approved-stamp"
        >
          APPROVED{approvedBy ? ` · ${approvedBy}` : ""}
        </div>
      )}
      {statusLabel && !approvedAt && (
        <div className="absolute right-3 top-2 text-[10px] font-bold tracking-widest text-amber-700 border border-amber-600/60 px-2 py-0.5 rounded">
          {statusLabel}
        </div>
      )}

      {/* CLASSIFIED + helicopter header — pixel-for-pixel reproduction of
          the original RJAF xlsx drawing, identical across every PC. */}
      <div className="text-center text-[10px] font-bold tracking-[0.4em]">CLASSIFIED</div>
      <div className="relative w-full" style={{ aspectRatio: "20363369 / 2438400" }}>
        <img src={heloBlackhawk}  alt="" className="absolute object-contain" style={{ left: "0%",     top: "28.12%", width: "14.69%", height: "67.41%" }} />
        <img src={heloHeavy}      alt="" className="absolute object-contain" style={{ left: "20.23%", top: "9.37%",  width: "17.10%", height: "90.62%" }} />
        <img src={emblem}         alt="" className="absolute object-contain" style={{ left: "38.25%", top: "0%",     width: "21.00%", height: "96.00%" }} />
        <img src={heloLittleBird} alt="" className="absolute object-contain" style={{ left: "65.00%", top: "28.68%", width: "12.37%", height: "53.35%" }} />
        <img src={heloCobra}      alt="" className="absolute object-contain" style={{ left: "80.72%", top: "17.35%", width: "19.28%", height: "47.25%", transform: "rotate(-4.05deg)", transformOrigin: "center" }} />
      </div>

      {/* Title block: AIRBASE / SQUADRON / FLIGHT SCHEDULE */}
      <div className="text-center leading-tight">
        {readOnly ? (
          <div className="text-sm font-bold">{prog.airbase}</div>
        ) : (
          <input
            value={prog.airbase}
            onChange={(e) => update("airbase", e.target.value)}
            className="text-sm font-bold bg-transparent text-center outline-none hover:bg-yellow-50 focus:bg-yellow-50 w-[28ch]"
            data-testid="input-airbase"
          />
        )}
        {readOnly ? (
          <div className="text-sm font-bold">{prog.squadron}</div>
        ) : (
          <input
            value={prog.squadron}
            onChange={(e) => update("squadron", e.target.value)}
            className="text-sm font-bold bg-transparent text-center outline-none hover:bg-yellow-50 focus:bg-yellow-50 w-[20ch] block mx-auto"
            data-testid="input-squadron"
          />
        )}
        <div className="text-base font-bold underline tracking-wider mt-0.5">FLIGHT SCHEDULE</div>
      </div>

      {/* Day + Date strip */}
      <div className="flex items-center justify-between border-t border-b border-black py-1 px-1">
        <div className="font-semibold">DAY : <span className="font-normal">{dayOfWeek(prog.date)}</span></div>
        <div className="font-semibold">DATE : <span className="font-normal">{formatDate(prog.date)}</span></div>
      </div>

      {/* Pilot autocomplete options — declared once outside the table so
          the rendered HTML is valid (datalist inside <tr> is a hydration
          error). */}
      <datalist id="fp-pilots">
        {pilotOptions.map((p) => (
          <option key={p.value} value={p.value}>{p.label}</option>
        ))}
      </datalist>

      {/* MAIN TABLE — DAY + NIGHT bands.
          Column order matches the originator's requested layout:
            NO · D/N · A/C TYPE · PILOT · CO-PILOT · CONFIGURATION · ROUTE
            · T/O TIME · MSN/DUTY · DUR. · FUEL · REMARKS · ATC T/O · ATC LDG
          Total columns: 14. */}
      <table className="w-full border-collapse border border-black">
        <thead className="bg-gray-200">
          <tr>
            <Th w="3%"  rowSpan={2}>NO</Th>
            <Th w="4%"  rowSpan={2}>D/N</Th>
            <Th w="7%"  rowSpan={2}>A/C TYPE</Th>
            <Th        colSpan={2}>CREW</Th>
            <Th w="11%" rowSpan={2}>CONFIGURATION</Th>
            <Th w="11%" rowSpan={2}>ROUTE</Th>
            <Th w="6%"  rowSpan={2}>T/O TIME</Th>
            <Th w="11%" rowSpan={2}>MSN \ DUTY</Th>
            <Th w="5%"  rowSpan={2}>DUR.</Th>
            <Th w="5%"  rowSpan={2}>FUEL</Th>
            <Th w="10%" rowSpan={2}>REMARKS</Th>
            <Th        colSpan={2}>ATC USE</Th>
          </tr>
          <tr>
            <Th w="9%">PILOT</Th>
            <Th w="9%">CO-PILOT</Th>
            <Th w="5%">TAKE OFF</Th>
            <Th w="5%">LANDING</Th>
          </tr>
        </thead>
        <tbody>
          {showDay && (
            <>
              <tr>
                <td colSpan={14} className="border border-black bg-gray-100 text-center font-bold py-0.5">DAY</td>
              </tr>
              {prog.dayRows.map((r, i) => (
                <RowInputs
                  key={`d${i}`}
                  index={i + 1}
                  row={r}
                  readOnly={readOnly}
                  onChange={(patch) => updateRow("dayRows", i, patch)}
                  onRemove={!readOnly && prog.dayRows.length > 1 ? () => removeRow("dayRows", i) : undefined}
                />
              ))}
              {!readOnly && (
                <tr className="no-print">
                  <td colSpan={14} className="border border-black bg-white text-left p-1">
                    <button
                      type="button"
                      onClick={() => addRow("dayRows")}
                      className="inline-flex items-center gap-1 text-[10px] font-semibold text-blue-700 hover:underline"
                      data-testid="button-add-day-row"
                    >
                      <Plus className="h-3 w-3" /> Add day row
                    </button>
                  </td>
                </tr>
              )}
            </>
          )}

          {showNight && (
            <>
              <tr>
                <td colSpan={14} className="border border-black bg-gray-100 text-center font-bold py-0.5">{nightLabel}</td>
              </tr>
              {prog.nightRows.map((r, i) => (
                <RowInputs
                  key={`n${i}`}
                  index={i + 1}
                  row={{ ...r, dn: r.dn || defaultNightDn }}
                  readOnly={readOnly}
                  onChange={(patch) => updateRow("nightRows", i, patch)}
                  onRemove={!readOnly && prog.nightRows.length > 1 ? () => removeRow("nightRows", i) : undefined}
                />
              ))}
              {!readOnly && (
                <tr className="no-print">
                  <td colSpan={14} className="border border-black bg-white text-left p-1">
                    <button
                      type="button"
                      onClick={() => addRow("nightRows")}
                      className="inline-flex items-center gap-1 text-[10px] font-semibold text-blue-700 hover:underline"
                      data-testid="button-add-night-row"
                    >
                      <Plus className="h-3 w-3" /> Add {nightLabel.toLowerCase()} row
                    </button>
                  </td>
                </tr>
              )}
            </>
          )}
        </tbody>
      </table>

      {/* Briefing row */}
      <table className="w-full border-collapse border border-black">
        <thead className="bg-gray-200">
          <tr>
            <Th>MAIN BRIEFER</Th>
            <Th>BRIEF TIME</Th>
            <Th>DAY OPS</Th>
            <Th>NIGHT OPS</Th>
            <Th>LECTURE</Th>
            <Th>CAPTE</Th>
            <Th>NIGHT BRIEF</Th>
            <Th>REPORTING TIME</Th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <CellInput value={prog.mainBriefer}    readOnly={readOnly} onChange={(v) => update("mainBriefer", v)} />
            <CellInput value={prog.briefTime}      readOnly={readOnly} onChange={(v) => update("briefTime", v)} />
            <CellInput value={prog.dayOps}         readOnly={readOnly} onChange={(v) => update("dayOps", v)} />
            <CellInput value={prog.nightOps}       readOnly={readOnly} onChange={(v) => update("nightOps", v)} />
            <CellInput value={prog.lecture}        readOnly={readOnly} onChange={(v) => update("lecture", v)} />
            <CellInput value={prog.capte}          readOnly={readOnly} onChange={(v) => update("capte", v)} />
            <CellInput value={prog.nightBrief}     readOnly={readOnly} onChange={(v) => update("nightBrief", v)} />
            <CellInput value={prog.reportingTime}  readOnly={readOnly} onChange={(v) => update("reportingTime", v)} />
          </tr>
        </tbody>
      </table>

      {/* AC-NEEDED + signature block */}
      <div className="grid grid-cols-12 gap-2">
        <table className="col-span-6 border-collapse border border-black text-[10px]">
          <thead className="bg-gray-200">
            <tr>
              <Th>A/C NEEDED</Th>
              <Th>MAIN</Th>
              <Th>STBY</Th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="border border-black bg-gray-100 text-center font-semibold">DAY</td>
              <CellInput value={prog.acNeededDay.main}    readOnly={readOnly} onChange={(v) => update("acNeededDay",   { ...prog.acNeededDay,   main: v })} />
              <CellInput value={prog.acNeededDay.stby}    readOnly={readOnly} onChange={(v) => update("acNeededDay",   { ...prog.acNeededDay,   stby: v })} />
            </tr>
            <tr>
              <td className="border border-black bg-gray-100 text-center font-semibold">NIGHT</td>
              <CellInput value={prog.acNeededNight.main}  readOnly={readOnly} onChange={(v) => update("acNeededNight", { ...prog.acNeededNight, main: v })} />
              <CellInput value={prog.acNeededNight.stby}  readOnly={readOnly} onChange={(v) => update("acNeededNight", { ...prog.acNeededNight, stby: v })} />
            </tr>
          </tbody>
        </table>

        <div className="col-span-6 grid grid-cols-2 gap-4 pb-1">
          <div className="text-center">
            <div className="font-bold text-[11px] mb-1">FLT.CMDR</div>
            {readOnly ? (
              <div className="font-bold text-[11px] border-b border-black px-1">{prog.fltCmdr || "\u00A0"}</div>
            ) : (
              <input
                value={prog.fltCmdr}
                onChange={(e) => update("fltCmdr", e.target.value)}
                className="w-full bg-transparent border-b border-black outline-none px-1 text-[11px] text-center font-bold"
                data-testid="input-flt-cmdr"
              />
            )}
          </div>
          <div className="text-center">
            <div className="font-bold text-[11px] mb-1">SQDN.CMDR</div>
            {readOnly ? (
              <div className="font-bold text-[11px] border-b border-black px-1">{prog.sqdnCmdr || "\u00A0"}</div>
            ) : (
              <input
                value={prog.sqdnCmdr}
                onChange={(e) => update("sqdnCmdr", e.target.value)}
                className="w-full bg-transparent border-b border-black outline-none px-1 text-[11px] text-center font-bold"
                data-testid="input-sqdn-cmdr"
              />
            )}
          </div>
        </div>
      </div>

      <div className="text-center text-[10px] font-bold tracking-[0.4em] pt-1">CLASSIFIED</div>
    </div>
  );
}

function Th({
  children,
  colSpan,
  rowSpan,
  w,
}: {
  children: React.ReactNode;
  colSpan?: number;
  rowSpan?: number;
  w?: string;
}) {
  return (
    <th
      colSpan={colSpan}
      rowSpan={rowSpan}
      style={w ? { width: w } : undefined}
      className="border border-black font-semibold text-[10px] px-1 py-0.5"
    >
      {children}
    </th>
  );
}

function CellInput({
  value,
  onChange,
  mono,
  readOnly,
}: {
  value: string;
  onChange: (v: string) => void;
  mono?: boolean;
  readOnly?: boolean;
}) {
  if (readOnly) {
    return (
      <td className={`border border-black px-1 py-0.5 text-[10px] ${mono ? "font-mono" : ""} text-center`}>
        {value || "\u00A0"}
      </td>
    );
  }
  return (
    <td className="border border-black p-0">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full bg-transparent outline-none px-1 py-0.5 text-[10px] ${mono ? "font-mono" : ""} text-center`}
      />
    </td>
  );
}

function RowInputs({
  index,
  row,
  readOnly,
  onChange,
  onRemove,
}: {
  index: number;
  row: ScheduleProgramRow;
  readOnly: boolean;
  onChange: (patch: Partial<ScheduleProgramRow>) => void;
  onRemove?: () => void;
}) {
  const pilotInputCls = "w-full bg-transparent outline-none px-1 py-0.5 text-[10px] font-bold";
  return (
    <tr className="group">
      <td className="border border-black text-center font-semibold bg-gray-50 relative">
        {index}
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            title="Delete row"
            className="no-print absolute -top-1 -right-1 h-4 w-4 rounded-full bg-red-500 text-white opacity-0 group-hover:opacity-100 flex items-center justify-center"
            data-testid={`button-remove-row-${index}`}
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </td>
      <CellInput value={row.dn}             readOnly={readOnly} onChange={(v) => onChange({ dn: v })} mono />
      <CellInput value={row.acType}         readOnly={readOnly} onChange={(v) => onChange({ acType: v })} />
      {readOnly ? (
        <td className="border border-black px-1 py-0.5 text-[10px] font-bold text-center">{row.pilot || "\u00A0"}</td>
      ) : (
        <td className="border border-black p-0">
          <input list="fp-pilots" value={row.pilot} onChange={(e) => onChange({ pilot: e.target.value })} className={pilotInputCls} />
        </td>
      )}
      {readOnly ? (
        <td className="border border-black px-1 py-0.5 text-[10px] font-bold text-center">{row.coPilot || "\u00A0"}</td>
      ) : (
        <td className="border border-black p-0">
          <input list="fp-pilots" value={row.coPilot} onChange={(e) => onChange({ coPilot: e.target.value })} className={pilotInputCls} />
        </td>
      )}
      <CellInput value={row.configuration}  readOnly={readOnly} onChange={(v) => onChange({ configuration: v })} />
      <CellInput value={row.route ?? ""}    readOnly={readOnly} onChange={(v) => onChange({ route: v })} />
      <CellInput value={row.toTime}         readOnly={readOnly} onChange={(v) => onChange({ toTime: v })} mono />
      <CellInput value={row.msnDuty}        readOnly={readOnly} onChange={(v) => onChange({ msnDuty: v })} />
      <CellInput value={row.duration}       readOnly={readOnly} onChange={(v) => onChange({ duration: v })} mono />
      <CellInput value={row.fuel}           readOnly={readOnly} onChange={(v) => onChange({ fuel: v })} mono />
      <CellInput value={row.remarks}        readOnly={readOnly} onChange={(v) => onChange({ remarks: v })} />
      <CellInput value={row.atcTakeoff}     readOnly={readOnly} onChange={(v) => onChange({ atcTakeoff: v })} mono />
      <CellInput value={row.atcLanding}     readOnly={readOnly} onChange={(v) => onChange({ atcLanding: v })} mono />
    </tr>
  );
}
