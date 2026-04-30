// Short-lived session token for the manage-reminder-schedule edge function.
// Stored in sessionStorage so it survives a page navigation between the
// schedule and log views but disappears when the tab closes. Auto-discarded
// once the server-issued expiry passes.

const KEY = "rjaf.remindersSession";

export interface ReminderSession {
  token: string;
  expiresAt: number;
}

export function loadReminderSession(): ReminderSession | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ReminderSession;
    if (!parsed.token || !parsed.expiresAt || parsed.expiresAt < Date.now() + 5_000) {
      sessionStorage.removeItem(KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveReminderSession(s: ReminderSession): void {
  sessionStorage.setItem(KEY, JSON.stringify(s));
}

export function clearReminderSession(): void {
  sessionStorage.removeItem(KEY);
}
