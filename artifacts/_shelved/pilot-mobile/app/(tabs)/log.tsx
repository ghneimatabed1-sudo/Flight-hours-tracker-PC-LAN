import { Feather } from "@expo/vector-icons";
import React from "react";
import {
  FlatList,
  Platform,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SortieRow } from "@/components/SortieRow";
import { useColors } from "@/hooks/useColors";
import { useAppData } from "@/lib/data";
import { useI18n } from "@/lib/i18n";

export default function LogScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { t, isRTL } = useI18n();
  const { snapshot, refresh, refreshing } = useAppData();

  if (!snapshot) return null;

  const topPad = (Platform.OS === "web" ? 67 : insets.top) + 12;
  const sorties = [...snapshot.sorties].sort((a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : 0
  );

  return (
    <FlatList
      data={sorties}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => <SortieRow sortie={item} />}
      ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={[styles.content, { paddingTop: topPad }]}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void refresh()}
          tintColor={colors.primary}
        />
      }
      ListHeaderComponent={
        <Text
          style={[
            styles.title,
            { color: colors.foreground, textAlign: isRTL ? "right" : "left" },
          ]}
        >
          {t("log_title")}
        </Text>
      }
      ListEmptyComponent={
        <View style={styles.empty}>
          <Feather name="inbox" size={32} color={colors.mutedForeground} />
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
            {t("log_empty")}
          </Text>
        </View>
      }
    />
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 18,
    paddingBottom: 120,
    gap: 0,
  },
  title: {
    fontSize: 26,
    fontFamily: "Inter_700Bold",
    marginBottom: 14,
  },
  empty: {
    alignItems: "center",
    paddingVertical: 60,
    gap: 10,
  },
  emptyText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
  },
});
