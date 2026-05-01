import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Notifications from "expo-notifications";
import { Stack, useRouter } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect, useRef } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import WingsIntro from "@/components/WingsIntro";
import { AppDataProvider } from "@/lib/data";
import { I18nProvider } from "@/lib/i18n";
import { configureNotificationHandler } from "@/lib/notifications";
import { reportRuntimeError } from "@/lib/runtimeErrorReporter";

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient();

function RootLayoutNav() {
  const router = useRouter();
  const lastHandled = useRef<string | null>(null);

  useEffect(() => {
    configureNotificationHandler();

    // Tap on a notification while the app is running.
    const tapSub = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        const data = response.notification.request.content.data as
          | { deepLink?: string; type?: string }
          | undefined;
        const link =
          (typeof data?.deepLink === "string" && data.deepLink) ||
          (data?.type === "currency_expiry" ? "/currency" : null);
        if (link && lastHandled.current !== response.notification.request.identifier) {
          lastHandled.current = response.notification.request.identifier;
          // Defer one tick so the navigator is mounted before we navigate.
          setTimeout(() => {
            try {
              // The currency tab lives inside the (tabs) group.
              router.push(link as never);
            } catch {
              // Swallow nav errors; the user can still navigate manually.
            }
          }, 50);
        }
      }
    );

    // App opened from a quit state by tapping a notification.
    Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (!response) return;
        const data = response.notification.request.content.data as
          | { deepLink?: string; type?: string }
          | undefined;
        const link =
          (typeof data?.deepLink === "string" && data.deepLink) ||
          (data?.type === "currency_expiry" ? "/currency" : null);
        if (link && lastHandled.current !== response.notification.request.identifier) {
          lastHandled.current = response.notification.request.identifier;
          setTimeout(() => {
            try {
              router.push(link as never);
            } catch {
              // ignore
            }
          }, 200);
        }
      })
      .catch(() => {});

    return () => {
      tapSub.remove();
    };
  }, [router]);

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="link" options={{ presentation: "modal" }} />
      <Stack.Screen name="reminders" options={{ presentation: "modal" }} />
      <Stack.Screen name="lock" options={{ gestureEnabled: false }} />
      <Stack.Screen name="setup-lock" />
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });
  const [introDone, setIntroDone] = React.useState(false);

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <ErrorBoundary
        onError={(error, stack) => {
          // Task #265 Part F — surface mobile crashes centrally so the
          // super_admin can triage them from the Audit Log page.
          reportRuntimeError(error, {
            source: "errorBoundary",
            componentStack: stack,
          });
        }}
      >
        <QueryClientProvider client={queryClient}>
          <GestureHandlerRootView>
            <KeyboardProvider>
              <I18nProvider>
                <AppDataProvider>
                  <RootLayoutNav />
                  {!introDone && <WingsIntro onDone={() => setIntroDone(true)} />}
                </AppDataProvider>
              </I18nProvider>
            </KeyboardProvider>
          </GestureHandlerRootView>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
