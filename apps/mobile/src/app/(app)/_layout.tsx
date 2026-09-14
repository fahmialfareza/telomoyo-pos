import { Redirect, Stack } from "expo-router";
import { StyleSheet, Text, View } from "react-native";

import { useAuth } from "@/auth/AuthProvider";
import { useContextNavigationStore } from "@/navigation/context-navigation-store";
import {
  useResponsiveStyles,
  useResponsiveTextStyles,
} from "@/theme/responsive";
import { colors, spacing, textStyles } from "@/theme/tokens";

export default function ProtectedLayout() {
  const styles = useResponsiveStyles(baseStyles);
  const textStyles = useResponsiveTextStyles();
  const pendingNavigation = useContextNavigationStore(
    (state) => state.status === "running" || state.status === "ready",
  );
  const { bootError, booting, session, terminalEnrolled, scopeLocked } =
    useAuth();
  if (booting || pendingNavigation) return null;
  if (bootError) {
    return (
      <View style={styles.failure}>
        <Text style={textStyles.title}>Database tidak dapat dibuka</Text>
        <Text style={styles.failureMessage}>
          Penyimpanan terenkripsi untuk mode aktif bermasalah. Jangan hapus data
          sebelum menghubungi dukungan.
        </Text>
        <Text style={styles.code}>{bootError}</Text>
      </View>
    );
  }
  if (!session) return <Redirect href="/(auth)/login" />;
  if (session.user.mustChangePassword) {
    return <Redirect href="/(auth)/change-password" />;
  }
  if (
    scopeLocked ||
    (session.contextKind && session.contextKind !== "tenant")
  ) {
    return <Redirect href="/contexts" />;
  }
  if (!terminalEnrolled) {
    return <Redirect href="/(auth)/terminal-enrollment" />;
  }
  return (
    <Stack
      key={`${session.tenantId}:${session.dataSpaceId}:${session.sessionId}`}
      screenOptions={{ headerShown: false }}
    />
  );
}

const baseStyles = StyleSheet.create({
  failure: {
    flex: 1,
    padding: spacing.lg,
    backgroundColor: colors.surface,
    justifyContent: "center",
    gap: spacing.md,
  },
  failureMessage: { ...textStyles.body, color: colors.textMuted },
  code: { ...textStyles.technical, color: colors.error },
});
