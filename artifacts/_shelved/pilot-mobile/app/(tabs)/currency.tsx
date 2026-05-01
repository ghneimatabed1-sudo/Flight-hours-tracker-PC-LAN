import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useMemo } from "react";
import {
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { CurrencyRow } from "@/components/CurrencyRow";
import { useColors } from "@/hooks/useColors";
import { computeCurrencies } from "@/lib/calculations";
import { useAppData } from "@/lib/data";
import { useI18n } from "@/lib/i18n";

export default function CurrencyScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t, isRTL } = useI18n();
  const { snapshot, refresh, refreshing } = useAppData();

  const items = useMemo(
    () => (snapshot ? computeCurrencies(snapshot.profile) : []),
    [snapshot]
  );

  if (!snapshot) return null;

  const topPad = (Platform.OS === "web" ? 67 : insets.top) + 12;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={[styles.content, { paddingTop: topPad }]}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void refresh()}
          tintColor={colors.primary}
        />
      }
    >
      <View
        style={[
          styles.titleRow,
          { flexDirection: isRTL ? "row-reverse" : "row" },
        ]}
      >
        <Text
          style={[
            styles.title,
            { color: colors.foreground, textAlign: isRTL ? "right" : "left" },
          ]}
        >
          {t("currency_title")}
        </Text>
        <Pressable
          onPress={() => router.push("/reminders" as never)}
          hitSlop={8}
          style={({ pressed }) => [
            styles.remindersBtn,
            {
              backgroundColor: colors.muted,
              borderColor: colors.border,
              opacity: pressed ? 0.7 : 1,
              flexDirection: isRTL ? "row-reverse" : "row",
            },
          ]}
        >
          <Feather name="bell" size={14} color={colors.primary} />
          <Text
            style={[
              styles.remindersBtnText,
              { color: colors.foreground },
            ]}
          >
            {t("reminders_title")}
          </Text>
        </Pressable>
      </View>
      <View style={styles.list}>
        {items.map((item) => (
          <CurrencyRow key={item.key} item={item} />
        ))}
      </View>
      {/* Last simulator session — monitoring date only, no expiry. Mirrors
          the dashboard's commander-only field via PilotProfile.lastSimDate.
          See `.local/memory/currency-refresh.md`. */}
      <View
        style={[
          styles.simRow,
          {
            backgroundColor: colors.muted,
            borderColor: colors.border,
            flexDirection: isRTL ? "row-reverse" : "row",
          },
        ]}
        // Last simulator session — monitoring row, no currency status.
        // Always rendered so the pilot (and any commander reviewing on
        // mobile) can see the recency. Empty value renders as em-dash.
      >
        <View style={{ flex: 1 }}>
          <Text style={[styles.simLabel, { color: colors.foreground, textAlign: isRTL ? "right" : "left" }]}>
            {t("currency_sim")}
          </Text>
          <Text style={[styles.simHint, { color: colors.mutedForeground, textAlign: isRTL ? "right" : "left" }]}>
            {t("sim_monitor_only")}
          </Text>
        </View>
        <Text
          style={[styles.simDate, { color: colors.foreground }]}
          accessibilityLabel={`Last simulator date ${snapshot.profile.lastSimDate ?? "not recorded"}`}
        >
          {snapshot.profile.lastSimDate ? formatSimDate(snapshot.profile.lastSimDate) : "—"}
        </Text>
      </View>
    </ScrollView>
  );
}

// Format an ISO yyyy-mm-dd into dd/mm/yyyy without timezone surprises.
function formatSimDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

const styles = StyleSheet.create({
  content: {
    padding: 18,
    paddingBottom: 120,
    gap: 12,
  },
  titleRow: {
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 6,
    gap: 12,
  },
  title: {
    fontSize: 26,
    fontFamily: "Inter_700Bold",
  },
  remindersBtn: {
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 6,
  },
  remindersBtnText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
  list: {
    gap: 10,
  },
  simRow: {
    marginTop: 6,
    padding: 14,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    gap: 12,
  },
  simLabel: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  simHint: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  simDate: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    fontVariant: ["tabular-nums"],
  },
});
