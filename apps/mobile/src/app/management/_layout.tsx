import { Redirect, Stack, useFocusEffect, usePathname } from "expo-router";
import { useCallback } from "react";
import { BackHandler } from "react-native";
import { useAuth } from "@/auth/AuthProvider";
import { canManageOrganization } from "@/domain/permissions";
import { useContextNavigation } from "@/navigation/context-navigation";
import { useContextNavigationStore } from "@/navigation/context-navigation-store";

export default function ManagementLayout() {
  const pathname = usePathname();
  const { returnToBusiness } = useContextNavigation();
  const pendingNavigation = useContextNavigationStore(
    (state) => state.status === "running" || state.status === "ready",
  );
  useFocusEffect(
    useCallback(() => {
      if (
        pathname !== "/management/users" &&
        pathname !== "/management/tenants" &&
        pathname !== "/management/audit"
      )
        return;
      const listener = BackHandler.addEventListener("hardwareBackPress", () => {
        void returnToBusiness();
        return true;
      });
      return () => listener.remove();
    }, [pathname, returnToBusiness]),
  );
  const { session, booting, bootError, scopeLocked } = useAuth();
  if (booting || pendingNavigation) return null;
  if (!session) return <Redirect href="/(auth)/login" />;
  if (session.user.mustChangePassword)
    return <Redirect href="/(auth)/change-password" />;
  if (bootError || scopeLocked || !canManageOrganization(session))
    return <Redirect href="/contexts" />;
  return (
    <Stack key={session.sessionId} screenOptions={{ headerShown: false }} />
  );
}
