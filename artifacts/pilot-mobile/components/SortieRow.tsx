import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { useColors } from "@/hooks/useColors";
import { formatHours } from "@/lib/calculations";
import { useI18n } from "@/lib/i18n";
import type { SortieRecord } from "@/lib/types";

interface Props {
  sortie: SortieRecord;
}

function formatDate(d: string): string {
  // Squadron-wide DD-MM-YYYY (matches the ops dashboard, every PDF, and
  // every printable surface so pilots see one consistent date format).
  const parts = d.split("-");
  if (parts.length !== 3) return d;
  return `${parts[2]}-${parts[1]}-${parts[0]}`;
}

export function SortieRow({ sortie }: Props) {
  const colors = useColors();
  const { t, isRTL } = useI18n();

  const tag = sortie.pilotIsCaptain ? t("log_captain") : t("log_copilot");
  const tagBg = sortie.pilotIsCaptain ? colors.primary : colors.secondary;
  const tagFg = sortie.pilotIsCaptain ? colors.primaryForeground : colors.foreground;

  const breakdown: string[] = [];
  if (sortie.day > 0) breakdown.push(`Day ${formatHours(sortie.day)}`);
  if (sortie.night > 0) breakdown.push(`Night ${formatHours(sortie.night)}`);
  if (sortie.nvg > 0) breakdown.push(`NVG ${formatHours(sortie.nvg)}`);
  if (sortie.sim > 0) breakdown.push(`Sim ${formatHours(sortie.sim)}`);

  const conditionBg =
    sortie.condition === "NVG" ? "#b91c1c33" :
    sortie.condition === "Night" ? "#1e3a8a55" :
    sortie.condition === "Day" ? colors.primary + "33" : undefined;
  const conditionFg =
    sortie.condition === "NVG" ? "#fecaca" :
    sortie.condition === "Night" ? "#bfdbfe" :
    sortie.condition === "Day" ? colors.primary : undefined;

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.card, borderColor: colors.border },
      ]}
    >
      <View
        style={[
          styles.headerRow,
          { flexDirection: isRTL ? "row-reverse" : "row" },
        ]}
      >
        <Text style={[styles.date, { color: colors.foreground }]}>
          {formatDate(sortie.date)}
        </Text>
        <View style={[styles.tag, { backgroundColor: tagBg }]}>
          <Text style={[styles.tagText, { color: tagFg }]}>{tag}</Text>
        </View>
      </View>
      <Text
        style={[
          styles.title,
          { color: colors.foreground, textAlign: isRTL ? "right" : "left" },
        ]}
      >
        {sortie.name || sortie.sortieType || "—"}
      </Text>
      <Text
        style={[
          styles.meta,
          {
            color: colors.mutedForeground,
            textAlign: isRTL ? "right" : "left",
          },
        ]}
      >
        {[sortie.acType, sortie.acNumber, sortie.sortieType]
          .filter(Boolean)
          .join("  ·  ")}
      </Text>
      {(sortie.condition || sortie.remarks) ? (
        <View
          style={[
            styles.conditionRow,
            { flexDirection: isRTL ? "row-reverse" : "row" },
          ]}
        >
          {sortie.condition && conditionBg && conditionFg ? (
            <View style={[styles.conditionTag, { backgroundColor: conditionBg }]}>
              <Text style={[styles.conditionText, { color: conditionFg }]}>
                {sortie.condition.toUpperCase()}
              </Text>
            </View>
          ) : null}
          {sortie.remarks ? (
            <Text
              style={[
                styles.remarks,
                {
                  color: colors.mutedForeground,
                  textAlign: isRTL ? "right" : "left",
                },
              ]}
              numberOfLines={2}
            >
              {sortie.remarks}
            </Text>
          ) : null}
        </View>
      ) : null}
      <View
        style={[
          styles.footer,
          { flexDirection: isRTL ? "row-reverse" : "row" },
        ]}
      >
        <Text style={[styles.breakdown, { color: colors.mutedForeground }]}>
          {breakdown.join("  ·  ") || "—"}
        </Text>
        <Text style={[styles.total, { color: colors.primary }]}>
          {formatHours(sortie.total)} h
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: 14,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 6,
  },
  headerRow: {
    justifyContent: "space-between",
    alignItems: "center",
  },
  date: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    letterSpacing: 0.4,
  },
  tag: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  tagText: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.6,
  },
  title: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    marginTop: 2,
  },
  meta: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
  },
  footer: {
    marginTop: 6,
    justifyContent: "space-between",
    alignItems: "center",
  },
  breakdown: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    flex: 1,
  },
  total: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
  },
  conditionRow: {
    marginTop: 4,
    alignItems: "center",
    gap: 8,
  },
  conditionTag: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  conditionText: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.6,
  },
  remarks: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
    flex: 1,
  },
});
