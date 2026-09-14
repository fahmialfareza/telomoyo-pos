import { usePathname, useRootNavigationState, useRouter } from "expo-router";
import { useEffect, useRef } from "react";
import { Modal, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAuthStore } from "@/auth/auth-store";
import { Button } from "@/components/ui/Button";
import { colors, spacing } from "@/theme/tokens";
import {
  useResponsiveStyles,
  useResponsiveTextStyles,
} from "@/theme/responsive";

import {
  navigateContext,
  retryContextNavigation,
} from "./context-navigation-actions";
import {
  consumeContextDestination,
  dismissContextNavigationError,
  resetContextNavigation,
  useContextNavigationStore,
  type ManagementPath,
} from "./context-navigation-store";

const openManagement = (path: ManagementPath) =>
  navigateContext({ kind: "management", path });
const openBusiness = (tenantId: string) =>
  navigateContext({ kind: "business", tenantId });
const returnToBusiness = () => navigateContext({ kind: "return" });

export function useContextNavigation() {
  const running = useContextNavigationStore(
    (state) => state.status === "running" || state.status === "ready",
  );
  const switching = useAuthStore((state) => state.switchingMode);
  return {
    busy: running || switching,
    openManagement,
    openBusiness,
    returnToBusiness,
    retry: retryContextNavigation,
    dismissError: dismissContextNavigationError,
  };
}

/** Mounted above AppRoutes, so sign-out also discards previous-account intent. */
export function ContextNavigationLifecycle() {
  useEffect(() => {
    const validate = (
      auth: ReturnType<typeof useAuthStore.getState>,
      previous?: ReturnType<typeof useAuthStore.getState>,
    ) => {
      const navigation = useContextNavigationStore.getState();
      if (!navigation.ownerId) return;
      // Subscribe synchronously, so a sign-out/sign-in with the same account
      // cannot be hidden by a batched React render. Exchanges deliberately
      // change sessions while switchingMode is true and retain their intent.
      const unrelatedSessionChange =
        previous &&
        previous.session?.sessionId !== auth.session?.sessionId &&
        !previous.switchingMode &&
        !auth.switchingMode;
      if (
        navigation.ownerId !== auth.session?.user.id ||
        unrelatedSessionChange
      )
        resetContextNavigation();
    };
    validate(useAuthStore.getState());
    return useAuthStore.subscribe(validate);
  }, []);
  return null;
}

/** Mounted alongside the Stack only after the authenticated exchange finishes. */
export function ContextNavigationCoordinator() {
  const router = useRouter();
  const navigationState = useRootNavigationState();
  const pathname = usePathname();
  const dispatchedRequest = useRef<number | null>(null);
  const session = useAuthStore((state) => state.session);
  const switching = useAuthStore((state) => state.switchingMode);
  const status = useContextNavigationStore((state) => state.status);
  const requestId = useContextNavigationStore((state) => state.requestId);
  useEffect(() => {
    if (switching || !navigationState?.key || !session || status !== "ready")
      return;
    const pending = useContextNavigationStore.getState();
    if (
      pending.ownerId !== session.user.id ||
      pending.destinationSessionId !== session.sessionId ||
      !pending.destination
    )
      return;
    if (dispatchedRequest.current !== requestId) {
      dispatchedRequest.current = requestId;
      router.replace(pending.destination);
    }
    // Keep old route guards suppressed until the router commits the target.
    // Consuming first lets the old layout redirect to the chooser mid-exchange.
    if (pathname === pending.destination) consumeContextDestination(session);
  }, [
    navigationState?.key,
    pathname,
    requestId,
    router,
    session,
    status,
    switching,
  ]);
  return null;
}

/** Failure feedback outlives the screen that initiated the exchange. */
export function ContextNavigationFeedback() {
  const router = useRouter();
  const status = useContextNavigationStore((state) => state.status);
  const error = useContextNavigationStore((state) => state.error);
  const session = useAuthStore((state) => state.session);
  const locked = useAuthStore((state) => state.scopeLocked);
  const bootError = useAuthStore((state) => state.bootError);
  const enrolled = useAuthStore((state) => state.terminalEnrolled);
  const styles = useResponsiveStyles(baseStyles);
  const textStyles = useResponsiveTextStyles();
  const insets = useSafeAreaInsets();
  const canOpenSync =
    session &&
    !locked &&
    !bootError &&
    enrolled &&
    (!session.contextKind || session.contextKind === "tenant");

  return (
    <Modal
      transparent
      visible={status === "failed" && Boolean(session)}
      animationType="fade"
      onRequestClose={dismissContextNavigationError}
    >
      <View
        style={[
          styles.overlay,
          { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 },
        ]}
      >
        <View accessibilityViewIsModal style={styles.card}>
          <ScrollView contentContainerStyle={styles.content}>
            <Text accessibilityRole="header" style={textStyles.heading}>
              Belum dapat berpindah
            </Text>
            <Text accessibilityRole="alert" style={textStyles.body}>
              {error}
            </Text>
            <Button onPress={() => void retryContextNavigation()}>
              Coba lagi
            </Button>
            {canOpenSync ? (
              <Button
                variant="secondary"
                onPress={() => {
                  dismissContextNavigationError();
                  router.push("/(app)/sync");
                }}
              >
                Buka Pusat Sinkron
              </Button>
            ) : null}
            <Button variant="danger" onPress={dismissContextNavigationError}>
              Batal
            </Button>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const baseStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "center",
    paddingHorizontal: spacing.md,
  },
  card: {
    width: "100%",
    maxWidth: 600,
    maxHeight: "100%",
    alignSelf: "center",
    backgroundColor: colors.card,
    borderRadius: 16,
  },
  content: { padding: spacing.md, gap: spacing.sm },
});
