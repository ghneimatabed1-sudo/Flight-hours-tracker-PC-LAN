import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { Stack, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";
import { useI18n } from "@/lib/i18n";
import {
  configureNotificationHandler,
  DEFAULT_PREFS,
  loadReminderPrefs,
  normaliseThresholds,
  registerForPushNotifications,
  resolveProjectId,
  saveReminderPrefs,
  type CurrencyKey,
  type ReminderPrefs,
} from "@/lib/notifications";

// Simulator currency intentionally excluded — it does not get reminders.
const CURRENCY_LIST: { key: CurrencyKey; tk: string }[] = [
  { key: "day", tk: "currency_day" },
  { key: "night", tk: "currency_night" },
  { key: "nvg", tk: "currency_nvg" },
  { key: "irt", tk: "currency_irt" },
  { key: "medical", tk: "currency_medical" },
];

export default function RemindersScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t, isRTL } = useI18n();

  const [prefs, setPrefs] = useState<ReminderPrefs>(DEFAULT_PREFS);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    configureNotificationHandler();
    let cancelled = false;
    (async () => {
      const p = await loadReminderPrefs();
      if (!cancelled) {
        setPrefs(p);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback(async (next: ReminderPrefs) => {
    setPrefs(next);
    setBusy(true);
    setError(null);
    const ok = await saveReminderPrefs(next);
    setBusy(false);
    if (!ok) setError(t("reminders_save_error"));
  }, [t]);

  const togglePush = useCallback(
    async (value: boolean) => {
      if (!value) {
        await persist({ ...prefs, pushEnabled: false });
        return;
      }
      // Enable: first request OS permission + Expo token.
      setBusy(true);
      setError(null);
      const r = await registerForPushNotifications(resolveProjectId());
      setBusy(false);
      if (!r.ok) {
        if (r.error === "permission_denied") {
          if (Platform.OS !== "web") {
            Alert.alert(
              t("reminders_perm_title"),
              t("reminders_perm_body"),
              [
                { text: t("cancel"), style: "cancel" },
                {
                  text: t("reminders_open_settings"),
                  onPress: () => Linking.openSettings().catch(() => {}),
                },
              ]
            );
          } else {
            setError(t("reminders_perm_body"));
          }
          return;
        }
        if (r.error === "unsupported_platform") {
          setError(t("reminders_unsupported"));
          return;
        }
        if (r.error === "no_project_id") {
          setError(t("reminders_no_project"));
          return;
        }
        setError(t("reminders_token_error"));
        return;
      }
      await persist({
        ...prefs,
        pushEnabled: true,
        expoPushToken: r.token ?? prefs.expoPushToken,
        platform: Platform.OS,
      });
      if (Platform.OS !== "web")
        Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success
        ).catch(() => {});
    },
    [persist, prefs, t]
  );

  const addThreshold = useCallback(
    (key: CurrencyKey, days: number) => {
      const current = prefs.thresholds[key] ?? [];
      if (current.includes(days)) return;
      const next = normaliseThresholds([...current, days]);
      void persist({
        ...prefs,
        thresholds: { ...prefs.thresholds, [key]: next },
      });
      if (Platform.OS !== "web")
        Haptics.selectionAsync().catch(() => {});
    },
    [persist, prefs]
  );

  const removeThreshold = useCallback(
    (key: CurrencyKey, days: number) => {
      const current = prefs.thresholds[key] ?? [];
      const next = normaliseThresholds(current.filter((d) => d !== days));
      void persist({
        ...prefs,
        thresholds: { ...prefs.thresholds, [key]: next },
      });
      if (Platform.OS !== "web")
        Haptics.selectionAsync().catch(() => {});
    },
    [persist, prefs]
  );

  // One pending input per currency so each card has its own text field state.
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const topPad = (Platform.OS === "web" ? 67 : insets.top) + 8;

  const summary = useMemo(() => {
    const total = CURRENCY_LIST.reduce(
      (acc, c) => acc + (prefs.thresholds[c.key]?.length ?? 0),
      0
    );
    return total;
  }, [prefs.thresholds]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.header, { paddingTop: topPad }]}>
        <Pressable
          onPress={() => {
            // When the pilot lands here straight after creating their
            // password (first-run flow) the navigation stack is empty, so
            // router.back() is a no-op. Fall back to replacing with the
            // tabs root so the header arrow always leaves the screen.
            if (router.canGoBack()) router.back();
            else router.replace("/(tabs)" as never);
          }}
          hitSlop={12}
          style={({ pressed }) => [
            styles.headerBtn,
            { opacity: pressed ? 0.6 : 1 },
          ]}
        >
          <Feather
            name={isRTL ? "chevron-right" : "chevron-left"}
            size={22}
            color={colors.foreground}
          />
        </Pressable>
        <Text
          style={[
            styles.headerTitle,
            { color: colors.foreground, textAlign: isRTL ? "right" : "left" },
          ]}
        >
          {t("reminders_title")}
        </Text>
        {busy ? <ActivityIndicator color={colors.primary} /> : <View style={{ width: 22 }} />}
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 60 }]}
        keyboardShouldPersistTaps="handled"
      >
        <Text
          style={[
            styles.subtitle,
            {
              color: colors.mutedForeground,
              textAlign: isRTL ? "right" : "left",
            },
          ]}
        >
          {t("reminders_subtitle")}
        </Text>

        <View
          style={[
            styles.card,
            {
              backgroundColor: colors.card,
              borderColor: colors.border,
              flexDirection: isRTL ? "row-reverse" : "row",
            },
          ]}
        >
          <View style={{ flex: 1 }}>
            <Text
              style={[
                styles.cardTitle,
                { color: colors.foreground, textAlign: isRTL ? "right" : "left" },
              ]}
            >
              {t("reminders_push_label")}
            </Text>
            <Text
              style={[
                styles.cardBody,
                {
                  color: colors.mutedForeground,
                  textAlign: isRTL ? "right" : "left",
                },
              ]}
            >
              {prefs.pushEnabled
                ? t("reminders_push_on")
                : t("reminders_push_off")}
            </Text>
          </View>
          <Switch
            value={prefs.pushEnabled}
            onValueChange={togglePush}
            disabled={busy || loading}
            trackColor={{ true: colors.primary, false: colors.muted }}
            thumbColor={Platform.OS === "android" ? colors.card : undefined}
          />
        </View>

        {error ? (
          <Text
            style={[
              styles.errorText,
              { color: colors.destructive, textAlign: isRTL ? "right" : "left" },
            ]}
          >
            {error}
          </Text>
        ) : null}

        <Text
          style={[
            styles.section,
            {
              color: colors.mutedForeground,
              textAlign: isRTL ? "right" : "left",
            },
          ]}
        >
          {t("reminders_per_currency")}
          {summary > 0 ? `  ·  ${summary}` : ""}
        </Text>

        {loading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 24 }} />
        ) : (
          CURRENCY_LIST.map(({ key, tk }) => {
            const list = prefs.thresholds[key] ?? [];
            return (
              <View
                key={key}
                style={[
                  styles.currencyCard,
                  { backgroundColor: colors.card, borderColor: colors.border },
                ]}
              >
                <Text
                  style={[
                    styles.currencyLabel,
                    {
                      color: colors.foreground,
                      textAlign: isRTL ? "right" : "left",
                    },
                  ]}
                >
                  {t(tk)}
                </Text>
                {/* Custom day input. The pilot types any number of days
                    (0–365) and taps Add. Each saved value becomes a chip
                    that can be removed with an inline ✕. */}
                <View
                  style={[
                    styles.inputRow,
                    { flexDirection: isRTL ? "row-reverse" : "row" },
                  ]}
                >
                  <TextInput
                    value={drafts[key] ?? ""}
                    onChangeText={(v) =>
                      setDrafts((d) => ({ ...d, [key]: v.replace(/[^0-9]/g, "") }))
                    }
                    placeholder={t("reminders_input_placeholder")}
                    placeholderTextColor={colors.mutedForeground}
                    keyboardType="number-pad"
                    maxLength={3}
                    style={[
                      styles.dayInput,
                      {
                        backgroundColor: colors.muted,
                        borderColor: colors.border,
                        color: colors.foreground,
                        textAlign: isRTL ? "right" : "left",
                      },
                    ]}
                    editable={!busy}
                  />
                  <Pressable
                    onPress={() => {
                      const raw = drafts[key]?.trim() ?? "";
                      if (!raw) return;
                      const n = Math.trunc(Number(raw));
                      if (!Number.isFinite(n) || n < 0 || n > 365) return;
                      addThreshold(key, n);
                      setDrafts((d) => ({ ...d, [key]: "" }));
                    }}
                    disabled={busy || !(drafts[key]?.trim())}
                    style={({ pressed }) => [
                      styles.addBtn,
                      {
                        backgroundColor: colors.primary,
                        opacity: pressed || busy || !(drafts[key]?.trim()) ? 0.7 : 1,
                      },
                    ]}
                  >
                    <Text style={[styles.addBtnText, { color: colors.primaryForeground }]}>
                      {t("reminders_add")}
                    </Text>
                  </Pressable>
                </View>

                {list.length > 0 ? (
                  <View
                    style={[
                      styles.chipRow,
                      { flexDirection: isRTL ? "row-reverse" : "row" },
                    ]}
                  >
                    {list.map((d) => (
                      <Pressable
                        key={d}
                        onPress={() => removeThreshold(key, d)}
                        disabled={busy}
                        style={({ pressed }) => [
                          styles.chip,
                          {
                            backgroundColor: colors.primary,
                            borderColor: colors.primary,
                            opacity: pressed ? 0.6 : 1,
                            flexDirection: isRTL ? "row-reverse" : "row",
                            gap: 6,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.chipText,
                            { color: colors.primaryForeground },
                          ]}
                        >
                          {d === 0
                            ? t("reminders_chip_today")
                            : `${d}${t("reminders_chip_day_suffix")}`}
                        </Text>
                        <Feather
                          name="x"
                          size={12}
                          color={colors.primaryForeground}
                        />
                      </Pressable>
                    ))}
                  </View>
                ) : null}
                <Text
                  style={[
                    styles.helperText,
                    {
                      color: colors.mutedForeground,
                      textAlign: isRTL ? "right" : "left",
                    },
                  ]}
                >
                  {list.length === 0
                    ? t("reminders_none")
                    : t("reminders_summary").replace(
                        "{n}",
                        String(list.length)
                      )}
                </Text>
              </View>
            );
          })
        )}

        <Text
          style={[
            styles.footnote,
            {
              color: colors.mutedForeground,
              textAlign: isRTL ? "right" : "left",
            },
          ]}
        >
          {t("reminders_footnote")}
        </Text>

        <Pressable
          onPress={() => {
            if (router.canGoBack()) router.back();
            else router.replace("/(tabs)" as never);
          }}
          style={({ pressed }) => [
            styles.doneBtn,
            {
              backgroundColor: colors.primary,
              opacity: pressed ? 0.8 : 1,
            },
          ]}
        >
          <Text
            style={[
              styles.doneBtnText,
              { color: colors.primaryForeground },
            ]}
          >
            {t("reminders_done")}
          </Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingBottom: 8,
    gap: 10,
  },
  headerBtn: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    flex: 1,
    fontSize: 18,
    fontFamily: "Inter_700Bold",
  },
  content: {
    paddingHorizontal: 18,
    paddingTop: 8,
    gap: 14,
  },
  subtitle: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    lineHeight: 19,
  },
  card: {
    padding: 14,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    gap: 12,
  },
  cardTitle: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  cardBody: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  errorText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  section: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginTop: 8,
  },
  currencyCard: {
    padding: 14,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  currencyLabel: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
  chipRow: {
    flexWrap: "wrap",
    gap: 6,
  },
  inputRow: {
    alignItems: "center",
    gap: 8,
  },
  dayInput: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 14,
    fontFamily: "Inter_500Medium",
  },
  addBtn: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 10,
  },
  addBtnText: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.4,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
  helperText: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  footnote: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    lineHeight: 16,
    marginTop: 8,
  },
  doneBtn: {
    marginTop: 14,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  doneBtnText: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.4,
  },
});
