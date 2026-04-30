import { useState } from "react";
import { Card, PageHead } from "@/components/Layout";
import { useI18n } from "@/lib/i18n";
import { useAuth } from "@/lib/auth";
import {
  useNotams,
  useCreateNotam,
  useUpdateNotam,
  useDeleteNotam,
  type NotamRow,
  type ItemPriority,
} from "@/lib/squadron-data";
import { useToast } from "@/hooks/use-toast";
import { Plus, Megaphone, Pencil, Trash2, Check, X } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DataUnavailableBanner } from "@/components/DataUnavailableBanner";

// Only the squadron Ops Pilot owns NOTAM publishing. Squadron / Flight /
// Wing / Base commanders see the same list as a read-only feed (broadcast
// from the Ops Pilot PC into their dashboards via Supabase + RLS), so they
// know what restrictions the squadron has issued without being able to
// edit or withdraw them.
const WRITE_ROLES = new Set(["ops", "super_admin"]);

const PRIORITIES: { value: ItemPriority; label: string }[] = [
  { value: "normal",  label: "Normal" },
  { value: "medium",  label: "High" },
  { value: "urgent",  label: "Very High" },
];

const PRIORITY_BADGE: Record<ItemPriority, string> = {
  normal: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  medium: "bg-amber-400/20 text-amber-100 border-amber-400/40",
  urgent: "bg-rose-500/20 text-rose-100 border-rose-400/40",
};
const PRIORITY_BORDER: Record<ItemPriority, string> = {
  normal: "border-l-emerald-500/60",
  medium: "border-l-amber-400",
  urgent: "border-l-rose-400",
};
const PRIORITY_BTN_ACTIVE: Record<ItemPriority, string> = {
  normal: "bg-emerald-500/20 border-emerald-500/60 text-emerald-200",
  medium: "bg-amber-400/20 border-amber-400/60 text-amber-100",
  urgent: "bg-rose-500/20 border-rose-400/60 text-rose-100",
};
function priorityLabel(p: ItemPriority): string {
  return PRIORITIES.find(x => x.value === p)?.label ?? p;
}

export default function NotamsPage() {
  const { t } = useI18n();
  const { toast } = useToast();
  const { user } = useAuth();
  const canWrite = WRITE_ROLES.has(user?.role ?? "");
  const notamsQ = useNotams();
  const { data: list } = notamsQ;
  const create = useCreateNotam();
  const update = useUpdateNotam();
  const remove = useDeleteNotam();
  const [text, setText] = useState("");
  const [priority, setPriority] = useState<ItemPriority>("normal");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [editPriority, setEditPriority] = useState<ItemPriority>("normal");
  const [confirmDelete, setConfirmDelete] = useState<NotamRow | null>(null);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    try {
      await create.mutateAsync({ text, priority });
      setText("");
      setPriority("normal");
      toast({ title: t("notamPublished") });
    } catch (e) {
      toast({ title: "Could not publish NOTAM", description: (e as Error).message, variant: "destructive" });
    }
  };

  const startEdit = (n: NotamRow) => {
    setEditingId(n.id);
    setEditText(n.text);
    setEditPriority(n.priority ?? "normal");
  };

  const saveEdit = async (n: NotamRow) => {
    try {
      await update.mutateAsync({ ...n, text: editText, priority: editPriority });
      setEditingId(null);
      toast({ title: t("savedTitle") });
    } catch (e) {
      toast({ title: "Could not save NOTAM", description: (e as Error).message, variant: "destructive" });
    }
  };

  const onWithdraw = async () => {
    if (!confirmDelete) return;
    try {
      await remove.mutateAsync(confirmDelete);
      setConfirmDelete(null);
      toast({ title: t("notamWithdrawn") });
    } catch (e) {
      toast({ title: "Could not withdraw NOTAM", description: (e as Error).message, variant: "destructive" });
    }
  };

  return (
    <div>
      <PageHead
        title={t("nav_notams")}
        subtitle={canWrite ? "Navigation notices by date — pick a priority (green = info, yellow = attention, red = critical)" : "Read-only feed published by squadron operations"}
      />
      <DataUnavailableBanner queries={[notamsQ]} testId="banner-notams-unavailable" />
      <div className={canWrite ? "grid lg:grid-cols-3 gap-4" : "space-y-2"}>
        <div className={canWrite ? "lg:col-span-2 space-y-2" : "space-y-2"}>
          {list.length === 0 && (
            <Card data-testid="empty-notams" className="text-center text-xs text-muted-foreground py-6">
              {notamsQ.isError ? "—" : t("no_records")}
            </Card>
          )}
          {list.map(n => {
            const pri: ItemPriority = n.priority ?? "normal";
            return (
              <Card key={n.id} className={`flex gap-3 items-start border-l-4 ${PRIORITY_BORDER[pri]}`}>
                <Megaphone className={`h-4 w-4 shrink-0 mt-0.5 ${
                  pri === "urgent" ? "text-rose-400"
                  : pri === "medium" ? "text-amber-400"
                  : "text-emerald-400"
                }`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="text-[11px] text-muted-foreground font-mono">{n.id} · {n.date}</div>
                    <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${PRIORITY_BADGE[pri]}`} data-testid={`notam-priority-${n.id}`}>
                      {priorityLabel(pri)}
                    </span>
                  </div>
                  {editingId === n.id ? (
                    <div className="space-y-2 mt-1">
                      <textarea
                        rows={3}
                        value={editText}
                        onChange={e => setEditText(e.target.value)}
                        data-testid={`input-edit-notam-${n.id}`}
                        className="w-full px-2 py-1.5 rounded-md bg-input border border-border text-sm"
                      />
                      <div className="flex gap-1.5">
                        {PRIORITIES.map(p => (
                          <button
                            key={p.value}
                            type="button"
                            onClick={() => setEditPriority(p.value)}
                            className={`flex-1 px-2 py-1 rounded text-[11px] font-semibold border ${
                              editPriority === p.value
                                ? PRIORITY_BTN_ACTIVE[p.value]
                                : "bg-secondary border-border text-muted-foreground"
                            }`}
                            data-testid={`edit-notam-priority-${n.id}-${p.value}`}
                          >{p.label}</button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="text-sm whitespace-pre-wrap" dir="auto">{n.text}</div>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {!canWrite ? null : editingId === n.id ? (
                    <>
                      <button onClick={() => saveEdit(n)} disabled={update.isPending} className="p-1.5 rounded hover:bg-emerald-500/20 text-emerald-400" title="Save" data-testid={`button-save-notam-${n.id}`}>
                        <Check className="h-3.5 w-3.5" />
                      </button>
                      <button onClick={() => setEditingId(null)} className="p-1.5 rounded hover:bg-secondary" title="Cancel" data-testid={`button-cancel-edit-${n.id}`}>
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => startEdit(n)} className="p-1.5 rounded hover:bg-secondary" title={t("edit")} data-testid={`button-edit-notam-${n.id}`}>
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button onClick={() => setConfirmDelete(n)} className="p-1.5 rounded hover:bg-destructive/20 text-destructive" title="Withdraw" data-testid={`button-withdraw-notam-${n.id}`}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
        {canWrite && (
          <Card>
            <form onSubmit={add} className="space-y-3">
              <div className="text-sm font-semibold">New NOTAM</div>
              <textarea rows={5} value={text} onChange={e=>setText(e.target.value)} placeholder="Enter NOTAM text…"
                data-testid="input-new-notam"
                dir="auto"
                className="w-full px-3 py-2 rounded-md bg-input border border-border text-sm" />
              <div>
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">Priority</div>
                <div className="flex gap-1.5">
                  {PRIORITIES.map(p => (
                    <button
                      key={p.value}
                      type="button"
                      onClick={() => setPriority(p.value)}
                      className={`flex-1 px-2 py-1.5 rounded-md text-xs font-semibold border ${
                        priority === p.value
                          ? PRIORITY_BTN_ACTIVE[p.value]
                          : "bg-secondary border-border text-muted-foreground"
                      }`}
                      data-testid={`new-notam-priority-${p.value}`}
                    >{p.label}</button>
                  ))}
                </div>
              </div>
              <button data-testid="button-publish-notam" disabled={create.isPending} className="w-full py-2 rounded-md bg-primary text-primary-foreground font-medium inline-flex items-center justify-center gap-1.5 disabled:opacity-50"><Plus className="h-4 w-4" /> Publish</button>
            </form>
          </Card>
        )}
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title={`Withdraw ${confirmDelete.id}?`}
          message={`This NOTAM will be permanently withdrawn:\n\n"${confirmDelete.text}"`}
          confirmLabel="Withdraw"
          onCancel={() => setConfirmDelete(null)}
          onConfirm={onWithdraw}
          busy={remove.isPending}
          danger
        />
      )}
    </div>
  );
}
