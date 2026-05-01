// Peer Squadrons admin page — only mounted on aggregator-* PCs.
//
// CRUDs the local address book (`peer_squadrons` table) via
// `/api/aggregate/peers`. Each row points at one squadron hub PC the
// Wing/Base operator wants to fan out reads to. Tokens are write-only
// — the API never returns the cleartext, so the UI shows whether a
// token is set (`has_token`) and lets the operator overwrite it.
//
// Mirrors the shape of `pages/admin/Users.tsx` for visual continuity:
// add row at the top, list below, inline edit dialog, destructive
// delete with confirmation.

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import {
  fetchAggregatePeersList,
  postAggregatePeer,
  patchAggregatePeer,
  deleteAggregatePeer,
  type PeerSquadronListRow,
} from "@/lib/internal-migration";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Plus,
  Pencil,
  Trash2,
  KeyRound,
  RefreshCw,
  Network,
} from "lucide-react";

interface CreateDraft {
  squadron_id: string;
  squadron_name: string;
  base_url: string;
  token: string;
}

const EMPTY_DRAFT: CreateDraft = {
  squadron_id: "",
  squadron_name: "",
  base_url: "",
  token: "",
};

export default function PeerSquadrons() {
  const { user } = useAuth();
  const { t } = useI18n();
  const [rows, setRows] = useState<PeerSquadronListRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState<CreateDraft>(EMPTY_DRAFT);
  const [editing, setEditing] = useState<PeerSquadronListRow | null>(null);
  const [editName, setEditName] = useState("");
  const [editBaseUrl, setEditBaseUrl] = useState("");
  const [editToken, setEditToken] = useState("");

  const isAdmin = user?.role === "super_admin";

  async function load() {
    setBusy(true);
    setError(null);
    const r = await fetchAggregatePeersList();
    if (r === null) {
      setRows([]);
      setError("unavailable");
    } else {
      setRows(r);
    }
    setBusy(false);
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleCreate() {
    if (!draft.squadron_id.trim() || !draft.base_url.trim() || !draft.token.trim()) {
      setError("missing_fields");
      return;
    }
    setBusy(true);
    const r = await postAggregatePeer({
      squadron_id: draft.squadron_id.trim(),
      squadron_name: draft.squadron_name.trim() || null,
      base_url: draft.base_url.trim(),
      token: draft.token.trim(),
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setDraft(EMPTY_DRAFT);
    setCreateOpen(false);
    await load();
  }

  async function handleSaveEdit() {
    if (!editing) return;
    const patch: { squadron_name?: string | null; base_url?: string; token?: string } = {};
    if (editName !== (editing.squadron_name ?? "")) {
      patch.squadron_name = editName.trim() || null;
    }
    if (editBaseUrl && editBaseUrl !== editing.base_url) {
      patch.base_url = editBaseUrl.trim();
    }
    if (editToken.trim()) {
      patch.token = editToken.trim();
    }
    if (Object.keys(patch).length === 0) {
      setEditing(null);
      return;
    }
    setBusy(true);
    const r = await patchAggregatePeer(editing.id, patch);
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setEditing(null);
    setEditToken("");
    await load();
  }

  async function handleDelete(row: PeerSquadronListRow) {
    if (!window.confirm(t("peerSquadronsDeleteConfirm").replace("{name}", row.squadron_name || row.squadron_id))) {
      return;
    }
    setBusy(true);
    const r = await deleteAggregatePeer(row.id);
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    await load();
  }

  if (!isAdmin) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          {t("forbiddenSuperAdminOnly")}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3" data-testid="peer-squadrons-page">
      <div className="flex items-center gap-2">
        <Network className="h-5 w-5 text-amber-300" />
        <h1 className="text-xl font-semibold flex-1">{t("peerSquadronsTitle")}</h1>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void load()}
          disabled={busy}
          data-testid="peer-squadrons-refresh"
        >
          <RefreshCw className="h-4 w-4 me-1" />
          {t("refresh")}
        </Button>
        <Button
          size="sm"
          onClick={() => {
            setDraft(EMPTY_DRAFT);
            setCreateOpen(true);
          }}
          data-testid="peer-squadrons-add"
        >
          <Plus className="h-4 w-4 me-1" />
          {t("peerSquadronsAdd")}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        {t("peerSquadronsHelp")}
      </p>

      {error && error !== "unavailable" && (
        <Card>
          <CardContent className="py-3 text-sm text-rose-300">{error}</CardContent>
        </Card>
      )}
      {error === "unavailable" && (
        <Card>
          <CardContent className="py-3 text-sm text-muted-foreground">
            {t("aggregateUnavailable")}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wider">
              <tr>
                <th className="text-start px-3 py-2">{t("peerSquadronsColSquadron")}</th>
                <th className="text-start px-3 py-2">{t("peerSquadronsColBaseUrl")}</th>
                <th className="text-start px-3 py-2">{t("peerSquadronsColToken")}</th>
                <th className="text-start px-3 py-2">{t("peerSquadronsColStatus")}</th>
                <th className="text-end px-3 py-2">{t("peerSquadronsColActions")}</th>
              </tr>
            </thead>
            <tbody>
              {rows && rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-4 text-center text-muted-foreground">
                    {t("peerSquadronsEmpty")}
                  </td>
                </tr>
              )}
              {rows?.map(row => (
                <tr
                  key={row.id}
                  className="border-t border-border"
                  data-testid={`peer-squadrons-row-${row.squadron_id}`}
                >
                  <td className="px-3 py-2">
                    <div className="font-medium">{row.squadron_name || row.squadron_id}</div>
                    <div className="text-xs text-muted-foreground">{row.squadron_id}</div>
                  </td>
                  <td className="px-3 py-2 truncate max-w-[26ch]" title={row.base_url}>
                    {row.base_url}
                  </td>
                  <td className="px-3 py-2">
                    {row.has_token ? (
                      <span className="inline-flex items-center text-emerald-300">
                        <KeyRound className="h-3 w-3 me-1" />
                        {t("peerSquadronsTokenSet")}
                      </span>
                    ) : (
                      <span className="text-rose-300">{t("peerSquadronsTokenMissing")}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex items-center gap-1 ${row.status === "online" ? "text-emerald-300" : "text-rose-300"}`}
                    >
                      <span className={`h-2 w-2 rounded-full ${row.status === "online" ? "bg-emerald-400" : "bg-rose-500"}`} />
                      {row.status === "online" ? t("squadronStatusOnline") : t("squadronStatusOffline")}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-end space-x-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setEditing(row);
                        setEditName(row.squadron_name ?? "");
                        setEditBaseUrl(row.base_url);
                        setEditToken("");
                      }}
                      data-testid={`peer-squadrons-edit-${row.squadron_id}`}
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => void handleDelete(row)}
                      data-testid={`peer-squadrons-delete-${row.squadron_id}`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("peerSquadronsAddTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="psq-id">{t("peerSquadronsFieldSquadronId")}</Label>
              <Input
                id="psq-id"
                value={draft.squadron_id}
                onChange={e => setDraft({ ...draft, squadron_id: e.target.value })}
                data-testid="peer-squadrons-input-id"
              />
            </div>
            <div>
              <Label htmlFor="psq-name">{t("peerSquadronsFieldSquadronName")}</Label>
              <Input
                id="psq-name"
                value={draft.squadron_name}
                onChange={e => setDraft({ ...draft, squadron_name: e.target.value })}
                data-testid="peer-squadrons-input-name"
              />
            </div>
            <div>
              <Label htmlFor="psq-url">{t("peerSquadronsFieldBaseUrl")}</Label>
              <Input
                id="psq-url"
                value={draft.base_url}
                placeholder="https://hub-no-8.lan"
                onChange={e => setDraft({ ...draft, base_url: e.target.value })}
                data-testid="peer-squadrons-input-url"
              />
            </div>
            <div>
              <Label htmlFor="psq-token">{t("peerSquadronsFieldToken")}</Label>
              <Input
                id="psq-token"
                type="password"
                value={draft.token}
                onChange={e => setDraft({ ...draft, token: e.target.value })}
                data-testid="peer-squadrons-input-token"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              {t("cancel")}
            </Button>
            <Button onClick={() => void handleCreate()} disabled={busy}>
              {t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editing} onOpenChange={o => (!o ? setEditing(null) : null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("peerSquadronsEditTitle").replace(
                "{name}",
                editing?.squadron_name || editing?.squadron_id || "",
              )}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="psq-edit-name">{t("peerSquadronsFieldSquadronName")}</Label>
              <Input
                id="psq-edit-name"
                value={editName}
                onChange={e => setEditName(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="psq-edit-url">{t("peerSquadronsFieldBaseUrl")}</Label>
              <Input
                id="psq-edit-url"
                value={editBaseUrl}
                onChange={e => setEditBaseUrl(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="psq-edit-token">
                {t("peerSquadronsFieldTokenReplace")}
              </Label>
              <Input
                id="psq-edit-token"
                type="password"
                value={editToken}
                placeholder={t("peerSquadronsTokenPlaceholder")}
                onChange={e => setEditToken(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              {t("cancel")}
            </Button>
            <Button onClick={() => void handleSaveEdit()} disabled={busy}>
              {t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
