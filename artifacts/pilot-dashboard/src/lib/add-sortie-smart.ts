import type { Sortie } from "@/lib/mock";

export interface AddSortieDraft {
  date: string;
  acType: string;
  acNumber: string;
  sortieType: string;
  condition: "Day" | "Night";
  nvg: boolean;
  time: number;
  dualHours: number;
  instrumentFlight: boolean;
  ifSim: number;
  ifAct: number;
}

export interface SortieSmartSignals {
  errors: string[];
  warnings: string[];
}

const norm = (s: string) => s.trim().toUpperCase();

export function analyzeSortieDraft(
  draft: AddSortieDraft,
  existingSameDay: Sortie[],
): SortieSmartSignals {
  const errors: string[] = [];
  const warnings: string[] = [];

  const totalTime = Math.max(0, Number(draft.time || 0) + Number(draft.dualHours || 0));
  const ifTotal = Math.max(0, Number(draft.ifSim || 0) + Number(draft.ifAct || 0));
  const type = norm(draft.sortieType);
  const cond = draft.nvg ? "NVG" : draft.condition.toUpperCase();

  if (draft.instrumentFlight && ifTotal - totalTime > 0.05) {
    errors.push("Instrument total (SIM + Actual) is greater than sortie time.");
  }
  if (totalTime > 8) {
    warnings.push("Very long sortie time (> 8 hrs). Confirm this is intentional.");
  }
  if (draft.dualHours > 0 && totalTime > 0 && draft.dualHours / totalTime > 0.8) {
    warnings.push("Dual hours are most of this sortie (> 80%). Double-check values.");
  }
  if (type.includes("NVG") && cond !== "NVG") {
    warnings.push("Sortie type says NVG but condition is not NVG.");
  }
  if (type.includes("NIGHT") && cond === "DAY") {
    warnings.push("Sortie type says NIGHT but condition is Day.");
  }
  if (type.includes("DAY") && cond !== "DAY") {
    warnings.push("Sortie type says DAY but condition is Night/NVG.");
  }

  const ac = draft.acNumber.trim();
  if (ac && draft.acType.trim()) {
    const sameAcEntries = existingSameDay.filter(s =>
      (s.acType || "").trim().toUpperCase() === draft.acType.trim().toUpperCase() &&
      (s.acNumber || "").trim().toUpperCase() === ac.toUpperCase(),
    );
    if (sameAcEntries.length >= 4) {
      warnings.push(`This aircraft already has ${sameAcEntries.length} sorties on this date.`);
    }
    const nearSame = sameAcEntries.find((s) => {
      const sType = norm(s.sortieType || "");
      const sCond = String(s.condition || "").trim().toUpperCase();
      const sTime = Number(s.time ?? s.actual ?? 0);
      return (
        sType === type &&
        sCond === cond &&
        Number.isFinite(sTime) &&
        Math.abs(sTime - totalTime) <= 0.05
      );
    });
    if (nearSame) {
      warnings.push(
        "Possible duplicate sortie for this aircraft/date (same type, condition, and time).",
      );
    }
  }

  return { errors, warnings };
}
