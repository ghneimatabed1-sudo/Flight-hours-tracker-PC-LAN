import { Feather } from "@expo/vector-icons";
import { Redirect, Tabs } from "expo-router";
import React from "react";
import { Platform, StyleSheet, View } from "react-native";

import { useColors } from "@/hooks/useColors";
import { useAppData } from "@/lib/data";
import { useI18n } from "@/lib/i18n";

export default function TabLayout() {
  const colors = useColors();
  const { t } = useI18n();
  const { ready, link, hasPassword, unlocked } = useAppData();
  const isWeb = Platform.OS === "web";

  if (!ready) return null;
  if (!link) return <Redirect href="/link" />;
  // Local device-lock gate. A pilot who has never created a password is
  // sent to /setup-lock; a pilot who has one but has not unlocked this
  // session is sent to /lock.
  if (!hasPassword) return <Redirect href={"/setup-lock" as never} />;
  if (!unlocked) return <Redirect href={"/lock" as never} />;

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.mutedForeground,
        headerShown: false,
        sceneStyle: { backgroundColor: colors.background },
        tabBarStyle: {
          backgroundColor: colors.card,
          borderTopColor: colors.border,
          borderTopWidth: StyleSheet.hairlineWidth,
          elevation: 0,
          ...(isWeb ? { height: 84, paddingBottom: 34 } : {}),
        },
        tabBarBackground: () => (
          <View
            style={[StyleSheet.absoluteFill, { backgroundColor: colors.card }]}
          />
        ),
        tabBarLabelStyle: { fontFamily: "Inter_500Medium", fontSize: 11 },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t("tab_home"),
          tabBarIcon: ({ color }) => (
            <Feather name="home" size={22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="currency"
        options={{
          title: t("tab_currency"),
          tabBarIcon: ({ color }) => (
            <Feather name="shield" size={22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="log"
        options={{
          title: t("tab_log"),
          tabBarIcon: ({ color }) => (
            <Feather name="list" size={22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="notams"
        options={{
          title: t("tab_notams"),
          tabBarIcon: ({ color }) => (
            <Feather name="alert-triangle" size={22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="alerts"
        options={{
          title: t("tab_alerts"),
          tabBarIcon: ({ color }) => (
            <Feather name="bell" size={22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: t("tab_settings"),
          tabBarIcon: ({ color }) => (
            <Feather name="settings" size={22} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
