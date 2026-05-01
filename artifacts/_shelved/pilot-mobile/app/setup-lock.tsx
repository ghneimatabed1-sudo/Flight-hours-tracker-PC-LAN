import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";
import { useAppData } from "@/lib/data";
import { useI18n } from "@/lib/i18n";

// Two modes:
//   - initial  → first-time password creation after linking. No "current
//                password" field. Navigates to /reminders on success so
//                the pilot also picks their currency thresholds.
//   - change   → pilot taps "Change password" in settings. Asks for the
//                existing password first.
export default function SetupLockScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t, isRTL } = useI18n();
  const { createPassword, changePassword, hasPassword } = useAppData();
  const params = useLocalSearchParams<{ mode?: string }>();
  const mode: "initial" | "change" =
    params.mode === "change" || hasPassword ? "change" : "initial";

  const [currentPw, setCurrentPw] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (submitting) return;
    setError(null);

    const clean = password.trim();
    if (clean.length < 4) {
      setError(t("setup_lock_error_short"));
      return;
    }
    if (clean !== confirm.trim()) {
      setError(t("setup_lock_error_mismatch"));
      return;
    }

    setSubmitting(true);
    let ok = false;
    let wrongCurrent = false;
    if (mode === "change") {
      const r = await changePassword(currentPw, clean);
      ok = r.ok;
      wrongCurrent = !r.ok && r.error === "wrong_current";
    } else {
      const r = await createPassword(clean);
      ok = r.ok;
    }
    setSubmitting(false);

    if (!ok) {
      setError(
        wrongCurrent
          ? t("setup_lock_error_wrong_current")
          : t("setup_lock_error_generic")
      );
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Error
        ).catch(() => {});
      }
      return;
    }

    if (Platform.OS !== "web") {
      Haptics.notificationAsync(
        Haptics.NotificationFeedbackType.Success
      ).catch(() => {});
    }

    try {
      if (mode === "initial") {
        router.replace("/reminders" as never);
      } else {
        router.back();
      }
    } catch {
      // best-effort
    }
  };

  const topPad = (Platform.OS === "web" ? 67 : insets.top) + 24;
  const title =
    mode === "change" ? t("setup_lock_title_change") : t("setup_lock_title");
  const subtitle =
    mode === "change"
      ? t("setup_lock_subtitle_change")
      : t("setup_lock_subtitle");

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen
        options={{
          headerShown: mode === "change",
          title,
          headerBackTitle: t("common_back"),
          gestureEnabled: mode === "change",
        }}
      />
      <KeyboardAwareScrollView
        bottomOffset={20}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.content, { paddingTop: topPad }]}
      >
        {mode === "initial" ? (
          <View style={[styles.brand, { backgroundColor: colors.primary }]}>
            <Feather name="lock" size={28} color={colors.primaryForeground} />
          </View>
        ) : null}

        {mode === "initial" ? (
          <Text
            style={[
              styles.title,
              {
                color: colors.foreground,
                textAlign: isRTL ? "right" : "left",
              },
            ]}
          >
            {title}
          </Text>
        ) : null}
        <Text
          style={[
            styles.subtitle,
            {
              color: colors.mutedForeground,
              textAlign: isRTL ? "right" : "left",
            },
          ]}
        >
          {subtitle}
        </Text>

        {mode === "change" ? (
          <View style={styles.field}>
            <Text
              style={[
                styles.label,
                {
                  color: colors.mutedForeground,
                  textAlign: isRTL ? "right" : "left",
                },
              ]}
            >
              {t("setup_lock_current")}
            </Text>
            <TextInput
              value={currentPw}
              onChangeText={setCurrentPw}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="••••••••"
              placeholderTextColor={colors.mutedForeground}
              style={[
                styles.input,
                {
                  color: colors.foreground,
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                  textAlign: isRTL ? "right" : "left",
                },
              ]}
            />
          </View>
        ) : null}

        <View style={styles.field}>
          <Text
            style={[
              styles.label,
              {
                color: colors.mutedForeground,
                textAlign: isRTL ? "right" : "left",
              },
            ]}
          >
            {t("setup_lock_new")}
          </Text>
          <TextInput
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="••••••••"
            placeholderTextColor={colors.mutedForeground}
            style={[
              styles.input,
              {
                color: colors.foreground,
                backgroundColor: colors.card,
                borderColor: colors.border,
                textAlign: isRTL ? "right" : "left",
              },
            ]}
          />
        </View>

        <View style={styles.field}>
          <Text
            style={[
              styles.label,
              {
                color: colors.mutedForeground,
                textAlign: isRTL ? "right" : "left",
              },
            ]}
          >
            {t("setup_lock_confirm")}
          </Text>
          <TextInput
            value={confirm}
            onChangeText={setConfirm}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={handleSubmit}
            placeholder="••••••••"
            placeholderTextColor={colors.mutedForeground}
            style={[
              styles.input,
              {
                color: colors.foreground,
                backgroundColor: colors.card,
                borderColor: colors.border,
                textAlign: isRTL ? "right" : "left",
              },
            ]}
          />
        </View>

        {error ? (
          <Text
            style={[
              styles.error,
              {
                color: colors.destructive,
                textAlign: isRTL ? "right" : "left",
              },
            ]}
          >
            {error}
          </Text>
        ) : null}

        <Pressable
          onPress={handleSubmit}
          disabled={submitting || !password || !confirm}
          style={({ pressed }) => [
            styles.button,
            {
              backgroundColor: colors.primary,
              opacity:
                pressed || submitting || !password || !confirm ? 0.7 : 1,
            },
          ]}
        >
          {submitting ? (
            <ActivityIndicator color={colors.primaryForeground} />
          ) : (
            <Text
              style={[styles.buttonText, { color: colors.primaryForeground }]}
            >
              {mode === "change"
                ? t("setup_lock_save")
                : t("setup_lock_create")}
            </Text>
          )}
        </Pressable>

        <Text
          style={[
            styles.hint,
            {
              color: colors.mutedForeground,
              textAlign: isRTL ? "right" : "left",
            },
          ]}
        >
          {t("setup_lock_hint")}
        </Text>
      </KeyboardAwareScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 22, paddingBottom: 60, gap: 14 },
  brand: {
    width: 60,
    height: 60,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  title: { fontSize: 28, fontFamily: "Inter_700Bold" },
  subtitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    lineHeight: 20,
    marginBottom: 6,
  },
  field: { gap: 6, marginTop: 4 },
  label: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  input: {
    fontSize: 16,
    fontFamily: "Inter_500Medium",
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  error: { fontSize: 13, fontFamily: "Inter_500Medium" },
  button: {
    marginTop: 8,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.4,
  },
  hint: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    marginTop: 4,
    lineHeight: 17,
  },
});
