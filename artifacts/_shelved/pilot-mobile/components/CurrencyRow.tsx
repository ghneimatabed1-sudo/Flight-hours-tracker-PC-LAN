import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { useColors } from "@/hooks/useColors";
import type { CurrencyItem } from "@/lib/calculations";
import { useI18n } from "@/lib/i18n";

interface Props {
  item: CurrencyItem;
}

export function CurrencyRow({ item }: Props) {
  const colors = useColors();
  const { t, isRTL } = useI18n();

  const palette = {
    expired: colors.destructive,
    urgent: colors.destructive,
    soon: colors.warning,
    ok: colors.success,
    missing: colors.mutedForeground,
  };
  const dotColor = palette[item.status];

  let rightLabel: string;
  if (item.status === "missing") rightLabel = t("not_set");
  else if (item.daysRemaining === null) rightLabel = item.expiry ?? "—";
  else if (item.daysRemaining < 0) rightLabel = t("currency_expired");
  else if (item.daysRemaining === 0) rightLabel = t("currency_today");
  else rightLabel = `${item.daysRemaining} ${t("currency_days")}`;

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
      <View
        style={[
          styles.left,
          { flexDirection: isRTL ? "row-reverse" : "row" },
        ]}
      >
        <View style={[styles.dot, { backgroundColor: dotColor }]} />
        <View>
          <Text
            style={[
              styles.label,
              { color: colors.foreground, textAlign: isRTL ? "right" : "left" },
            ]}
          >
            {item.label}
          </Text>
          <Text
            style={[
              styles.sublabel,
              {
                color: colors.mutedForeground,
                textAlign: isRTL ? "right" : "left",
              },
            ]}
          >
            {item.expiry || "—"}
          </Text>
        </View>
      </View>
      <Text
        style={[
          styles.right,
          {
            color: dotColor,
            textAlign: isRTL ? "left" : "right",
          },
        ]}
      >
        {rightLabel}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  left: {
    alignItems: "center",
    gap: 12,
    flex: 1,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  label: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
  },
  sublabel: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  right: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
});
