import { create } from "zustand";

import type { Session } from "@/domain/types";

export type ManagementPath =
  "/management/users" | "/management/tenants" | "/management/audit";

export type BusinessTabPath = "/home" | "/sell" | "/history" | "/settings";

export type ContextNavigationIntent =
  | { kind: "management"; path: ManagementPath }
  | { kind: "business"; tenantId: string }
  | { kind: "return"; path?: BusinessTabPath; source?: "users" };

export type ContextDestination =
  ManagementPath | BusinessTabPath | "/users" | "/" | "/contexts";

interface ContextNavigationState {
  ownerId: string | null;
  previousTenantId: string | null;
  requestId: number;
  status: "idle" | "running" | "ready" | "failed";
  intent: ContextNavigationIntent | null;
  destination: ContextDestination | null;
  destinationSessionId: string | null;
  failedSessionId: string | null;
  error: string | null;
}

const initialState: ContextNavigationState = {
  ownerId: null,
  previousTenantId: null,
  requestId: 0,
  status: "idle",
  intent: null,
  destination: null,
  destinationSessionId: null,
  failedSessionId: null,
  error: null,
};

/** Navigation evidence survives route remounts, but never another account/login. */
export const useContextNavigationStore = create<ContextNavigationState>(
  () => initialState,
);

/**
 * The Pengguna tab keeps the bottom-tab shell visible while an explicit chooser
 * or legacy entry exchanges into account context for it. Opening the tab itself
 * runs in the current session, so it never starts this transition.
 */
export function isUsersTabContextTransition(state: ContextNavigationState) {
  if (state.status !== "running" && state.status !== "ready") return false;
  return (
    (state.intent?.kind === "management" &&
      state.intent.path === "/management/users") ||
    (state.intent?.kind === "return" && state.intent.source === "users")
  );
}

export function resetContextNavigation() {
  const requestId = useContextNavigationStore.getState().requestId + 1;
  useContextNavigationStore.setState({ ...initialState, requestId });
}

export function beginContextNavigation(
  session: Session,
  intent: ContextNavigationIntent,
) {
  const current = useContextNavigationStore.getState();
  const sameAccount = current.ownerId === session.user.id;
  if (
    sameAccount &&
    (current.status === "running" || current.status === "ready")
  )
    return null;
  const tenant = !session.contextKind || session.contextKind === "tenant";
  const requestId = current.requestId + 1;
  useContextNavigationStore.setState({
    ownerId: session.user.id,
    previousTenantId: tenant
      ? (session.tenantId ?? null)
      : sameAccount
        ? current.previousTenantId
        : null,
    requestId,
    intent,
    status: "running",
    destination: null,
    destinationSessionId: null,
    failedSessionId: null,
    error: null,
  });
  return requestId;
}

export function completeContextNavigation(
  requestId: number,
  session: Session,
  destination: ContextDestination,
) {
  const current = useContextNavigationStore.getState();
  if (current.requestId !== requestId || current.ownerId !== session.user.id)
    return;
  useContextNavigationStore.setState({
    status: "ready",
    destination,
    destinationSessionId: session.sessionId,
    error: null,
  });
}

export function failContextNavigation(
  requestId: number,
  error: string,
  sessionId: string,
) {
  if (useContextNavigationStore.getState().requestId !== requestId) return;
  useContextNavigationStore.setState({
    status: "failed",
    error,
    failedSessionId: sessionId,
  });
}

export function consumeContextDestination(session: Session) {
  const current = useContextNavigationStore.getState();
  if (
    current.status !== "ready" ||
    current.ownerId !== session.user.id ||
    current.destinationSessionId !== session.sessionId
  )
    return null;
  const destination = current.destination;
  useContextNavigationStore.setState({
    status: "idle",
    intent: null,
    destination: null,
    destinationSessionId: null,
    failedSessionId: null,
  });
  return destination;
}

export function dismissContextNavigationError() {
  useContextNavigationStore.setState({
    status: "idle",
    intent: null,
    error: null,
    failedSessionId: null,
  });
}
