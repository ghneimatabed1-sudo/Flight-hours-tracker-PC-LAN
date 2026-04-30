// Shared predicate for "the central database is missing the schema this
// query expects" errors. Triggered when:
//   • PGRST205 / 42P01 — table does not exist
//   • PGRST204 / 42703 — column does not exist
//   • PGRST202        — function does not exist
// In every one of these cases a redeploy or migration on the central
// Supabase project will resolve the issue. Until then the dashboard
// should fall back to local/mock data silently rather than spamming
// "Couldn't reach the server" toasts every poll interval.
export function isMissingSchemaError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { code?: string; message?: string };
  const code = e.code;
  if (
    code === "PGRST205"
    || code === "PGRST204"
    || code === "PGRST202"
    || code === "42P01"
    || code === "42703"
  ) return true;
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /PGRST20[245]|42P01|42703|Could not find the (table|column|function)|does not exist/i.test(msg);
}
