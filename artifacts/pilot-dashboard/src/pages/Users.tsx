import { useState } from "react";
import { Card, PageHead } from "@/components/Layout";
import { useI18n } from "@/lib/i18n";
import { useSquadronUsers, useCreateSquadronUser } from "@/lib/squadron-data";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2, KeyRound } from "lucide-react";

export default function Users() {
  const { t } = useI18n();
  const { toast } = useToast();
  const { data: list } = useSquadronUsers();
  const create = useCreateSquadronUser();
  const [u, setU] = useState("");
  const [pw, setPw] = useState("");
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!u) return;
    try {
      await create.mutateAsync({ username: u, password: pw || `Tmp-${Date.now()}` });
      setU(""); setPw("");
      toast({ title: t("userCreated") });
    } catch (e) {
      toast({ title: "Could not create user", description: (e as Error).message, variant: "destructive" });
    }
  };
  return (
    <div>
      <PageHead title={t("nav_users")} subtitle="Add deputy ops officers · manage passwords" />
      <div className="grid lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2 !p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-secondary/50 text-xs uppercase tracking-wider text-muted-foreground">
              <tr><th className="px-3 py-2 text-left">Username</th><th className="px-3 py-2 text-left">Role</th><th className="px-3 py-2 text-left">Created</th><th className="px-3 py-2 text-right">Actions</th></tr>
            </thead>
            <tbody>
              {list.map(u => (
                <tr key={u.id} className="border-t border-border row-hover">
                  <td className="px-3 py-2 font-mono">{u.username}</td>
                  <td className="px-3 py-2"><span className="text-[11px] px-2 py-0.5 rounded-full bg-secondary border border-border uppercase">{u.role}</span></td>
                  <td className="px-3 py-2 font-mono">{u.created}</td>
                  <td className="px-3 py-2 text-right">
                    <button className="p-1.5 rounded hover:bg-secondary" title="Reset password"><KeyRound className="h-3.5 w-3.5" /></button>
                    <button className="p-1.5 rounded hover:bg-destructive/20 text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card>
          <form onSubmit={add} className="space-y-3">
            <div className="text-sm font-semibold">Add Deputy</div>
            <label className="block text-xs"><span className="text-muted-foreground">Username</span>
              <input value={u} onChange={e=>setU(e.target.value)} className="w-full mt-1 px-3 py-2 rounded-md bg-input border border-border text-sm" />
            </label>
            <label className="block text-xs"><span className="text-muted-foreground">Temporary password (min 8 chars)</span>
              <input type="password" value={pw} onChange={e=>setPw(e.target.value)} placeholder="Auto-generated if blank" className="w-full mt-1 px-3 py-2 rounded-md bg-input border border-border text-sm" />
            </label>
            <button disabled={create.isPending} className="w-full py-2 rounded-md bg-primary text-primary-foreground font-medium inline-flex items-center justify-center gap-1.5 disabled:opacity-50"><Plus className="h-4 w-4" /> Create user</button>
          </form>
        </Card>
      </div>
    </div>
  );
}
