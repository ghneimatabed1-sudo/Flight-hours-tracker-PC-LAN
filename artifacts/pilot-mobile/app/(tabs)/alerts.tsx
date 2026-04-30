import { Feather } from "@expo/vector-icons";
import React, { useEffect, useMemo, useState } from "react";
import {
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";
import { useAppData } from "@/lib/data";
import { useI18n } from "@/lib/i18n";
import { loadPrefs, type AlertsTtlDays } from "@/lib/storage";
import type { AlertRecord } from "@/lib/types";

const STRONG_LTR_RE = /[A-Za-z\u00C0-\u024F]/;
const STRONG_RTL_RE = /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

function isArabic(text: string): boolean {
  for (const ch of text) {
    if (STRONG_RTL_RE.test(ch)) return true;
    if (STRONG_LTR_RE.test(ch)) return false;
  }
  return false;
}

function formatTimestamp(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function AlertsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { t, isRTL } = useI18n();
  const { snapshot, refresh, refreshing } = useAppData();

  const [ttlDays, setTtlDays] = useState<AlertsTtlDays>(7);

  // Re-load the TTL preference whenever the screen regains focus so a change
  // made on the Settings tab is reflected immediately. `snapshot.fetchedAt`
  // is a convenient cheap dependency that ticks on every refresh too.
  useEffect(() => {
    let cancelled = false;
    void loadPrefs().then((p) => {
      if (!cancelled) setTtlDays(p.alertsTtlDays ?? 7);
    });
    return () => {
      cancelled = true;
    };
  }, [snapshot?.fetchedAt]);

  const alerts: AlertRecord[] = useMemo(() => {
    const all = snapshot?.alerts ?? [];
    if (!ttlDays || ttlDays <= 0) return all;
    const cutoff = Date.now() - ttlDays * 86400000;
    return all.filter((a) => {
      const t = new Date(a.postedAt).getTime();
      return Number.isFinite(t) ? t >= cutoff : true;
    });
  }, [snapshot, ttlDays]);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{
        padding: 16,
        paddingTop: insets.top + 16,
        paddingBottom: insets.bottom + 24,
        gap: 12,
      }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={refresh}
          tintColor={colors.primary}
        />
      }
    >
      <View style={styles.header}>
        <Feather name="bell" size={22} color={colors.primary} />
        <View style={{ flex: 1 }}>
          <Text
            style={[
              styles.title,
              { color: colors.foreground, textAlign: isRTL ? "right" : "left" },
            ]}
          >
            {t("alerts_title")}
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
            {t("alerts_subtitle")}
          </Text>
        </View>
      </View>

      {alerts.length === 0 ? (
        <View
          style={[
            styles.emptyCard,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <Feather name="inbox" size={28} color={colors.mutedForeground} />
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
            {t("alerts_empty")}
          </Text>
        </View>
      ) : (
        alerts.map((a) => {
          const ar = isArabic(a.text);
          // Map the 3-level priority to the agreed colour scheme.
          const pri = a.priority ?? "normal";
          const accent =
            pri === "urgent" ? "#f43f5e" /* rose-500 */
            : pri === "medium" ? "#f59e0b" /* amber-500 */
            : "#10b981" /* emerald-500 */;
          const priorityLabel =
            pri === "urgent" ? "VERY HIGH"
            : pri === "medium" ? "HIGH"
            : "NORMAL";
          return (
            <View
              key={a.id}
              style={[
                styles.card,
                {
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                  borderLeftColor: accent,
                  borderLeftWidth: 4,
                },
              ]}
            >
              <View style={styles.cardHead}>
                <View
                  style={[
                    styles.idPill,
                    { backgroundColor: colors.primary + "22" },
                  ]}
                >
                  <Text style={[styles.idText, { color: colors.primary }]}>
                    {a.author ?? a.id}
                  </Text>
                </View>
                <View
                  style={[
                    styles.priorityPill,
                    { backgroundColor: accent + "26", borderColor: accent + "66" },
                  ]}
                >
                  <Text style={[styles.priorityText, { color: accent }]}>
                    {priorityLabel}
                  </Text>
                </View>
                <Text style={[styles.date, { color: colors.mutedForeground }]}>
                  {formatTimestamp(a.postedAt)}
                </Text>
              </View>
              <Text
                style={[
                  ar ? styles.bodyArabic : styles.body,
                  {
                    color: colors.foreground,
                    textAlign: ar ? "right" : "left",
                    writingDirection: ar ? "rtl" : "ltr",
                  },
                ]}
              >
                {a.text}
              </Text>
            </View>
          );
        })
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    marginBottom: 4,
  },
  title: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    marginBottom: 2,
  },
  subtitle: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
  },
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    gap: 10,
  },
  cardHead: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
  },
  idPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  idText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.5,
  },
  priorityPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
  },
  priorityText: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.6,
  },
  date: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
    fontFamily: "Inter_400Regular",
  },
  bodyArabic: {
    fontSize: 17,
    lineHeight: 28,
    ...(Platform.OS === "ios" ? { fontFamily: "Geeza Pro" } : {}),
  },
  emptyCard: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 28,
    alignItems: "center",
    gap: 10,
  },
  emptyText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
  },
});
