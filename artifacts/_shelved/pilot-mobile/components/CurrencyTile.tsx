import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { useColors } from "@/hooks/useColors";
import type { CurrencyItem } from "@/lib/calculations";
import { useI18n } from "@/lib/i18n";

interface Props {
  item: CurrencyItem;
}

export function CurrencyTile({ item }: Props) {
  const colors = useColors();
  const { t } = useI18n();

  const palette = {
    expired: colors.destructive,
    urgent: colors.destructive,
    soon: colors.warning,
    ok: colors.success,
    missing: colors.mutedForeground,
  };
  const accent = palette[item.status];

  let valueText: string;
  if (item.status === "missing") valueText = "—";
  else if (item.daysRemaining === null) valueText = "—";
  else if (item.daysRemaining < 0) valueText = t("currency_expired");
  else if (item.daysRemaining === 0) valueText = t("currency_today");
  else valueText = `${item.daysRemaining}${t("reminders_chip_day_suffix")}`;

  const label = t(`currency_${item.key}`) || item.label;

  return (
    <View
      style={[
        styles.tile,
        {
          backgroundColor: colors.card,
          borderColor: colors.border,
        },
      ]}
    >
      <View style={[styles.accent, { backgroundColor: accent }]} />
      <Text
        numberOfLines={1}
        style={[styles.label, { color: colors.mutedForeground }]}
      >
        {String(label).toUpperCase()}
      </Text>
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        style={[styles.value, { color: accent }]}
      >
        {valueText}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 10,
    paddingHorizontal: 6,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    overflow: "hidden",
    position: "relative",
  },
  accent: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 3,
  },
  label: {
    fontSize: 9,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1.1,
  },
  value: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    fontVariant: ["tabular-nums"],
  },
});
