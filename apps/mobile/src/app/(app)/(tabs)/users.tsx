import {
  Redirect,
  useFocusEffect,
  useLocalSearchParams,
  useRouter,
} from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { BackHandler } from "react-native";

import { useAuth } from "@/auth/AuthProvider";
import {
  ManagedUserCreateScreen,
  ManagedUserEditor,
  ManagedUsersScreen,
} from "@/tenant/screens";

type UserPane =
  { kind: "directory" } | { kind: "create" } | { kind: "edit"; id: string };

/** Directory, creation, and account edits all remain inside the Pengguna tab. */
export default function UsersTabScreen() {
  const { session } = useAuth();
  const params = useLocalSearchParams<{ userId?: string; create?: string }>();
  if (!session) return <Redirect href="/(auth)/login" />;
  if (session.user.role !== "superadmin") return <Redirect href="/" />;
  return (
    <AccountUsersTab
      key={`${session.sessionId}:${params.userId ?? ""}:${params.create ?? ""}`}
    />
  );
}

function AccountUsersTab() {
  const params = useLocalSearchParams<{ userId?: string; create?: string }>();
  const router = useRouter();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [pane, setPane] = useState<UserPane>(() =>
    params.create === "true"
      ? { kind: "create" }
      : params.userId
        ? { kind: "edit", id: params.userId }
        : { kind: "directory" },
  );
  const currentPane = useRef(pane);
  const changePane = useCallback((next: UserPane) => {
    currentPane.current = next;
    setPane(next);
  }, []);
  const directory = useCallback(() => {
    if (!mounted.current) return;
    router.setParams({ userId: undefined, create: undefined });
    changePane({ kind: "directory" });
  }, [changePane, router]);
  useFocusEffect(
    useCallback(() => {
      const listener = BackHandler.addEventListener("hardwareBackPress", () => {
        if (pane.kind !== "directory") directory();
        else return false;
        return true;
      });
      return () => listener.remove();
    }, [directory, pane.kind]),
  );

  if (pane.kind === "create") {
    return (
      <ManagedUserCreateScreen
        onDone={() => {
          if (currentPane.current === pane) directory();
        }}
        onCancel={directory}
      />
    );
  }
  if (pane.kind === "edit") {
    return <ManagedUserEditor key={pane.id} id={pane.id} onBack={directory} />;
  }
  return (
    <ManagedUsersScreen
      onCreate={() => changePane({ kind: "create" })}
      onOpenUser={(id) => changePane({ kind: "edit", id })}
    />
  );
}
