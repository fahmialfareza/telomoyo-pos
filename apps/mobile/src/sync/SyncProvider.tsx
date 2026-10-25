import NetInfo from "@react-native-community/netinfo";
import { AppState, type AppStateStatus } from "react-native";
import { useEffect, useRef, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";

import { useAuthStore } from "@/auth/auth-store";

import { registerBackgroundSync } from "./background";
import { useSyncStore, type SyncStore } from "./sync-store";

type SyncRuntime = Omit<SyncStore, "setOnline">;

export const FOREGROUND_SYNC_INTERVAL_MS = 60_000;

const selectSyncRuntime = (state: SyncStore): SyncRuntime => ({
  dataSpaceId: state.dataSpaceId,
  online: state.online,
  syncing: state.syncing,
  pendingCount: state.pendingCount,
  lastSyncedAt: state.lastSyncedAt,
  lastError: state.lastError,
  lastSummary: state.lastSummary,
  refresh: state.refresh,
  syncNow: state.syncNow,
});

// RN 0.88 types currentState as a plain nullable string.
function toAppStateStatus(value: string | null | undefined): AppStateStatus {
  return value === "active" ||
    value === "background" ||
    value === "inactive" ||
    value === "extension"
    ? value
    : "unknown";
}

function runForegroundSync(appState: AppStateStatus) {
  if (
    appState !== "active" ||
    !useAuthStore.getState().session ||
    !useSyncStore.getState().online
  ) {
    return;
  }
  void useSyncStore
    .getState()
    .syncNow()
    .catch(() => undefined);
}

function ensureBackgroundSyncRegistered() {
  void registerBackgroundSync().catch(() => {
    // Retry on the next foreground activation. Manual and foreground sync remain available.
  });
}

export function SyncProvider({ children }: { children: ReactNode }) {
  const sessionId = useAuthStore((state) => state.session?.sessionId);
  const refresh = useSyncStore((state) => state.refresh);
  const appState = useRef(toAppStateStatus(AppState.currentState));

  useEffect(() => {
    ensureBackgroundSyncRegistered();
  }, []);

  useEffect(() => {
    const unsubscribeNetwork = NetInfo.addEventListener((state) => {
      const connected =
        Boolean(state.isConnected) && state.isInternetReachable !== false;
      const becameOnline = connected && !useSyncStore.getState().online;
      useSyncStore.getState().setOnline(connected);
      if (becameOnline) runForegroundSync(appState.current);
    });
    const subscription = AppState.addEventListener(
      "change",
      (nextState: AppStateStatus) => {
        const resumed =
          Boolean(appState.current.match(/inactive|background/)) &&
          nextState === "active";
        appState.current = nextState;
        if (resumed) {
          void useSyncStore.getState().refresh();
          ensureBackgroundSyncRegistered();
          runForegroundSync(nextState);
        }
      },
    );
    const interval = setInterval(() => {
      runForegroundSync(appState.current);
    }, FOREGROUND_SYNC_INTERVAL_MS);

    return () => {
      unsubscribeNetwork();
      subscription.remove();
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (sessionId) {
      void refresh();
      runForegroundSync(appState.current);
    }
  }, [refresh, sessionId]);

  return <>{children}</>;
}

export function useSyncRuntime(): SyncRuntime {
  return useSyncStore(useShallow(selectSyncRuntime));
}
