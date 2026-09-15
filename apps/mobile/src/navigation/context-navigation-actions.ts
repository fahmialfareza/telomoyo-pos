import { apiRequest } from "@/api/client";
import type { AuthContextsResponse } from "@/api/contracts";
import { useAuthStore } from "@/auth/auth-store";
import { toUserFacingErrorMessage } from "@/utils/errors";

import {
  beginContextNavigation,
  completeContextNavigation,
  failContextNavigation,
  resetContextNavigation,
  useContextNavigationStore,
  type ContextDestination,
  type ContextNavigationIntent,
} from "./context-navigation-store";

/** Only explicit presses invoke this action. Mounting a screen never retries. */
export async function navigateContext(
  intent: ContextNavigationIntent,
  retry = false,
) {
  const auth = useAuthStore.getState();
  const session = auth.session;
  if (!session || auth.switchingMode) return;
  const requestId = beginContextNavigation(session, intent);
  if (requestId === null) return;
  let destination: ContextDestination = "/";
  try {
    if (session.user.mustChangePassword)
      throw new Error("Ganti kata sandi sementara sebelum melanjutkan.");
    if (intent.kind === "management") {
      if (session.user.role !== "superadmin")
        throw new Error("Pengelolaan hanya tersedia untuk Superadmin.");
      if (session.contextKind !== "account" || retry)
        await auth.switchContext("account");
      // Staff management lives in the bottom tab, while its session remains
      // account-scoped. The old path is an entry alias, not another screen.
      destination = intent.path === "/management/users" ? "/users" : intent.path;
    } else if (intent.kind === "business") {
      const sameBusiness =
        (!session.contextKind || session.contextKind === "tenant") &&
        session.tenantId === intent.tenantId &&
        !auth.scopeLocked &&
        !auth.bootError;
      // Continue the selected business without revoking its session or
      // unexpectedly converting a selected Sandbox back to Production.
      if (!sameBusiness || retry)
        await auth.switchContext("tenant", intent.tenantId);
    } else {
      const previousTenantId =
        useContextNavigationStore.getState().previousTenantId;
      if (!previousTenantId) {
        destination = "/contexts";
      } else {
        const contexts = await apiRequest<AuthContextsResponse>(
          "/auth/contexts",
          { token: session.token },
        );
        if (useAuthStore.getState().session?.sessionId !== session.sessionId)
          throw new Error("Sesi berubah. Pilih bisnis kembali.");
        const allowed = contexts.tenants.some(
          ({ tenant }) =>
            tenant.id === previousTenantId && tenant.status === "active",
        );
        if (allowed) {
          await auth.switchContext("tenant", previousTenantId);
          destination = intent.path ?? "/";
        } else destination = "/contexts";
      }
    }
    const next = useAuthStore.getState();
    // Another login or a newer explicit action owns navigation now. Never let
    // this stale promise clear or complete that account's destination.
    if (useContextNavigationStore.getState().requestId !== requestId) return;
    if (!next.session || next.session.user.id !== session.user.id) {
      resetContextNavigation();
      return;
    }
    if (next.bootError) throw new Error(next.bootError);
    if (destination !== "/contexts" && next.scopeLocked)
      throw new Error("Akses bisnis dihentikan. Pilih bisnis lain.");
    if (
      intent.kind === "management" &&
      (next.session.contextKind !== "account" ||
        next.session.user.role !== "superadmin")
    )
      throw new Error("Konteks pengelolaan belum tersedia. Coba lagi.");
    completeContextNavigation(requestId, next.session, destination);
  } catch (reason) {
    if (useContextNavigationStore.getState().requestId !== requestId) return;
    const currentSession = useAuthStore.getState().session;
    if (!currentSession || currentSession.user.id !== session.user.id) {
      resetContextNavigation();
      return;
    }
    failContextNavigation(
      requestId,
      toUserFacingErrorMessage(
        reason,
        "Perpindahan belum berhasil. Data tetap aman; periksa koneksi lalu coba lagi.",
      ),
      currentSession.sessionId,
    );
  }
}

export async function retryContextNavigation() {
  const state = useContextNavigationStore.getState();
  if (state.status !== "failed" || !state.intent) return;
  const session = useAuthStore.getState().session;
  if (
    !session ||
    session.user.id !== state.ownerId ||
    session.sessionId !== state.failedSessionId
  ) {
    resetContextNavigation();
    return;
  }
  await navigateContext(state.intent, true);
}
