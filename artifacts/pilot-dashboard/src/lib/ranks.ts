// RJAF rank lookup table — Arabic ↔ English.
//
// The Arabic rank is the canonical value the operator picks from the
// Add Pilot form. The English value is auto-filled via this lookup so
// every English UI surface (Roster table, Duty Week, Schedule, Sortie
// list, Messaging, prints) renders a proper English rank instead of
// echoing the Arabic string. The operator can override the auto-filled
// English value manually on the Add/Edit Pilot form.

// Avoid importing Lang from ./i18n — i18n imports from this module to
// expose the rank helper on the I18n context, so depending on i18n here
// would create a circular import. The Lang shape is just "en" | "ar".
type Lang = "en" | "ar";

export interface RankOption {
  ar: string;
  en: string;
}

// Complete RJAF aircrew (طيار) rank ladder — officer ranks from
// 2nd Lieutenant up through Lt General. The Arabic values match the
// existing `RANK_OPTIONS` list used by Duty Week so picking any duty
// roster rank also produces a clean English label.
export const RJAF_RANKS: RankOption[] = [
  { ar: "ملازم طيار",          en: "2nd Lt" },
  { ar: "ملازم/١ طيار",         en: "1st Lt" },
  { ar: "ملازم أول طيار",       en: "1st Lt" },
  { ar: "نقيب طيار",            en: "Capt" },
  { ar: "رائد طيار",            en: "Maj" },
  { ar: "مقدم طيار",            en: "Lt Col" },
  { ar: "مقدم الركن طيار",      en: "Lt Col (GS)" },
  { ar: "المقدم الركن الطيار",  en: "Lt Col (GS)" },
  { ar: "عقيد طيار",            en: "Col" },
  { ar: "عقيد الركن طيار",      en: "Col (GS)" },
  { ar: "العقيد الركن الطيار",  en: "Col (GS)" },
  { ar: "عميد طيار",            en: "Brig Gen" },
  { ar: "لواء طيار",            en: "Maj Gen" },
  { ar: "فريق طيار",            en: "Lt Gen" },
];

// Lookup index keyed on a normalised version of the Arabic rank so
// minor whitespace / punctuation drift between data sources still
// resolves to the right English value. Returns "" when the Arabic
// rank is unrecognised — the caller (form, backfill) should leave
// the English value blank in that case so the operator can fill it
// in manually instead of being shown a wrong auto-fill.
const arNorm = (s: string): string => s.replace(/\s+/g, " ").trim();
const RANK_INDEX = new Map<string, string>();
for (const r of RJAF_RANKS) RANK_INDEX.set(arNorm(r.ar), r.en);

export function lookupRankEn(arabicRank: string | null | undefined): string {
  if (!arabicRank) return "";
  return RANK_INDEX.get(arNorm(arabicRank)) ?? "";
}

// Render the rank for the current UI language. English UI uses the
// stored `rankEn`; falls back to the Arabic→English lookup so older
// pilots without an explicit English rank still render sensibly.
// Arabic UI always uses the canonical Arabic rank.
export function pilotRank(
  p: { rank: string; rankEn?: string | null },
  lang: Lang,
): string {
  if (lang === "ar") return p.rank ?? "";
  if (p.rankEn && p.rankEn.trim()) return p.rankEn.trim();
  const looked = lookupRankEn(p.rank);
  return looked || (p.rank ?? "");
}
