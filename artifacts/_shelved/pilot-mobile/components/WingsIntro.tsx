import React, { useEffect, useRef } from "react";
import {
  Animated,
  Easing,
  Image,
  Pressable,
  StyleSheet,
  Text,
} from "react-native";

import { useColors } from "@/hooks/useColors";

type Props = {
  onDone: () => void;
  durationMs?: number;
};

// Brief Hawk Eye brand intro shown right after the OS splash (which
// displays the RJAF emblem). Fades the pilot wings + Hawk Eye wordmark
// in, holds, then fades out before the main app (activation / link
// flow) takes over. Tap anywhere to skip.
export default function WingsIntro({ onDone, durationMs = 1800 }: Props) {
  const colors = useColors();
  const opacity = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.92)).current;

  useEffect(() => {
    const fadeIn = Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 450,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(scale, {
        toValue: 1,
        duration: 650,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]);

    const fadeOut = Animated.timing(opacity, {
      toValue: 0,
      duration: 350,
      easing: Easing.in(Easing.quad),
      useNativeDriver: true,
    });

    fadeIn.start();
    const holdMs = Math.max(0, durationMs - 450 - 350);
    const t = setTimeout(() => {
      fadeOut.start(({ finished }) => {
        if (finished) onDone();
      });
    }, 450 + holdMs);

    return () => clearTimeout(t);
  }, [opacity, scale, durationMs, onDone]);

  const skip = () => {
    Animated.timing(opacity, {
      toValue: 0,
      duration: 180,
      easing: Easing.in(Easing.quad),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) onDone();
    });
  };

  return (
    <Pressable
      onPress={skip}
      style={[
        StyleSheet.absoluteFillObject,
        styles.container,
        { backgroundColor: colors.background },
      ]}
    >
      <Animated.View style={{ opacity, transform: [{ scale }] }}>
        <Image
          source={require("../assets/images/emblem.png")}
          style={styles.logo}
          resizeMode="contain"
        />
        <Text style={[styles.title, { color: colors.foreground }]}>
          HAWK EYE
        </Text>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  },
  logo: {
    width: 160,
    height: 160,
    alignSelf: "center",
  },
  title: {
    marginTop: 20,
    fontSize: 18,
    fontWeight: "700",
    letterSpacing: 1,
    textAlign: "center",
  },
  subtitle: {
    marginTop: 4,
    fontSize: 14,
    textAlign: "center",
  },
});
