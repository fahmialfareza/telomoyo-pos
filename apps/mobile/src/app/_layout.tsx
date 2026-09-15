import { JetBrainsMono_500Medium } from "@expo-google-fonts/jetbrains-mono/500Medium";
import { Roboto_400Regular } from "@expo-google-fonts/roboto/400Regular";
import { Roboto_500Medium } from "@expo-google-fonts/roboto/500Medium";
import { Roboto_600SemiBold } from "@expo-google-fonts/roboto/600SemiBold";
import { Roboto_700Bold } from "@expo-google-fonts/roboto/700Bold";
import { Roboto_800ExtraBold } from "@expo-google-fonts/roboto/800ExtraBold";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { AuthProvider } from "@/auth/AuthProvider";
import { useAuthStore } from "@/auth/auth-store";
import { SyncProvider } from "@/sync/SyncProvider";
import { ConfirmationProvider } from "@/components/ui/ConfirmationProvider";
import {
  ContextNavigationCoordinator,
  ContextNavigationFeedback,
  ContextNavigationLifecycle,
} from "@/navigation/context-navigation";
import {
  isUsersTabContextTransition,
  useContextNavigationStore,
} from "@/navigation/context-navigation-store";
import {
  useResponsiveStyles,
  useResponsiveTextStyles,
} from "@/theme/responsive";
import { colors, spacing, textStyles } from "@/theme/tokens";

void SplashScreen.preventAutoHideAsync();

function AppRoutes() {
  const styles = useResponsiveStyles(baseStyles);
  const textStyles = useResponsiveTextStyles();
  // Keep the router tree unmounted for the full transition, including the
  // brief interval before recovery clears the retired session. This prevents
  // redirects to Login and stale screen reads while SQLite changes scope.
  const transitioningMode = useAuthStore(
    (state) => state.switchingOperationMode,
  );
  const usersTabTransition = useContextNavigationStore(
    isUsersTabContextTransition,
  );

  if (transitioningMode && !usersTabTransition) {
    return (
      <View accessibilityRole="alert" style={styles.recovery}>
        <ActivityIndicator color={colors.primary} size="large" />
        <Text style={textStyles.heading}>Menyiapkan Mode Operasi</Text>
        <Text style={styles.recoveryMessage}>
          Mengamankan data lokal dan menyinkronkan ruang data aktif. Jangan
          tutup aplikasi.
        </Text>
      </View>
    );
  }

  return (
    <>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(app)" />
      </Stack>
      <ContextNavigationCoordinator />
      <ContextNavigationFeedback />
    </>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Roboto_400Regular,
    Roboto_500Medium,
    Roboto_600SemiBold,
    Roboto_700Bold,
    Roboto_800ExtraBold,
    JetBrainsMono_500Medium,
  });
  useEffect(() => {
    if (fontsLoaded || fontError) {
      void SplashScreen.hideAsync();
    }
  }, [fontError, fontsLoaded]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <KeyboardProvider>
        <AuthProvider>
          <ConfirmationProvider>
            <ContextNavigationLifecycle />
            <SyncProvider>
              <StatusBar style="light" />
              <AppRoutes />
            </SyncProvider>
          </ConfirmationProvider>
        </AuthProvider>
      </KeyboardProvider>
    </SafeAreaProvider>
  );
}

const baseStyles = StyleSheet.create({
  recovery: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
    padding: spacing.xl,
    backgroundColor: colors.surface,
  },
  recoveryMessage: {
    ...textStyles.body,
    maxWidth: 360,
    color: colors.textMuted,
    textAlign: "center",
  },
});
