import { Redirect } from "expo-router";

import { useAuth } from "@/auth/AuthProvider";
import { useContextNavigationStore } from "@/navigation/context-navigation-store";

export default function IndexRoute() {
  const { booting, session, terminalEnrolled, scopeLocked } = useAuth();
  const pendingNavigation = useContextNavigationStore(
    (state) => state.status === "running" || state.status === "ready",
  );
  if (pendingNavigation) return null;
  if (booting) return null;
  if (!session) return <Redirect href="/(auth)/login" />;
  if (session.user.mustChangePassword) {
    return <Redirect href="/(auth)/change-password" />;
  }
  if (scopeLocked || session.contextKind === "account")
    return <Redirect href="/contexts" />;
  if (session.contextKind === "platform") return <Redirect href="/contexts" />;
  if (!terminalEnrolled) {
    return <Redirect href="/(auth)/terminal-enrollment" />;
  }
  return <Redirect href="/(app)/(tabs)/home" />;
}
