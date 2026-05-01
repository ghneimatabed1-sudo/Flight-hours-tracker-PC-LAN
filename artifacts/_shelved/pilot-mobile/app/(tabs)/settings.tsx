import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React from "react";
import {
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";
import { useAppData } from "@/lib/data";
import { useI18n, type Lang } from "@/lib/i18n";
import {
  loadPrefs,
  savePrefs,
  type AlertsTtlDays,
  type AutoSyncHours,
} from "@/lib/storage";
import { pingSync } from "@/lib/notifications";

interface RowProps {
  label: string;
  value: string;
  isRTL: boolean;
}

function Row({ label, value, isRTL }: RowProps) {
  const colors = useColors();
  return (
    <View
      style={[
        styles.row,
        {
          backgroundColor: colors.card,
          borderColor: colors.border,
          flexDirection: isRTL ? "row-reverse" : "row",
        },
      ]}
    >
      <Text style={[styles.rowLabel, { color: colors.mutedForeground }]}>
        {label}
      </Text>
      <Text
        style={[
          styles.rowValue,
          {
            color: colors.foreground,
            textAlign: isRTL ? "left" : "right",
          },
        ]}
      >
        {value || "—"}
      </Text>
    </View>
  );
}

export default function SettingsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { t, isRTL, lang, setLang } = useI18n();
  const { snapshot, unlink, signOut } = useAppData();
  const router = useRouter();

  if (!snapshot) return null;

  const profile = snapshot.profile;
  const topPad = (Platform.OS === "web" ? 67 : insets.top) + 12;

  // Hand the pilot a copy of their logbook (profile + every cached sortie).
  // Uses the native Share sheet on phones and a plain download on web —
  // no new native modules required. The pilot picks where the file goes
  // (AirDrop, email, Drive, WhatsApp…), and keeps it as a personal backup
  // independent of the squadron PC. We intentionally do NOT offer a
  // "restore" on mobile: re-linking the device from the PC is the clean
  // recovery path and it gets the freshest data every time.
  const exportLogbook = async () => {
    if (!snapshot) return;
    const payload = {
      kind: "rjaf-pilot-logbook",
      version: 1,
      exportedAt: new Date().toISOString(),
      profile: snapshot.profile,
      sorties: snapshot.sorties,
      totals: { count: snapshot.sorties.length },
    };
    const text = JSON.stringify(payload, null, 2);
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `logbook-${snapshot.profile.militaryNumber || "pilot"}-${stamp}.json`;
    try {
      if (Platform.OS === "web") {
        const blob = new Blob([text], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } else {
        await Share.share({
          title: filename,
          message: text,
        });
      }
    } catch (e) {
      Alert.alert(t("settings_export_failed"), String((e as Error).message || e));
    }
  };

  const confirmUnlink = () => {
    if (Platform.OS === "web") {
      // eslint-disable-next-line no-alert
      if (typeof window !== "undefined" && window.confirm(t("settings_unlink_confirm"))) {
        void unlink();
      }
      return;
    }
    Alert.alert(t("settings_unlink"), t("settings_unlink_confirm"), [
      { text: t("cancel"), style: "cancel" },
      { text: t("confirm"), style: "destructive", onPress: () => void unlink() },
    ]);
  };

  // Sign-out locks the app but keeps the pilot-device pairing intact. On
  // re-entry the pilot types their password — no new pairing code required.
  const confirmSignOut = () => {
    const proceed = () => {
      void signOut();
      try {
        router.replace("/lock" as never);
      } catch {
        // best-effort
      }
    };
    if (Platform.OS === "web") {
      // eslint-disable-next-line no-alert
      if (typeof window !== "undefined" && window.confirm(t("settings_signout_confirm"))) {
        proceed();
      }
      return;
    }
    Alert.alert(t("settings_signout"), t("settings_signout_confirm"), [
      { text: t("cancel"), style: "cancel" },
      { text: t("confirm"), onPress: proceed },
    ]);
  };

  const langOptions: { key: Lang; label: string }[] = [
    { key: "en", label: "English" },
    { key: "ar", label: "العربية" },
  ];

  const [alertsTtl, setAlertsTtl] = React.useState<AlertsTtlDays>(7);
  const [autoSyncHrs, setAutoSyncHrs] = React.useState<AutoSyncHours>(3);
  const [syncStatus, setSyncStatus] = React.useState<string>("");
  React.useEffect(() => {
    let cancelled = false;
    void loadPrefs().then((p) => {
      if (cancelled) return;
      setAlertsTtl(p.alertsTtlDays ?? 7);
      setAutoSyncHrs(p.autoSyncHours ?? 3);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const updateAlertsTtl = async (next: AlertsTtlDays) => {
    setAlertsTtl(next);
    const current = await loadPrefs();
    await savePrefs({ ...current, alertsTtlDays: next });
  };
  const updateAutoSync = async (next: AutoSyncHours) => {
    setAutoSyncHrs(next);
    const current = await loadPrefs();
    await savePrefs({ ...current, autoSyncHours: next });
  };
  const manualSync = async () => {
    setSyncStatus("Syncing…");
    const ok = await pingSync();
    setSyncStatus(ok ? `Synced ${new Date().toLocaleTimeString()}` : "Sync failed — try again");
  };
  const ttlOptions: { key: AlertsTtlDays; labelKey: "alerts_ttl_off" | "alerts_ttl_1d" | "alerts_ttl_3d" | "alerts_ttl_7d" | "alerts_ttl_30d" }[] = [
    { key: 0, labelKey: "alerts_ttl_off" },
    { key: 1, labelKey: "alerts_ttl_1d" },
    { key: 3, labelKey: "alerts_ttl_3d" },
    { key: 7, labelKey: "alerts_ttl_7d" },
    { key: 30, labelKey: "alerts_ttl_30d" },
  ];

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={[styles.content, { paddingTop: topPad }]}
    >
      <Text
        style={[
          styles.title,
          { color: colors.foreground, textAlign: isRTL ? "right" : "left" },
        ]}
      >
        {t("tab_settings")}
      </Text>

      <Text
        style={[
          styles.section,
          { color: colors.mutedForeground, textAlign: isRTL ? "right" : "left" },
        ]}
      >
        {t("settings_profile")}
      </Text>
      <View style={styles.list}>
        <Row label="Name" value={profile.name} isRTL={isRTL} />
        {profile.arabicName ? (
          <Row label="الاسم" value={profile.arabicName} isRTL={isRTL} />
        ) : null}
        <Row label={t("settings_rank")} value={profile.rank} isRTL={isRTL} />
        <Row
          label={t("settings_military_number")}
          value={profile.militaryNumber}
          isRTL={isRTL}
        />
        <Row label={t("settings_unit")} value={profile.unit} isRTL={isRTL} />
        <Row
          label={t("settings_squadron")}
          value={profile.squadron}
          isRTL={isRTL}
        />
      </View>

      <Text
        style={[
          styles.section,
          { color: colors.mutedForeground, textAlign: isRTL ? "right" : "left" },
        ]}
      >
        {t("settings_language")}
      </Text>
      <View
        style={[
          styles.langRow,
          { backgroundColor: colors.card, borderColor: colors.border },
        ]}
      >
        {langOptions.map((opt) => {
          const active = lang === opt.key;
          return (
            <Pressable
              key={opt.key}
              onPress={() => setLang(opt.key)}
              style={({ pressed }) => [
                styles.langBtn,
                {
                  backgroundColor: active ? colors.primary : "transparent",
                  opacity: pressed ? 0.8 : 1,
                },
              ]}
            >
              <Text
                style={[
                  styles.langText,
                  {
                    color: active ? colors.primaryForeground : colors.foreground,
                  },
                ]}
              >
                {opt.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Text
        style={[
          styles.section,
          { color: colors.mutedForeground, textAlign: isRTL ? "right" : "left" },
        ]}
      >
        {t("alerts_autodelete_title")}
      </Text>
      <View
        style={[
          styles.ttlGrid,
          { backgroundColor: colors.card, borderColor: colors.border },
        ]}
      >
        {ttlOptions.map((opt) => {
          const active = alertsTtl === opt.key;
          return (
            <Pressable
              key={opt.key}
              onPress={() => void updateAlertsTtl(opt.key)}
              style={({ pressed }) => [
                styles.ttlBtn,
                {
                  backgroundColor: active ? colors.primary : "transparent",
                  borderColor: active ? colors.primary : colors.border,
                  opacity: pressed ? 0.85 : 1,
                },
              ]}
            >
              <Text
                style={[
                  styles.ttlBtnText,
                  {
                    color: active ? colors.primaryForeground : colors.foreground,
                  },
                ]}
              >
                {t(opt.labelKey)}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Text
        style={[
          styles.ttlHint,
          { color: colors.mutedForeground, textAlign: isRTL ? "right" : "left" },
        ]}
      >
        {t("alerts_autodelete_hint")}
      </Text>

      {/* ── Auto-sync heartbeat ───────────────────────────────
          Sets how often the phone pings the squadron backend so the Ops
          Roster sees this pilot as "recently synced" (green dot). A
          "Sync now" button forces an immediate ping. */}
      <Text
        style={[
          styles.section,
          { color: colors.mutedForeground, textAlign: isRTL ? "right" : "left" },
        ]}
      >
        AUTO SYNC
      </Text>
      <View
        style={[
          styles.ttlGrid,
          { backgroundColor: colors.card, borderColor: colors.border },
        ]}
      >
        {([1, 3, 6, 12] as AutoSyncHours[]).map((h) => {
          const active = autoSyncHrs === h;
          return (
            <Pressable
              key={h}
              onPress={() => void updateAutoSync(h)}
              style={({ pressed }) => [
                styles.ttlBtn,
                {
                  backgroundColor: active ? colors.primary : "transparent",
                  borderColor: active ? colors.primary : colors.border,
                  opacity: pressed ? 0.85 : 1,
                },
              ]}
            >
              <Text
                style={[
                  styles.ttlBtnText,
                  {
                    color: active ? colors.primaryForeground : colors.foreground,
                  },
                ]}
              >
                {`${h}h`}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Pressable
        onPress={() => void manualSync()}
        style={({ pressed }) => [
          styles.row,
          {
            backgroundColor: colors.card,
            borderColor: colors.border,
            flexDirection: isRTL ? "row-reverse" : "row",
            opacity: pressed ? 0.85 : 1,
          },
        ]}
      >
        <View
          style={[
            styles.helpIcon,
            { backgroundColor: colors.muted, borderColor: colors.border },
          ]}
        >
          <Feather name="refresh-cw" size={16} color={colors.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text
            style={[
              styles.rowValue,
              { color: colors.foreground, textAlign: isRTL ? "right" : "left" },
            ]}
          >
            Sync now
          </Text>
          <Text
            style={[
              styles.rowLabel,
              {
                color: colors.mutedForeground,
                textAlign: isRTL ? "right" : "left",
                marginTop: 2,
              },
            ]}
          >
            {syncStatus || "Tap to force a heartbeat to the squadron server."}
          </Text>
        </View>
      </Pressable>

      <Text
        style={[
          styles.section,
          { color: colors.mutedForeground, textAlign: isRTL ? "right" : "left" },
        ]}
      >
        {t("reminders_title")}
      </Text>
      <Pressable
        onPress={() => router.push("/reminders" as never)}
        style={({ pressed }) => [
          styles.row,
          {
            backgroundColor: colors.card,
            borderColor: colors.border,
            flexDirection: isRTL ? "row-reverse" : "row",
            opacity: pressed ? 0.85 : 1,
          },
        ]}
      >
        <View
          style={[
            styles.helpIcon,
            { backgroundColor: colors.muted, borderColor: colors.border },
          ]}
        >
          <Feather name="bell" size={16} color={colors.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text
            style={[
              styles.rowValue,
              { color: colors.foreground, textAlign: isRTL ? "right" : "left" },
            ]}
          >
            {t("reminders_settings_label")}
          </Text>
          <Text
            style={[
              styles.rowLabel,
              {
                color: colors.mutedForeground,
                textAlign: isRTL ? "right" : "left",
                marginTop: 2,
              },
            ]}
          >
            {t("reminders_settings_hint")}
          </Text>
        </View>
        <Feather
          name={isRTL ? "chevron-left" : "chevron-right"}
          size={18}
          color={colors.mutedForeground}
        />
      </Pressable>

      <Text
        style={[
          styles.section,
          { color: colors.mutedForeground, textAlign: isRTL ? "right" : "left" },
        ]}
      >
        {t("settings_help")}
      </Text>
      <View style={styles.list}>
        {([
          ["help_step1_title", "help_step1_body", "key"],
          ["help_step2_title", "help_step2_body", "link"],
          ["help_step3_title", "help_step3_body", "grid"],
          ["help_step4_title", "help_step4_body", "refresh-cw"],
          ["help_step5_title", "help_step5_body", "edit-3"],
          ["help_step6_title", "help_step6_body", "help-circle"],
        ] as const).map(([titleKey, bodyKey, icon]) => (
          <View
            key={titleKey}
            style={[
              styles.helpCard,
              {
                backgroundColor: colors.card,
                borderColor: colors.border,
                flexDirection: isRTL ? "row-reverse" : "row",
              },
            ]}
          >
            <View
              style={[
                styles.helpIcon,
                { backgroundColor: colors.muted, borderColor: colors.border },
              ]}
            >
              <Feather name={icon} size={16} color={colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text
                style={[
                  styles.helpTitle,
                  { color: colors.foreground, textAlign: isRTL ? "right" : "left" },
                ]}
              >
                {t(titleKey)}
              </Text>
              <Text
                style={[
                  styles.helpBody,
                  {
                    color: colors.mutedForeground,
                    textAlign: isRTL ? "right" : "left",
                  },
                ]}
              >
                {t(bodyKey)}
              </Text>
            </View>
          </View>
        ))}
      </View>

      <Text
        style={[
          styles.section,
          { color: colors.mutedForeground, textAlign: isRTL ? "right" : "left" },
        ]}
      >
        {t("settings_about")}
      </Text>
      <Text
        style={[
          styles.about,
          {
            color: colors.mutedForeground,
            textAlign: isRTL ? "right" : "left",
          },
        ]}
      >
        {t("settings_about_text")}
      </Text>

      {/* ── Export logbook ─────────────────────────────
          Gives the pilot a personal copy of their hours they can keep
          on iCloud / Drive / email. The PC is still the source of truth. */}
      <Text
        style={[
          styles.section,
          { color: colors.mutedForeground, textAlign: isRTL ? "right" : "left" },
        ]}
      >
        {t("settings_backup")}
      </Text>
      <Pressable
        onPress={exportLogbook}
        style={({ pressed }) => [
          styles.row,
          {
            backgroundColor: colors.card,
            borderColor: colors.border,
            flexDirection: isRTL ? "row-reverse" : "row",
            opacity: pressed ? 0.85 : 1,
          },
        ]}
      >
        <View
          style={[
            styles.helpIcon,
            { backgroundColor: colors.muted, borderColor: colors.border },
          ]}
        >
          <Feather name="download" size={16} color={colors.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text
            style={[
              styles.rowValue,
              { color: colors.foreground, textAlign: isRTL ? "right" : "left" },
            ]}
          >
            {t("settings_export_logbook")}
          </Text>
          <Text
            style={[
              styles.rowLabel,
              {
                color: colors.mutedForeground,
                textAlign: isRTL ? "right" : "left",
                marginTop: 2,
              },
            ]}
          >
            {t("settings_export_logbook_hint")}
          </Text>
        </View>
        <Feather
          name={isRTL ? "chevron-left" : "chevron-right"}
          size={18}
          color={colors.mutedForeground}
        />
      </Pressable>

      {/* ── Security ─────────────────────────────
          Local device password: sign out locks the app but keeps the pilot
          paired, "change password" is for rotating the PIN, and "unlink"
          wipes the pairing entirely (a new pairing code will be needed). */}
      <Text
        style={[
          styles.section,
          { color: colors.mutedForeground, textAlign: isRTL ? "right" : "left" },
        ]}
      >
        {t("settings_security")}
      </Text>
      <Pressable
        onPress={confirmSignOut}
        style={({ pressed }) => [
          styles.row,
          {
            backgroundColor: colors.card,
            borderColor: colors.border,
            flexDirection: isRTL ? "row-reverse" : "row",
            opacity: pressed ? 0.85 : 1,
          },
        ]}
      >
        <View
          style={[
            styles.helpIcon,
            { backgroundColor: colors.muted, borderColor: colors.border },
          ]}
        >
          <Feather name="lock" size={16} color={colors.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text
            style={[
              styles.rowValue,
              { color: colors.foreground, textAlign: isRTL ? "right" : "left" },
            ]}
          >
            {t("settings_signout")}
          </Text>
          <Text
            style={[
              styles.rowLabel,
              {
                color: colors.mutedForeground,
                textAlign: isRTL ? "right" : "left",
                marginTop: 2,
              },
            ]}
          >
            {t("settings_signout_hint")}
          </Text>
        </View>
        <Feather
          name={isRTL ? "chevron-left" : "chevron-right"}
          size={18}
          color={colors.mutedForeground}
        />
      </Pressable>
      <Pressable
        onPress={() => router.push("/setup-lock?mode=change" as never)}
        style={({ pressed }) => [
          styles.row,
          {
            backgroundColor: colors.card,
            borderColor: colors.border,
            flexDirection: isRTL ? "row-reverse" : "row",
            opacity: pressed ? 0.85 : 1,
          },
        ]}
      >
        <View
          style={[
            styles.helpIcon,
            { backgroundColor: colors.muted, borderColor: colors.border },
          ]}
        >
          <Feather name="key" size={16} color={colors.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text
            style={[
              styles.rowValue,
              { color: colors.foreground, textAlign: isRTL ? "right" : "left" },
            ]}
          >
            {t("settings_change_password")}
          </Text>
          <Text
            style={[
              styles.rowLabel,
              {
                color: colors.mutedForeground,
                textAlign: isRTL ? "right" : "left",
                marginTop: 2,
              },
            ]}
          >
            {t("settings_change_password_hint")}
          </Text>
        </View>
        <Feather
          name={isRTL ? "chevron-left" : "chevron-right"}
          size={18}
          color={colors.mutedForeground}
        />
      </Pressable>

      <Pressable
        onPress={confirmUnlink}
        style={({ pressed }) => [
          styles.logout,
          {
            backgroundColor: colors.card,
            borderColor: colors.destructive,
            opacity: pressed ? 0.85 : 1,
          },
        ]}
      >
        <Feather name="log-out" size={16} color={colors.destructive} />
        <Text style={[styles.logoutText, { color: colors.destructive }]}>
          {t("settings_unlink")}
        </Text>
      </Pressable>

      {/* ── Credits (foot of page) ─────────────────────────────
          Moved to the very bottom of Settings so it mirrors the old
          mobile app's layout: an unobtrusive attribution block with
          tappable phone + email the pilot can use to reach the
          developer for support. */}
      <Text
        style={[
          styles.section,
          { color: colors.mutedForeground, textAlign: isRTL ? "right" : "left" },
        ]}
      >
        {t("settings_credits")}
      </Text>
      <View
        style={[
          styles.creditsCard,
          { backgroundColor: colors.card, borderColor: colors.border },
        ]}
      >
        <Text
          style={[
            styles.creditName,
            { color: colors.foreground, textAlign: isRTL ? "right" : "left" },
          ]}
        >
          Capt. ABEDALQADER GHUNMAT
        </Text>
        <Text
          style={[
            styles.creditRole,
            { color: colors.mutedForeground, textAlign: isRTL ? "right" : "left" },
          ]}
        >
          {t("credits_developer")}
        </Text>
        <Pressable
          onPress={() => Linking.openURL("tel:+9620775008345").catch(() => {})}
          style={({ pressed }) => [
            styles.creditRow,
            {
              borderColor: colors.border,
              flexDirection: isRTL ? "row-reverse" : "row",
              opacity: pressed ? 0.7 : 1,
            },
          ]}
        >
          <Feather name="phone" size={14} color={colors.primary} />
          <Text style={[styles.creditValue, { color: colors.foreground }]}>0775008345</Text>
        </Pressable>
        <Pressable
          onPress={() => Linking.openURL("mailto:ghneimatabed1@icloud.com").catch(() => {})}
          style={({ pressed }) => [
            styles.creditRow,
            {
              borderColor: colors.border,
              flexDirection: isRTL ? "row-reverse" : "row",
              opacity: pressed ? 0.7 : 1,
            },
          ]}
        >
          <Feather name="mail" size={14} color={colors.primary} />
          <Text style={[styles.creditValue, { color: colors.foreground }]}>ghneimatabed1@icloud.com</Text>
        </Pressable>
        <Text
          style={[
            styles.creditBlurb,
            { color: colors.mutedForeground, textAlign: isRTL ? "right" : "left" },
          ]}
        >
          {t("credits_blurb")}
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 18,
    paddingBottom: 120,
    gap: 10,
  },
  title: {
    fontSize: 26,
    fontFamily: "Inter_700Bold",
    marginBottom: 6,
  },
  section: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginTop: 16,
    marginBottom: 4,
  },
  list: {
    gap: 8,
  },
  row: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  rowLabel: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  rowValue: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    flex: 1,
  },
  langRow: {
    flexDirection: "row",
    padding: 4,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 4,
  },
  langBtn: {
    flex: 1,
    paddingVertical: 10,
    alignItems: "center",
    borderRadius: 8,
  },
  langText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  ttlGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    padding: 4,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 4,
  },
  ttlBtn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    flexGrow: 1,
    minWidth: 90,
    alignItems: "center",
  },
  ttlBtnText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  ttlHint: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    lineHeight: 17,
    marginTop: 6,
  },
  about: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    lineHeight: 19,
    marginTop: 4,
  },
  logout: {
    marginTop: 24,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  logoutText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  helpCard: {
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "flex-start",
    gap: 12,
  },
  helpIcon: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
  },
  helpTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    marginBottom: 2,
  },
  helpBody: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    lineHeight: 17,
  },
  creditsCard: {
    padding: 14,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 6,
  },
  creditName: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.3,
  },
  creditRole: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 6,
  },
  creditRow: {
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  creditValue: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  creditBlurb: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    lineHeight: 16,
    marginTop: 6,
  },
});
