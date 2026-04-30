import { useEffect, useState } from "react";
import CalendarPickerInput from "@/components/CalendarPickerInput";
import { Card, PageHead } from "@/components/Layout";
import { useI18n } from "@/lib/i18n";
import { usePilots, useUnavailable, useCreateUnavailable, useDeleteUnavailable, type UnavailEntry } from "@/lib/squadron-data";
import { useToast } from "@/hooks/use-toast";
import { Plus, UserX, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DataUnavailableBanner } from "@/components/DataUnavailableBanner";

export default function Unavailable() {
  const { t, rankOf } = useI18n();
  const { toast } = useToast();
  const pilotsQ = usePilots();
  const unavailQ = useUnavailable();
  const { data: PILOTS } = pilotsQ;
  const { data: items } = unavailQ;
  const create = useCreateUnavailable();
  const remove = useDeleteUnavailable();
  const [pid, setPid] = useState(PILOTS[0]?.id ?? "");
  useEffect(() => { if (!pid && PILOTS[0]) setPid(PILOTS[0].id); }, [PILOTS, pid]);
  const [from, setFrom] = useState(new Date().toISOString().slice(0,10));
  const [to, setTo] = useState(new Date(Date.now()+7*86400000).toISOString().slice(0,10));
  const [reason, setReason] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<UnavailEntry | null>(null);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await create.mutateAsync({ pilotId: pid, from, to, reason: reason || "—" });
      setReason("");
      toast({ title: t("unavailAdded") });
    } catch (e) {
      toast({ title: "Could not mark unavailable", description: (e as Error).message, variant: "destructive" });
    }
  };

  const onRemove = async () => {
    if (!confirmRemove) return;
    try {
      await remove.mutateAsync(confirmRemove.id);
      setConfirmRemove(null);
      toast({ title: t("unavailRemoved") });
    } catch (e) {
      toast({ title: "Could not remove", description: (e as Error).message, variant: "destructive" });
    }
  };

  const pname = (id: string) => PILOTS.find(p => p.id === id)?.name || id;

  return (
    <div>
      <PageHead title={t("nav_unavail")} subtitle="Date range + reason per pilot" />
      <DataUnavailableBanner queries={[pilotsQ, unavailQ]} testId="banner-unavail-unavailable" />
      <div className="grid lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2 !p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-secondary/50 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left">Pilot</th>
                <th className="px-3 py-2 text-left">From</th>
                <th className="px-3 py-2 text-left">To</th>
                <th className="px-3 py-2 text-left">Reason</th>
                <th className="px-3 py-2 text-right">{t("actions")}</th>
              </tr>
            </thead>
            <tbody>
              {items.map(i => (
                <tr key={i.id} className="border-t border-border row-hover">
                  <td className="px-3 py-2"><UserX className="inline h-3.5 w-3.5 mr-1 text-amber-400" />{pname(i.pilotId)}</td>
                  <td className="px-3 py-2 font-mono">{i.from}</td>
                  <td className="px-3 py-2 font-mono">{i.to}</td>
                  <td className="px-3 py-2 text-muted-foreground">{i.reason}</td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => setConfirmRemove(i)} className="p-1.5 rounded hover:bg-destructive/20 text-destructive" title="Remove" data-testid={`button-remove-${i.id}`}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-xs text-muted-foreground" data-testid="empty-unavailable">
                    {unavailQ.isError ? "—" : "No pilots marked unavailable."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
        <Card>
          <form onSubmit={add} className="space-y-3">
            <div className="text-sm font-semibold">Mark Unavailable</div>
            <label className="block text-xs"><span className="text-muted-foreground">Pilot</span>
              <select value={pid} onChange={e=>setPid(e.target.value)} className="w-full mt-1 px-3 py-2 rounded-md bg-input border border-border text-sm">
                {PILOTS.map(p => <option key={p.id} value={p.id}>{rankOf(p)} {p.name}</option>)}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs"><span className="text-muted-foreground">From</span><CalendarPickerInput value={from} onChange={setFrom} className="w-full mt-1 px-3 py-2 rounded-md bg-input border border-border text-sm font-mono" data-testid="picker-unavail-from" /></label>
              <label className="text-xs"><span className="text-muted-foreground">To</span><CalendarPickerInput value={to} onChange={setTo} className="w-full mt-1 px-3 py-2 rounded-md bg-input border border-border text-sm font-mono" data-testid="picker-unavail-to" /></label>
            </div>
            <label className="block text-xs"><span className="text-muted-foreground">Reason</span>
              <input value={reason} onChange={e=>setReason(e.target.value)} className="w-full mt-1 px-3 py-2 rounded-md bg-input border border-border text-sm" />
            </label>
            <button disabled={create.isPending} className="w-full py-2 rounded-md bg-primary text-primary-foreground font-medium inline-flex items-center justify-center gap-1.5 disabled:opacity-50"><Plus className="h-4 w-4" /> Add</button>
          </form>
        </Card>
      </div>

      {confirmRemove && (
        <ConfirmDialog
          title="Remove unavailability?"
          message={`Remove ${pname(confirmRemove.pilotId)}'s unavailability (${confirmRemove.from} → ${confirmRemove.to})?`}
          confirmLabel="Remove"
          onCancel={() => setConfirmRemove(null)}
          onConfirm={onRemove}
          busy={remove.isPending}
          danger
        />
      )}
    </div>
  );
}
