import { Layers } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import { useDashSquadrons } from "@/lib/dash-pilots";
import { SCOPE_ALL, useSquadronScope } from "@/lib/squadron-scope";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Topbar squadron switcher for HQ commanders, multi-squadron sqn-cmdrs,
// wing and base commanders. Only renders when the operator is authorized
// for >1 squadron — single-squadron seats see no extra control.
//
// The picker mutates a per-PC localStorage value (rjaf.dashboard.squadronScope)
// that Overview / Pilots / Currencies / Alerts read via useSquadronScope.
// Picking "Combined view" restores the historic union behaviour.
export function SquadronScopePicker() {
  const { t, lang } = useI18n();
  const { user } = useAuth();
  const squadrons = useDashSquadrons();
  const [scope, setScope] = useSquadronScope();

  const authorizedIds = user?.squadronIds ?? [];
  if (authorizedIds.length <= 1) return null;

  const mySqns = squadrons.filter(s => authorizedIds.includes(s.id));
  // Snap a stale persisted scope back to "Combined" so the dropdown
  // doesn't render a placeholder for a squadron the user no longer has.
  const value = scope !== SCOPE_ALL && authorizedIds.includes(scope) ? scope : SCOPE_ALL;

  return (
    <div
      className="hidden md:flex items-center gap-1.5"
      title={t("squadronScope")}
      data-testid="squadron-scope-picker"
    >
      <Layers className="h-4 w-4 text-muted-foreground" aria-hidden />
      <Select value={value} onValueChange={setScope}>
        <SelectTrigger
          className="h-8 w-44 text-xs"
          data-testid="select-squadron-scope"
          aria-label={t("squadronScope")}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={SCOPE_ALL} data-testid="opt-scope-combined">
            {t("combinedView")}
          </SelectItem>
          {mySqns.map(s => (
            <SelectItem key={s.id} value={s.id} data-testid={`opt-scope-${s.id}`}>
              {lang === "ar" ? s.nameAr : s.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
