import { Feather } from "@expo/vector-icons";
import React, { useMemo } from "react";
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
import type { NotamRecord } from "@/lib/types";

// Mirror HTML `dir="auto"` semantics: scan for the first "strong" directional
// character (Latin letter vs. Arabic/Hebrew letter) and use that to pick the
// paragraph's direction. This avoids flipping an English-primary NOTAM to RTL
// just because it mentions one Arabic word, and vice versa.
const STRONG_LTR_RE = /[A-Za-z\u00C0-\u024F]/;
const STRONG_RTL_RE = /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

function isArabic(text: string): boolean {
  for (const ch of text) {
    if (STRONG_RTL_RE.test(ch)) return true;
    if (STRONG_LTR_RE.test(ch)) return false;
  }
  return false;
}

function formatDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`;
}

export default function NotamsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { t, isRTL } = useI18n();
  const { snapshot, refresh, refreshing } = useAppData();

  const notams: NotamRecord[] = useMemo(
    () => snapshot?.notams ?? [],
    [snapshot]
  );

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
        <Feather name="alert-triangle" size={22} color={colors.primary} />
        <View style={{ flex: 1 }}>
          <Text
            style={[
              styles.title,
              { color: colors.foreground, textAlign: isRTL ? "right" : "left" },
            ]}
          >
            {t("notams_title")}
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
            {t("notams_subtitle")}
          </Text>
        </View>
      </View>

      {notams.length === 0 ? (
        <View
          style={[
            styles.emptyCard,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <Feather name="inbox" size={28} color={colors.mutedForeground} />
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
            {t("notams_empty")}
          </Text>
        </View>
      ) : (
        notams.map((n) => {
          const ar = isArabic(n.text);
          return (
            <View
              key={n.id}
              style={[
                styles.card,
                { backgroundColor: colors.card, borderColor: colors.border },
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
                    {n.id}
                  </Text>
                </View>
                <Text style={[styles.date, { color: colors.mutedForeground }]}>
                  {formatDate(n.date)}
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
                {n.text}
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
    justifyContent: "space-between",
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
  date: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
    fontFamily: "Inter_400Regular",
  },
  // Arabic body intentionally drops `fontFamily` so the OS picks its
  // native Arabic system font (San Francisco Arabic on iOS, Noto Naskh /
  // Roboto Arabic on Android), which renders Arabic glyphs and ligatures
  // correctly. Inter has no Arabic coverage and would render as boxes.
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
