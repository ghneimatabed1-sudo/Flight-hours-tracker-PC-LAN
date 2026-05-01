// Users — super-admin user-management page.
//
// Replaces hand-edited SQL and the host-side `reset-admin-password.ps1`
// helper for everyday operator account work. Wraps the LAN api-server
// endpoints (GET/POST/PATCH/DELETE /api/internal/users) exposed by
// routes/lan-users.ts. Rendered inside HQLayout under
// `/admin/users` and gated client-side to super_admin (the API also
// gates server-side via `canManageUsers`).
//
// Operators can:
//   * create users (deputy / ops / commander_squadron / commander_wing /
//     commander_base — super_admin is intentionally not creatable here)
//   * change role
//   * assign squadron / wing / base scope (wing_id / base_id auto-fill
//     from the chosen squadron when available)
//   * reset password
//   * disable / re-enable accounts (the LAN session middleware refuses
//     to mint or honour sessions for disabled rows)
//   * delete accounts
//
// Runbook §"Reset password / add user" points operators here instead of
// at the PowerShell helper.

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import {
  fetchInternalLanUsers,
  fetchInternalSquadronsList,
  postInternalLanUserCreate,
  patchInternalLanUser,
  deleteInternalLanUser,
  type InternalLanUserRow,
  type InternalSquadronListRow,
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
import { Users as UsersIcon, Plus, KeyRound, Pencil, Trash2, ShieldCheck, ShieldAlert, RefreshCw } from "lucide-react";

type AssignableRole =
  | "deputy"
  | "ops"
  | "commander_squadron"
  | "commander_wing"
  | "commander_base";

const ASSIGNABLE_ROLES: AssignableRole[] = [
  "deputy",
  "ops",
  "commander_squadron",
  "commander_wing",
  "commander_base",
];

const SCOPED_ROLES = new Set<AssignableRole>([
  "ops",
  "commander_squadron",
  "commander_wing",
  "commander_base",
]);

function isAssignableRole(v: string): v is AssignableRole {
  return (ASSIGNABLE_ROLES as string[]).includes(v);
}

type CreateDraft = {
  username: string;
  display_name: string;
  password: string;
  role: AssignableRole;
  squadron_id: string;
};

const EMPTY_CREATE: CreateDraft = {
  username: "",
  display_name: "",
  password: "",
  role: "ops",
  squadron_id: "",
};

type EditDraft = {
  role: AssignableRole | "super_admin" | "admin";
  squadron_id: string;
  newPassword: string;
};

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return String(iso);
  }
}

function squadronLabel(s: InternalSquadronListRow | undefined): string {
  if (!s) return "";
  const num = s.number ? `№${s.number}` : "";
  const name = s.name ?? "";
  return [num, name].filter(Boolean).join(" · ");
}

export default function AdminUsers() {
  const { user } = useAuth();
  const { t } = useI18n();
  const isSuperAdmin = user?.role === "super_admin";

  const [users, setUsers] = useState<InternalLanUserRow[]>([]);
  const [squadrons, setSquadrons] = useState<InternalSquadronListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState<CreateDraft>(EMPTY_CREATE);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);

  const [editTarget, setEditTarget] = useState<InternalLanUserRow | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [editErr, setEditErr] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<InternalLanUserRow | null>(null);

  const reload = async () => {
    setLoading(true);
    setError(null);
    const [u, s] = await Promise.all([
      fetchInternalLanUsers(),
      fetchInternalSquadronsList(),
    ]);
    if (u === null) {
      setError("Could not load users from the LAN api-server.");
      setUsers([]);
    } else {
      setUsers(u);
    }
    setSquadrons(s ?? []);
    setLoading(false);
  };

  useEffect(() => {
    void reload();
  }, []);

  const squadronById = useMemo(() => {
    const m = new Map<string, InternalSquadronListRow>();
    for (const s of squadrons) m.set(s.id, s);
    return m;
  }, [squadrons]);

  if (!isSuperAdmin) {
    return (
      <div className="space-y-4 max-w-3xl" data-testid="page-users-forbidden">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <UsersIcon className="h-5 w-5" />
            {t("usersTitle")}
          </h1>
        </header>
        <Card>
          <CardContent className="p-4 text-sm text-zinc-300">
            {t("usersSuperAdminOnly")}
          </CardContent>
        </Card>
      </div>
    );
  }

  function openCreate() {
    setCreateDraft(EMPTY_CREATE);
    setCreateErr(null);
    setCreateOpen(true);
  }

  async function submitCreate() {
    setCreateErr(null);
    const username = createDraft.username.trim().toLowerCase();
    if (username.length < 3) {
      setCreateErr("Username must be at least 3 characters.");
      return;
    }
    if (createDraft.password.length < 8) {
      setCreateErr("Password must be at least 8 characters.");
      return;
    }
    if (SCOPED_ROLES.has(createDraft.role) && !createDraft.squadron_id) {
      setCreateErr("Pick a squadron for this role.");
      return;
    }
    setCreateBusy(true);
    const sq = createDraft.squadron_id
      ? squadronById.get(createDraft.squadron_id)
      : undefined;
    const res = await postInternalLanUserCreate({
      username,
      password: createDraft.password,
      role: createDraft.role,
      display_name: createDraft.display_name.trim() || username,
      squadron_id: createDraft.squadron_id || null,
      wing_id: sq?.wing_id ?? null,
      base_id: sq?.base_id ?? null,
    });
    setCreateBusy(false);
    if (!res.ok) {
      setCreateErr(`Could not create user: ${res.error}`);
      return;
    }
    setCreateOpen(false);
    await reload();
  }

  function openEdit(row: InternalLanUserRow) {
    setEditTarget(row);
    const role: EditDraft["role"] = isAssignableRole(row.role)
      ? (row.role as AssignableRole)
      : row.role === "super_admin" || row.role === "admin"
        ? row.role
        : "ops";
    setEditDraft({
      role,
      squadron_id: row.squadron_id ?? "",
      newPassword: "",
    });
    setEditErr(null);
  }

  async function submitEdit() {
    if (!editTarget || !editDraft) return;
    setEditErr(null);
    const patch: Parameters<typeof patchInternalLanUser>[1] = {};
    // Only super_admin / admin / unscoped existing roles aren't editable via
    // the role dropdown — for ASSIGNABLE roles, send the chosen value.
    if (
      isAssignableRole(editDraft.role)
      && editDraft.role !== editTarget.role
    ) {
      patch.role = editDraft.role;
    }
    const newSqId = editDraft.squadron_id || null;
    if (newSqId !== (editTarget.squadron_id ?? null)) {
      patch.squadron_id = newSqId;
      const sq = newSqId ? squadronById.get(newSqId) : undefined;
      patch.wing_id = sq?.wing_id ?? null;
      patch.base_id = sq?.base_id ?? null;
    }
    if (editDraft.newPassword) {
      if (editDraft.newPassword.length < 8) {
        setEditErr("Password must be at least 8 characters.");
        return;
      }
      patch.password = editDraft.newPassword;
    }
    if (Object.keys(patch).length === 0) {
      setEditErr("Nothing changed.");
      return;
    }
    setEditBusy(true);
    const res = await patchInternalLanUser(editTarget.id, patch);
    setEditBusy(false);
    if (!res.ok) {
      setEditErr(`Could not save changes: ${res.error}`);
      return;
    }
    setEditTarget(null);
    setEditDraft(null);
    await reload();
  }

  async function toggleDisabled(row: InternalLanUserRow) {
    setBusyId(row.id);
    const res = await patchInternalLanUser(row.id, { disabled: !row.disabled_at });
    setBusyId(null);
    if (!res.ok) {
      setError(`Could not update ${row.username}: ${res.error}`);
      return;
    }
    await reload();
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setBusyId(deleteTarget.id);
    const res = await deleteInternalLanUser(deleteTarget.id);
    setBusyId(null);
    if (!res.ok) {
      setError(`Could not delete ${deleteTarget.username}: ${res.error}`);
      setDeleteTarget(null);
      return;
    }
    setDeleteTarget(null);
    await reload();
  }

  const createNeedsSquadron = SCOPED_ROLES.has(createDraft.role);
  const editIsAssignable = editDraft ? isAssignableRole(editDraft.role) : false;

  return (
    <div className="space-y-6 max-w-5xl" data-testid="page-users">
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <UsersIcon className="h-5 w-5" />
            {t("usersTitle")}
          </h1>
          <p className="text-sm text-zinc-400">{t("usersIntro")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void reload()}
            data-testid="button-reload-users"
          >
            <RefreshCw className="h-3.5 w-3.5 me-1" />
            {t("refresh")}
          </Button>
          <Button onClick={openCreate} size="sm" data-testid="button-add-user">
            <Plus className="h-3.5 w-3.5 me-1" />
            {t("addUser")}
          </Button>
        </div>
      </header>

      {error && (
        <div
          className="rounded border border-red-700/40 bg-red-900/20 p-3 text-sm text-red-200"
          data-testid="users-error"
        >
          {error}
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-6 text-sm text-zinc-400">{t("loading")}</div>
          ) : users.length === 0 ? (
            <div className="p-6 text-sm text-zinc-400" data-testid="users-empty">
              {t("usersNone")}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-start text-xs text-zinc-400">
                  <tr className="border-b border-border">
                    <th className="text-start px-3 py-2">{t("usersColUsername")}</th>
                    <th className="text-start px-3 py-2">{t("usersColRole")}</th>
                    <th className="text-start px-3 py-2">{t("usersColScope")}</th>
                    <th className="text-start px-3 py-2">{t("usersColStatus")}</th>
                    <th className="text-start px-3 py-2">{t("usersColCreated")}</th>
                    <th className="text-end px-3 py-2">{t("usersColActions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => {
                    const sq = u.squadron_id ? squadronById.get(u.squadron_id) : undefined;
                    const disabled = !!u.disabled_at;
                    return (
                      <tr
                        key={u.id}
                        className={
                          "border-b border-border/60 "
                          + (disabled ? "opacity-60" : "")
                        }
                        data-testid={`row-user-${u.id}`}
                      >
                        <td className="px-3 py-2 font-medium">
                          <div>{u.username}</div>
                          {u.display_name && u.display_name !== u.username && (
                            <div className="text-xs text-zinc-500">
                              {u.display_name}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">{u.role}</td>
                        <td className="px-3 py-2 text-xs">
                          {sq ? squadronLabel(sq) : u.squadron_id ?? "—"}
                          {sq?.wing && (
                            <div className="text-zinc-500">
                              {t("wing")}: {sq.wing}
                            </div>
                          )}
                          {sq?.base && (
                            <div className="text-zinc-500">
                              {t("base")}: {sq.base}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {disabled ? (
                            <span className="inline-flex items-center gap-1 text-xs text-amber-300">
                              <ShieldAlert className="h-3.5 w-3.5" />
                              {t("usersDisabled")}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs text-emerald-300">
                              <ShieldCheck className="h-3.5 w-3.5" />
                              {t("usersActive")}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs text-zinc-400">
                          {fmtDateTime(u.created_at)}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center justify-end gap-1 flex-wrap">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => openEdit(u)}
                              data-testid={`button-edit-user-${u.id}`}
                            >
                              <Pencil className="h-3 w-3 me-1" />
                              {t("usersEdit")}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busyId === u.id}
                              onClick={() => void toggleDisabled(u)}
                              data-testid={`button-toggle-user-${u.id}`}
                            >
                              {disabled ? t("usersEnable") : t("usersDisable")}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busyId === u.id || u.id === user?.id}
                              onClick={() => setDeleteTarget(u)}
                              data-testid={`button-delete-user-${u.id}`}
                            >
                              <Trash2 className="h-3 w-3 me-1" />
                              {t("delete")}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create dialog ------------------------------------------------- */}
      <Dialog open={createOpen} onOpenChange={(v) => !v && setCreateOpen(false)}>
        <DialogContent className="max-w-md" data-testid="dialog-add-user">
          <DialogHeader>
            <DialogTitle>{t("addUser")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="create-username">{t("usersFieldUsername")}</Label>
              <Input
                id="create-username"
                value={createDraft.username}
                onChange={(e) =>
                  setCreateDraft((d) => ({ ...d, username: e.target.value }))
                }
                data-testid="input-create-username"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="create-display">{t("usersFieldDisplayName")}</Label>
              <Input
                id="create-display"
                value={createDraft.display_name}
                onChange={(e) =>
                  setCreateDraft((d) => ({ ...d, display_name: e.target.value }))
                }
                data-testid="input-create-display-name"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="create-password">{t("usersFieldPassword")}</Label>
              <Input
                id="create-password"
                type="password"
                value={createDraft.password}
                onChange={(e) =>
                  setCreateDraft((d) => ({ ...d, password: e.target.value }))
                }
                data-testid="input-create-password"
              />
              <p className="text-xs text-zinc-500">{t("usersPasswordHelp")}</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="create-role">{t("usersFieldRole")}</Label>
              <select
                id="create-role"
                className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm"
                value={createDraft.role}
                onChange={(e) =>
                  setCreateDraft((d) => ({
                    ...d,
                    role: e.target.value as AssignableRole,
                  }))
                }
                data-testid="select-create-role"
              >
                {ASSIGNABLE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            {createNeedsSquadron && (
              <div className="space-y-1">
                <Label htmlFor="create-squadron">{t("usersFieldSquadron")}</Label>
                <select
                  id="create-squadron"
                  className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm"
                  value={createDraft.squadron_id}
                  onChange={(e) =>
                    setCreateDraft((d) => ({ ...d, squadron_id: e.target.value }))
                  }
                  data-testid="select-create-squadron"
                >
                  <option value="">—</option>
                  {squadrons.map((s) => (
                    <option key={s.id} value={s.id}>
                      {squadronLabel(s)}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-zinc-500">{t("usersScopeHelp")}</p>
              </div>
            )}
            {createErr && (
              <div className="rounded border border-red-700/40 bg-red-900/20 p-2 text-xs text-red-200">
                {createErr}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateOpen(false)}
              disabled={createBusy}
            >
              {t("cancel")}
            </Button>
            <Button
              onClick={() => void submitCreate()}
              disabled={createBusy}
              data-testid="button-submit-create-user"
            >
              {createBusy ? t("saving") : t("create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog --------------------------------------------------- */}
      <Dialog open={!!editTarget} onOpenChange={(v) => !v && setEditTarget(null)}>
        <DialogContent className="max-w-md" data-testid="dialog-edit-user">
          <DialogHeader>
            <DialogTitle>
              {t("usersEdit")} — {editTarget?.username}
            </DialogTitle>
          </DialogHeader>
          {editTarget && editDraft && (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="edit-role">{t("usersFieldRole")}</Label>
                {!editIsAssignable ? (
                  <div className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-400">
                    {editDraft.role} — {t("usersRoleLockedHelp")}
                  </div>
                ) : (
                  <select
                    id="edit-role"
                    className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm"
                    value={editDraft.role}
                    onChange={(e) =>
                      setEditDraft((d) =>
                        d
                          ? {
                              ...d,
                              role: e.target.value as AssignableRole,
                            }
                          : d,
                      )
                    }
                    data-testid="select-edit-role"
                  >
                    {ASSIGNABLE_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              {editIsAssignable
                && SCOPED_ROLES.has(editDraft.role as AssignableRole) && (
                <div className="space-y-1">
                  <Label htmlFor="edit-squadron">{t("usersFieldSquadron")}</Label>
                  <select
                    id="edit-squadron"
                    className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm"
                    value={editDraft.squadron_id}
                    onChange={(e) =>
                      setEditDraft((d) =>
                        d ? { ...d, squadron_id: e.target.value } : d,
                      )
                    }
                    data-testid="select-edit-squadron"
                  >
                    <option value="">—</option>
                    {squadrons.map((s) => (
                      <option key={s.id} value={s.id}>
                        {squadronLabel(s)}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-zinc-500">{t("usersScopeHelp")}</p>
                </div>
              )}
              <div className="space-y-1">
                <Label htmlFor="edit-password" className="flex items-center gap-2">
                  <KeyRound className="h-3.5 w-3.5" />
                  {t("usersResetPassword")}
                </Label>
                <Input
                  id="edit-password"
                  type="password"
                  placeholder={t("usersResetPasswordPlaceholder")}
                  value={editDraft.newPassword}
                  onChange={(e) =>
                    setEditDraft((d) =>
                      d ? { ...d, newPassword: e.target.value } : d,
                    )
                  }
                  data-testid="input-edit-password"
                />
                <p className="text-xs text-zinc-500">{t("usersPasswordHelp")}</p>
              </div>
              {editErr && (
                <div className="rounded border border-red-700/40 bg-red-900/20 p-2 text-xs text-red-200">
                  {editErr}
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditTarget(null)}
              disabled={editBusy}
            >
              {t("cancel")}
            </Button>
            <Button
              onClick={() => void submitEdit()}
              disabled={editBusy}
              data-testid="button-submit-edit-user"
            >
              {editBusy ? t("saving") : t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm ------------------------------------------------ */}
      <Dialog open={!!deleteTarget} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <DialogContent className="max-w-md" data-testid="dialog-delete-user">
          <DialogHeader>
            <DialogTitle>{t("usersDeleteTitle")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-zinc-300">
            {t("usersDeleteConfirm").replace(
              "{username}",
              deleteTarget?.username ?? "",
            )}
          </p>
          <p className="text-xs text-zinc-500">{t("usersDeleteHelp")}</p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={busyId === deleteTarget?.id}
            >
              {t("cancel")}
            </Button>
            <Button
              onClick={() => void confirmDelete()}
              disabled={busyId === deleteTarget?.id}
              data-testid="button-confirm-delete-user"
            >
              {busyId === deleteTarget?.id ? t("saving") : t("delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
