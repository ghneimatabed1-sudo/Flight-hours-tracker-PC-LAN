// Squadrons admin page.
//
// HISTORY (v1.0.42): Prior versions rendered this page as a read-only list
// driven by the empty `mockData.squadrons` array. The result: a fresh
// install had no squadrons and no way to create one, so the License Keys
// generator's squadron dropdown stayed empty and the entire
// "activate other PCs" flow was blocked. This version adds Create / Edit /
// Delete / Enable-Disable, backed by the local squadron store.

import { useState, useMemo, useEffect } from "react";
import { useI18n } from "@/lib/i18n";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { pilots } from "@/lib/mockData";
import {
  useSquadrons,
  addSquadron,
  updateSquadron,
  deleteSquadron,
  setSquadronEnabled,
  refreshSquadronsFromDb,
} from "@/lib/squadron-store";
import {
  useRegisteredPCs,
  getLatestSquadronFlightGroup,
  publishSquadronFlightGroup,
  wipeAllRegisteredPCs,
} from "@/lib/cross-pc";
import { isLanSessionLoginEnabled } from "@/lib/internal-migration";
import { useAuth } from "@/lib/auth";
import { useQueryClient } from "@tanstack/react-query";
import type { Squadron } from "@/lib/types";
import { Plane, Plus, Pencil, Trash2, Eraser } from "lucide-react";

type DraftSquadron = {
  name: string;
  nameAr: string;
  code: string;
  base: string;
  baseAr: string;
  wing: string;
  wingAr: string;
};

const EMPTY_DRAFT: DraftSquadron = {
  name: "", nameAr: "", code: "", base: "", baseAr: "", wing: "", wingAr: "",
};

export default function Squadrons() {
  const { t, lang } = useI18n();
  const lanMode = isLanSessionLoginEnabled();
  const list = useSquadrons();
  useEffect(() => {
    void refreshSquadronsFromDb().catch(() => {
      // Fallback to local cache when offline or lacking DB access.
    });
  }, []);
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const isSuperAdmin = user?.role === "super_admin";

  const [wipeOpen, setWipeOpen] = useState(false);
  const [wiping, setWiping] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingPcId, setEditingPcId] = useState<string>("");
  const [editingPcName, setEditingPcName] = useState<string>("");
  const [draft, setDraft] = useState<DraftSquadron>(EMPTY_DRAFT);
  const [err, setErr] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  // Linked flight commander PCs for the squadron being edited. Populated
  // from the latest xpc.squadron.flight.group.set audit_log event when
  // the edit dialog opens, and re-published when the admin saves.
  const [linkedFlightIds, setLinkedFlightIds] = useState<string[]>([]);
  const [loadingGroup, setLoadingGroup] = useState(false);
  // v1.1.119 — Defer the cross-PC registry fetch until the edit dialog is
  // actually opened. Previously this fired on every first paint of
  // /admin/squadrons (and could surface as a 401 in the browser console
  // when a stale auth token was attached), even though the squadron list
  // itself is rendered from the local squadron store and does not need
  // registry data. The picker only renders inside the edit dialog, so
  // gating the query on `dialogOpen` removes the speculative call without
  // changing UX.
  const registeredPcs = useRegisteredPCs({ enabled: dialogOpen });
  // Show all flight commander PCs even when the strict squadron-name
  // match fails. v1.1.32: ports the v1.1.29 LicenseKeys helper so the
  // Super Admin sees the same forgiving same-squadron list and the same
  // "show every registered flight PC" fallback when spelling drifts
  // (e.g. "NO.8" vs "no 8" vs "8 SQN") would otherwise hide them.
  const normalizeSqLabel = (s: string | undefined | null) =>
    (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const sqKey = normalizeSqLabel(draft.name);
  const sqDigits = (draft.name ?? "").match(/\d+/)?.[0] ?? "";
  const flightPcsForSquadron = useMemo(() => {
    if (!editingId) return [];
    return registeredPcs.data.filter(p => {
      if (p.tier !== "flight") return false;
      const flKey = normalizeSqLabel(p.squadronName);
      if (!flKey) return false;
      if (sqKey && flKey === sqKey) return true;
      if (sqKey && (flKey.includes(sqKey) || sqKey.includes(flKey))) return true;
      if (sqDigits && flKey.includes(sqDigits)) return true;
      return false;
    });
  }, [registeredPcs.data, editingId, sqKey, sqDigits]);
  // Diagnostic fallback — every registered flight PC in the ecosystem,
  // regardless of label. The Super Admin can always tick the right
  // ones from here when spelling drift hides them from the strict list.
  const allRegisteredFlightPcs = useMemo(
    () => registeredPcs.data.filter(p => p.tier === "flight"),
    [registeredPcs.data],
  );
  const showFallbackFlightPicker =
    !!editingId
    && flightPcsForSquadron.length === 0
    && allRegisteredFlightPcs.length > 0;
  // v1.1.37: ultimate escape hatch. If the registry has ZERO entries
  // tagged tier="flight" (e.g. the flight cmdr PC was first registered
  // before the FLIGHT: id-prefix scheme existed and its row in the DB
  // still says tier="squadron"), the operator still needs to be able to
  // bind the right PC. Show every non-self PC in the registry with its
  // tier badge so the admin can tick the flight cmdr PC manually.
  const allOtherPcs = useMemo(
    () => registeredPcs.data.filter(p => !p.isSelf),
    [registeredPcs.data],
  );
  const showAnyTierFallback =
    !!editingId
    && flightPcsForSquadron.length === 0
    && allRegisteredFlightPcs.length === 0
    && allOtherPcs.length > 0;

  function openCreate() {
    setEditingId(null);
    setEditingPcId("");
    setEditingPcName("");
    setDraft(EMPTY_DRAFT);
    setLinkedFlightIds([]);
    setErr(null);
    setDialogOpen(true);
  }

  function openEdit(s: Squadron) {
    setEditingId(s.id);
    setDraft({
      name: s.name, nameAr: s.nameAr, code: s.code,
      base: s.base, baseAr: s.baseAr, wing: s.wing, wingAr: s.wingAr,
    });
    setErr(null);
    setLinkedFlightIds([]);
    // v1.1.18: the squadron commander PC's canonical id in the
    // cross-PC registry is now SQDNCMD:<squadron-name> — the ops PC of
    // the same squadron uses the bare squadron name. The group is
    // owned by the COMMANDER, so key it by the SQDNCMD: id.
    const pcId = `SQDNCMD:${s.name}`;
    setEditingPcId(pcId);
    setEditingPcName(s.name);
    setDialogOpen(true);
    setLoadingGroup(true);
    void (async () => {
      const group = await getLatestSquadronFlightGroup(pcId);
      if (group) setLinkedFlightIds(group.flightPcIds);
      setLoadingGroup(false);
    })();
  }

  async function save() {
    setErr(null);
    const trimmedName = draft.name.trim();
    const trimmedCode = draft.code.trim().toUpperCase();
    const trimmedBase = draft.base.trim();
    const trimmedWing = draft.wing.trim();
    if (!trimmedName || !trimmedCode || !trimmedBase || !trimmedWing) {
      setErr(lang === "ar" ? "أكمل جميع الحقول المطلوبة." : "Fill all required fields.");
      return;
    }
    if (editingId) {
      // Uniqueness guard when editing: only conflict if another row owns the code.
      if (list.some(s => s.id !== editingId && s.code.toUpperCase() === trimmedCode)) {
        setErr(lang === "ar" ? "رمز السرب مستخدم مسبقاً." : "Squadron code already exists.");
        return;
      }
      const ok = await updateSquadron(editingId, {
        name: trimmedName,
        nameAr: draft.nameAr.trim() || trimmedName,
        code: trimmedCode,
        base: trimmedBase,
        baseAr: draft.baseAr.trim() || trimmedBase,
        wing: trimmedWing,
        wingAr: draft.wingAr.trim() || trimmedWing,
      });
      if (!ok) {
        setErr(lang === "ar" ? "تعذّر تحديث السرب." : "Could not update squadron.");
        return;
      }
      // Re-publish the squadron's flight-commander group with the
      // admin's current selection. The squadron commander PC's
      // heartbeat will converge on this new list within ~30s; flight
      // commander PCs whose id appears here will auto-bind to the
      // squadron commander on their next sign-in.
      if (editingPcId) {
        void publishSquadronFlightGroup(
          editingPcId,
          editingPcName || trimmedName,
          linkedFlightIds,
        );
      }
    } else {
      const res = await addSquadron({
        name: trimmedName,
        nameAr: draft.nameAr.trim(),
        code: trimmedCode,
        base: trimmedBase,
        baseAr: draft.baseAr.trim(),
        wing: trimmedWing,
        wingAr: draft.wingAr.trim(),
      });
      if (!res.ok) {
        if (res.error === "duplicate_code") {
          setErr(lang === "ar" ? "رمز السرب مستخدم مسبقاً." : "Squadron code already exists.");
        } else {
          setErr(lang === "ar" ? "تعذّر الحفظ." : "Could not save squadron.");
        }
        return;
      }
    }
    setDialogOpen(false);
  }

  async function handleDelete(id: string) {
    // Two-click confirm pattern — consistent with Commanders / LicenseKeys UIs.
    if (pendingDeleteId !== id) {
      setPendingDeleteId(id);
      return;
    }
    const ok = await deleteSquadron(id);
    if (!ok) {
      setErr(lang === "ar" ? "تعذّر حذف السرب." : "Could not delete squadron.");
      return;
    }
    setPendingDeleteId(null);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold flex items-center gap-2">
          <Plane className="h-5 w-5" />{t("squadrons")}
        </h2>
        <div className="flex items-center gap-2">
          {isSuperAdmin ? (
            <Button
              variant="outline"
              onClick={() => setWipeOpen(true)}
              data-testid="button-wipe-registered-pcs"
              title={lang === "ar"
                ? "حذف جميع أجهزة الكمبيوتر المسجلة (يحتفظ بهذا الجهاز)"
                : "Wipe every registered PC from the central registry (keeps this PC)"}
            >
              <Eraser className="h-4 w-4 me-2" />
              {lang === "ar" ? "مسح الأجهزة المسجلة" : "Clear registered PCs"}
            </Button>
          ) : null}
          <Button onClick={openCreate} data-testid="button-add-squadron">
            <Plus className="h-4 w-4 me-2" />
            {lang === "ar" ? "إضافة سرب" : "Add Squadron"}
          </Button>
        </div>
      </div>

      {lanMode && (
        <Card>
          <CardContent className="py-3 text-xs text-sky-100 border border-sky-700/40 bg-sky-900/20 rounded-md">
            {t("squadronsLanModeNote")}
          </CardContent>
        </Card>
      )}

      {list.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {lang === "ar"
              ? "لا توجد أسراب بعد. اضغط \"إضافة سرب\" لإنشاء أول سرب."
              : "No squadrons yet. Click \"Add Squadron\" to create the first one."}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-muted-foreground">
                    <th className="text-start py-2 px-3">{t("squadron")}</th>
                    <th className="text-start py-2 px-3">{t("base")}</th>
                    <th className="text-start py-2 px-3">{t("wing")}</th>
                    <th className="text-end py-2 px-3">{t("pilotCount")}</th>
                    <th className="text-start py-2 px-3">{t("status")}</th>
                    <th className="text-end py-2 px-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {list.map(s => {
                    const count = pilots.filter(p => p.squadronId === s.id).length;
                    return (
                      <tr key={s.id} className="border-b border-border/60" data-testid={`row-sqn-${s.id}`}>
                        <td className="py-2 px-3 font-medium">
                          {lang === "ar" ? s.nameAr : s.name}
                          <span className="text-muted-foreground text-xs"> ({s.code})</span>
                        </td>
                        <td className="py-2 px-3">{lang === "ar" ? s.baseAr : s.base}</td>
                        <td className="py-2 px-3">{lang === "ar" ? s.wingAr : s.wing}</td>
                        <td className="py-2 px-3 text-end tabular-nums">{count}</td>
                        <td className="py-2 px-3">
                          <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${s.enabled
                            ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
                            : "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300"}`}>
                            {s.enabled ? t("enabled") : t("disabled")}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-end">
                          <div className="inline-flex gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={async () => {
                                const ok = await setSquadronEnabled(s.id, !s.enabled);
                                if (!ok) {
                                  setErr(lang === "ar" ? "تعذّر تحديث حالة السرب." : "Could not update squadron status.");
                                }
                              }}
                              data-testid={`button-toggle-${s.id}`}
                            >
                              {s.enabled ? t("disable") : t("enable")}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => openEdit(s)}
                              data-testid={`button-edit-${s.id}`}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              size="sm"
                              variant={pendingDeleteId === s.id ? "destructive" : "outline"}
                              onClick={() => handleDelete(s.id)}
                              data-testid={`button-delete-${s.id}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              {pendingDeleteId === s.id && (
                                <span className="ms-1 text-xs">
                                  {lang === "ar" ? "تأكيد" : "Confirm"}
                                </span>
                              )}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editingId
                ? (lang === "ar" ? "تعديل السرب" : "Edit Squadron")
                : (lang === "ar" ? "إضافة سرب جديد" : "Add New Squadron")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>{lang === "ar" ? "اسم السرب (EN)" : "Squadron name (EN)"}</Label>
                <Input
                  value={draft.name}
                  onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
                  placeholder="e.g. 7 Squadron"
                  data-testid="input-sqn-name"
                />
              </div>
              <div>
                <Label>{lang === "ar" ? "اسم السرب (AR)" : "Squadron name (AR)"}</Label>
                <Input
                  value={draft.nameAr}
                  onChange={e => setDraft(d => ({ ...d, nameAr: e.target.value }))}
                  placeholder="مثال: السرب ٧"
                  dir="rtl"
                  data-testid="input-sqn-name-ar"
                />
              </div>
            </div>
            <div>
              <Label>{lang === "ar" ? "الرمز" : "Code"}</Label>
              <Input
                value={draft.code}
                onChange={e => setDraft(d => ({ ...d, code: e.target.value.toUpperCase() }))}
                placeholder="e.g. 7SQN"
                maxLength={12}
                data-testid="input-sqn-code"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>{lang === "ar" ? "القاعدة (EN)" : "Base (EN)"}</Label>
                <Input
                  value={draft.base}
                  onChange={e => setDraft(d => ({ ...d, base: e.target.value }))}
                  placeholder="e.g. Main Air Base"
                  data-testid="input-sqn-base"
                />
              </div>
              <div>
                <Label>{lang === "ar" ? "القاعدة (AR)" : "Base (AR)"}</Label>
                <Input
                  value={draft.baseAr}
                  onChange={e => setDraft(d => ({ ...d, baseAr: e.target.value }))}
                  dir="rtl"
                  data-testid="input-sqn-base-ar"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>{lang === "ar" ? "الجناح (EN)" : "Wing (EN)"}</Label>
                <Input
                  value={draft.wing}
                  onChange={e => setDraft(d => ({ ...d, wing: e.target.value }))}
                  placeholder="e.g. Rotary Wing"
                  data-testid="input-sqn-wing"
                />
              </div>
              <div>
                <Label>{lang === "ar" ? "الجناح (AR)" : "Wing (AR)"}</Label>
                <Input
                  value={draft.wingAr}
                  onChange={e => setDraft(d => ({ ...d, wingAr: e.target.value }))}
                  dir="rtl"
                  data-testid="input-sqn-wing-ar"
                />
              </div>
            </div>
            {/* Flight commander group editor — only meaningful when editing
                an existing squadron (for new squadrons no flight PCs can
                have registered under its name yet). */}
            {editingId && (
              <div className="space-y-2 rounded-md border border-teal-300/40 bg-teal-50/60 dark:bg-teal-950/20 p-3">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-sm font-medium text-teal-900 dark:text-teal-200">
                    {lang === "ar"
                      ? "قادة الطيران في هذا السرب"
                      : "Flight commanders in this squadron"}
                  </Label>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => { void registeredPcs.refetch(); }}
                    disabled={registeredPcs.isFetching}
                    data-testid="button-refresh-flight-pcs"
                  >
                    {registeredPcs.isFetching
                      ? (lang === "ar" ? "جارٍ التحديث…" : "Refreshing…")
                      : (lang === "ar" ? "تحديث من الشبكة" : "Refresh from network")}
                  </Button>
                </div>
                {loadingGroup ? (
                  <p className="text-[11px] text-muted-foreground">
                    {lang === "ar" ? "جارٍ التحميل…" : "Loading current group…"}
                  </p>
                ) : showAnyTierFallback ? (
                  <div className="space-y-1.5 max-h-48 overflow-y-auto pe-1">
                    <p className="text-[11px] text-amber-700 dark:text-amber-300 mb-1">
                      {lang === "ar"
                        ? `لم يُسجَّل أي جهاز كقائد طيران بعد. القائمة أدناه تعرض كل أجهزة الشبكة (${allOtherPcs.length}) — اختر جهاز قائد الطيران يدوياً:`
                        : `No PC is tagged as flight commander yet. Showing every PC the network has seen (${allOtherPcs.length}) — pick the flight commander PC manually:`}
                    </p>
                    {allOtherPcs.map(pc => {
                      const checked = linkedFlightIds.includes(pc.id);
                      return (
                        <label
                          key={pc.id}
                          className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-teal-100/40 dark:hover:bg-teal-900/20 cursor-pointer"
                          data-testid={`row-sqn-anytier-${pc.id}`}
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(v) => {
                              setLinkedFlightIds(prev =>
                                v ? Array.from(new Set([...prev, pc.id]))
                                  : prev.filter(x => x !== pc.id),
                              );
                            }}
                            data-testid={`checkbox-sqn-anytier-${pc.id}`}
                          />
                          <span className="text-sm flex-1">
                            {pc.deviceName || pc.squadronName || pc.id}
                            <span className="text-[10px] text-muted-foreground ms-1">
                              [{pc.tier}] ({pc.squadronName || "—"})
                            </span>
                          </span>
                          {pc.online && (
                            <span className="text-[10px] text-emerald-600 dark:text-emerald-400">●</span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                ) : flightPcsForSquadron.length === 0 && !showFallbackFlightPicker ? (
                  <div className="space-y-1">
                    <p className="text-[11px] text-amber-700 dark:text-amber-300">
                      {lang === "ar"
                        ? "لا يوجد قادة طيران مسجلون لهذا السرب بعد. افتح \"حارس الصقر\" على جهاز قائد الطيران وسجّل الدخول مرة واحدة، ثم أعد فتح هذا الحوار."
                        : "No flight commander PCs are registered yet. Open Hawk Eye on the flight commander PC and sign in once, then re-open this dialog."}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      {lang === "ar"
                        ? `تشخيص: السجل يحتوي ${registeredPcs.data.length} جهاز(أجهزة)، منها ${allRegisteredFlightPcs.length} كقائد طيران.`
                        : `Diagnostic: registry has ${registeredPcs.data.length} PC(s) total, ${allRegisteredFlightPcs.length} tagged as flight.`}
                    </p>
                  </div>
                ) : flightPcsForSquadron.length === 0 ? (
                  <div className="space-y-1.5 max-h-48 overflow-y-auto pe-1">
                    <p className="text-[11px] text-amber-700 dark:text-amber-300 mb-1">
                      {lang === "ar"
                        ? "لم يطابق أي جهاز اسم السرب تماماً. اختر الجهاز الصحيح من القائمة الكاملة أدناه:"
                        : "No PC matched this squadron name exactly. Pick the right one from the full list below:"}
                    </p>
                    {allRegisteredFlightPcs.map(pc => {
                      const checked = linkedFlightIds.includes(pc.id);
                      return (
                        <label
                          key={pc.id}
                          className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-teal-100/40 dark:hover:bg-teal-900/20 cursor-pointer"
                          data-testid={`row-sqn-flight-fallback-${pc.id}`}
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(v) => {
                              setLinkedFlightIds(prev =>
                                v ? Array.from(new Set([...prev, pc.id]))
                                  : prev.filter(x => x !== pc.id),
                              );
                            }}
                            data-testid={`checkbox-sqn-flight-fallback-${pc.id}`}
                          />
                          <span className="text-sm flex-1">
                            {pc.deviceName || pc.squadronName || pc.id}
                            <span className="text-[10px] text-muted-foreground ms-1">
                              ({pc.squadronName || "—"})
                            </span>
                          </span>
                          {pc.online && (
                            <span className="text-[10px] text-emerald-600 dark:text-emerald-400">●</span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                ) : (
                  <div className="space-y-1.5 max-h-48 overflow-y-auto pe-1">
                    {flightPcsForSquadron.map(pc => {
                      const checked = linkedFlightIds.includes(pc.id);
                      return (
                        <label
                          key={pc.id}
                          className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-teal-100/40 dark:hover:bg-teal-900/20 cursor-pointer"
                          data-testid={`row-sqn-flight-${pc.id}`}
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(v) => {
                              setLinkedFlightIds(prev =>
                                v ? Array.from(new Set([...prev, pc.id]))
                                  : prev.filter(x => x !== pc.id),
                              );
                            }}
                            data-testid={`checkbox-sqn-flight-${pc.id}`}
                          />
                          <span className="text-sm flex-1">
                            {pc.deviceName || pc.squadronName}
                          </span>
                          {pc.online && (
                            <span className="text-[10px] text-emerald-600 dark:text-emerald-400">●</span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                )}
                <p className="text-[10px] text-teal-900/70 dark:text-teal-200/70">
                  {lang === "ar"
                    ? `المرتبطون: ${linkedFlightIds.length}. سيسري التغيير خلال ٣٠ ثانية من الحفظ على جميع أجهزة السرب.`
                    : `Linked: ${linkedFlightIds.length}. Changes propagate to every PC in the squadron within ~30s of saving.`}
                </p>
              </div>
            )}
            {err && <div className="text-sm text-destructive">{err}</div>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {lang === "ar" ? "إلغاء" : "Cancel"}
            </Button>
            <Button onClick={save} data-testid="button-save-squadron">
              {lang === "ar" ? "حفظ" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={wipeOpen} onOpenChange={(o) => !wiping && setWipeOpen(o)}>
        <DialogContent data-testid="dialog-wipe-registered-pcs">
          <DialogHeader>
            <DialogTitle>
              {lang === "ar" ? "مسح جميع الأجهزة المسجلة" : "Clear all registered PCs"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p>
              {lang === "ar"
                ? "سيؤدي هذا إلى حذف كل جهاز كمبيوتر مسجل من السجل المركزي ومن النسخة المحلية على هذا الجهاز. سيتم الاحتفاظ بهذا الجهاز فقط حتى لا يتم تسجيل خروجك من سلسلة التنسيق."
                : "This deletes every registered PC from the central registry and from this PC's local mirror. Only THIS PC is kept, so you do not sign yourself out of the chain."}
            </p>
            <p className="text-muted-foreground">
              {lang === "ar"
                ? "كل جهاز كمبيوتر آخر سيعيد التسجيل تلقائياً عند نبضته التالية (خلال ٣٠ ثانية) إذا كان لا يزال متصلاً. استخدم هذا الزر عند نقل التطبيق إلى سرب آخر للتخلص من أجهزة السرب السابق."
                : "Every other PC will automatically re-register on its next heartbeat (within 30s) if it is still online. Use this when moving the install to another squadron, to flush the previous squadron's PCs."}
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setWipeOpen(false)}
              disabled={wiping}
            >
              {lang === "ar" ? "إلغاء" : "Cancel"}
            </Button>
            <Button
              variant="destructive"
              data-testid="button-confirm-wipe-registered-pcs"
              disabled={wiping}
              onClick={async () => {
                setWiping(true);
                try {
                  const res = await wipeAllRegisteredPCs();
                  await queryClient.invalidateQueries({ queryKey: ["xpc", "registry"] });
                  if (res.errors.length > 0) {
                    window.alert(
                      (lang === "ar"
                        ? "تم المسح محلياً، لكن أبلغ الخادم المركزي عن أخطاء:\n\n"
                        : "Wipe done locally, but the central server reported errors:\n\n") +
                      res.errors.map(e => "  • " + e).join("\n"),
                    );
                  } else {
                    window.alert(
                      lang === "ar"
                        ? `تم. تم حذف ${res.removedCentral} جهاز من السجل المركزي و ${res.removedLocal} من النسخة المحلية.`
                        : `Done. Removed ${res.removedCentral} PC(s) from the central registry and ${res.removedLocal} from this PC's mirror.`,
                    );
                  }
                  setWipeOpen(false);
                } finally {
                  setWiping(false);
                }
              }}
            >
              <Eraser className="h-4 w-4 me-2" />
              {wiping
                ? (lang === "ar" ? "جارٍ المسح..." : "Clearing...")
                : (lang === "ar" ? "تأكيد المسح" : "Confirm wipe")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
