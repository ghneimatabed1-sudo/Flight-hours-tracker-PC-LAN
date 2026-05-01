import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { Stack, useRouter } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Linking,
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

export default function LinkScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t, isRTL } = useI18n();
  const { linkAccount, remoteEnabled } = useAppData();

  const [militaryNumber, setMilitaryNumber] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const r = await linkAccount(militaryNumber, code);
    setSubmitting(false);
    if (!r.ok) {
      const map: Record<string, string> = {
        not_found: t("link_error_not_found"),
        bad_code: t("link_error_bad_code"),
        revoked: t("link_error_revoked"),
      };
      setError(map[r.error ?? ""] ?? t("link_error_generic"));
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
    } else {
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success
        ).catch(() => {});
      }
      // After linking we first make the pilot create a local device
      // password — the app is then locked on every cold launch. The
      // setup-lock screen forwards to /reminders once the password is
      // confirmed. If /setup-lock navigation fails for any reason
      // (route not yet registered, race with auth gate in _layout)
      // fall through to the tabs root so the user is NEVER stranded
      // on the link screen after a successful pairing.
      try {
        router.replace("/setup-lock" as never);
      } catch {
        try {
          router.replace("/(tabs)" as never);
        } catch {
          try {
            router.replace("/reminders" as never);
          } catch {
            // All nav paths failed — surface a visible error so the
            // pilot knows the link succeeded and can manually retry.
            setError(t("link_error_generic"));
          }
        }
      }
    }
  };

  const topPad = (Platform.OS === "web" ? 67 : insets.top) + 24;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAwareScrollView
        bottomOffset={20}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.content, { paddingTop: topPad }]}
      >
        <View style={[styles.brand, { backgroundColor: colors.primary }]}>
          <Feather name="shield" size={28} color={colors.primaryForeground} />
        </View>
        <Text
          style={[
            styles.title,
            { color: colors.foreground, textAlign: isRTL ? "right" : "left" },
          ]}
        >
          {t("link_title")}
        </Text>
        <Text
          style={[
            styles.subtitle,
            {
              color: colors.mutedForeground,
              textAlign: isRTL ? "right" : "left",
            },
          ]}
        >
          {t("link_subtitle")}
        </Text>

        {!remoteEnabled ? (
          <View
            style={[
              styles.warning,
              { backgroundColor: colors.muted, borderColor: colors.border },
            ]}
          >
            <Feather name="cloud-off" size={14} color={colors.warning} />
            <Text style={[styles.warningText, { color: colors.foreground }]}>
              {t("link_offline_warning")}
            </Text>
          </View>
        ) : null}

        <View style={styles.field}>
          <Text style={[styles.label, { color: colors.mutedForeground, textAlign: isRTL ? "right" : "left" }]}>
            {t("link_militaryNumber")}
          </Text>
          <TextInput
            value={militaryNumber}
            onChangeText={setMilitaryNumber}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="62701"
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
          <Text style={[styles.label, { color: colors.mutedForeground, textAlign: isRTL ? "right" : "left" }]}>
            {t("link_code")}
          </Text>
          <TextInput
            value={code}
            onChangeText={setCode}
            keyboardType="number-pad"
            placeholder="123456"
            placeholderTextColor={colors.mutedForeground}
            maxLength={8}
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
          <Text style={[styles.error, { color: colors.destructive, textAlign: isRTL ? "right" : "left" }]}>
            {error}
          </Text>
        ) : null}

        <Pressable
          onPress={handleSubmit}
          disabled={submitting || !militaryNumber || !code}
          style={({ pressed }) => [
            styles.button,
            {
              backgroundColor: colors.primary,
              opacity: pressed || submitting || !militaryNumber || !code ? 0.7 : 1,
            },
          ]}
        >
          {submitting ? (
            <ActivityIndicator color={colors.primaryForeground} />
          ) : (
            <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>
              {t("link_submit")}
            </Text>
          )}
        </Pressable>

        {!remoteEnabled ? (
          <Text style={[styles.hint, { color: colors.mutedForeground, textAlign: isRTL ? "right" : "left" }]}>
            {t("link_demo_hint")}
          </Text>
        ) : null}

        {/* Contact strip — subtle, centered, visible before linking so a
            pilot without a military number / code knows who to ask. */}
        <View style={styles.creditsWrap}>
          <View style={styles.creditsDividerRow}>
            <View style={[styles.creditsDivider, { backgroundColor: colors.border }]} />
            <Text style={[styles.creditsTitle, { color: colors.primary }]}>
              {t("settings_credits")}
            </Text>
            <View style={[styles.creditsDivider, { backgroundColor: colors.border }]} />
          </View>

          <Text style={[styles.creditsRole, { color: colors.mutedForeground }]}>
            {t("credits_developer")}
          </Text>
          <Text style={[styles.creditsName, { color: colors.foreground }]}>
            Capt. ABEDALQADER GHUNMAT
          </Text>

          <View style={styles.creditsPillRow}>
            <Pressable
              onPress={() => Linking.openURL("tel:+9620775008345").catch(() => {})}
              style={({ pressed }) => [
                styles.creditsPill,
                {
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                  opacity: pressed ? 0.7 : 1,
                },
              ]}
            >
              <Feather name="phone" size={12} color={colors.primary} />
              <Text style={[styles.creditsPillText, { color: colors.foreground }]}>
                +962 77 500 8345
              </Text>
            </Pressable>
            <Pressable
              onPress={() => Linking.openURL("mailto:ghneimatabed1@icloud.com").catch(() => {})}
              style={({ pressed }) => [
                styles.creditsPill,
                {
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                  opacity: pressed ? 0.7 : 1,
                },
              ]}
            >
              <Feather name="mail" size={12} color={colors.primary} />
              <Text style={[styles.creditsPillText, { color: colors.foreground }]}>
                ghneimatabed1@icloud.com
              </Text>
            </Pressable>
          </View>

          <Text style={[styles.creditsBlurb, { color: colors.mutedForeground }]}>
            {t("credits_blurb")}
          </Text>
        </View>
      </KeyboardAwareScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 22,
    paddingBottom: 60,
    gap: 14,
  },
  brand: {
    width: 60,
    height: 60,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  title: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
  },
  subtitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    lineHeight: 20,
    marginBottom: 6,
  },
  warning: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  warningText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    flex: 1,
  },
  field: {
    gap: 6,
    marginTop: 4,
  },
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
  error: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
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
  },
  creditsWrap: {
    marginTop: 24,
    alignItems: "center",
    gap: 8,
  },
  creditsDividerRow: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "stretch",
    gap: 10,
    marginBottom: 4,
  },
  creditsDivider: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  creditsTitle: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    letterSpacing: 2,
    textTransform: "uppercase",
  },
  creditsRole: {
    fontSize: 10,
    fontFamily: "Inter_500Medium",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  creditsName: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.4,
    marginBottom: 4,
  },
  creditsPillRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 8,
    marginTop: 2,
  },
  creditsPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  creditsPillText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  creditsBlurb: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    lineHeight: 16,
    textAlign: "center",
    marginTop: 6,
    paddingHorizontal: 16,
  },
});
