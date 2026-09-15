import type { LoginResponse } from "@/api/contracts";
import { useAuthStore } from "@/auth/auth-store";
import { registerAccessFailureHandler } from "@/api/client";
import {
  INITIAL_TENANT_ID,
  PRODUCTION_DATA_SPACE_ID,
  type Session,
} from "@/domain/types";
import { setModeFromSession, useModeStore } from "@/mode/mode-store";
import { clearAuthNotice } from "@/security/secure-store";
import {
  beginLocalMutation,
  beginModeTransition,
  resetMutationBarrierForTests,
} from "@/mode/mutation-barrier";

const mockNetwork = jest.fn();
const mockApiRequest = jest.fn();
const mockRunSync = jest.fn();
const mockPending = jest.fn();
const mockWriteSession = jest.fn();
const mockPrepare = jest.fn();
const mockMarkScopeRevalidated = jest.fn();
const mockMarkEnrolled = jest.fn();
const mockClearSession = jest.fn();
const mockReadSession = jest.fn();
const mockGetIdentity = jest.fn();
const mockQuarantine = jest.fn();
jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: { fetch: () => mockNetwork() },
}));
jest.mock("@/api/client", () => ({
  registerAccessFailureHandler: jest.fn(),
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
}));
jest.mock("@/db/client", () => ({
  prepareDatabaseForSession: (...args: unknown[]) => mockPrepare(...args),
}));
jest.mock("@/db/repositories", () => ({
  countPendingOutbox: (...args: unknown[]) => mockPending(...args),
  recoverInterruptedPrintAttempts: jest.fn(),
}));
jest.mock("@/security/secure-store", () => ({
  getOrCreateInstallationId: async () => "physical-phone",
  writeSession: (...args: unknown[]) => mockWriteSession(...args),
  clearSession: (...args: unknown[]) => mockClearSession(...args),
  clearAuthNotice: jest.fn(),
  readSession: (...args: unknown[]) => mockReadSession(...args),
  readAuthNotice: jest.fn(),
}));
jest.mock("@/security/terminal-identity", () => ({
  getOrCreateTerminalIdentity: (...args: unknown[]) => mockGetIdentity(...args),
  markTerminalEnrolled: (...args: unknown[]) => mockMarkEnrolled(...args),
  markTerminalRevoked: jest.fn(),
}));
jest.mock("@/sync/engine", () => ({
  runSync: (...args: unknown[]) => mockRunSync(...args),
}));
jest.mock("@/sync/state-handoff", () => ({
  hydrateSyncStateForSession: async () => undefined,
  resetSyncStateForSession: jest.fn(),
}));
jest.mock("@/tenant/quarantine", () => ({
  SCOPE_ACCESS_CODES: new Set(["ACCOUNT_ACCESS_CHANGED"]),
  markScopeRevalidated: (...args: unknown[]) =>
    mockMarkScopeRevalidated(...args),
  blockedScopeReason: async () => null,
  quarantineScope: (...args: unknown[]) => mockQuarantine(...args),
}));
const handleAccessFailure = jest.mocked(registerAccessFailureHandler).mock
  .calls[0]![0];

const original: Session = {
  token: "old-token",
  sessionId: "old-session",
  contextKind: "tenant",
  tenantId: INITIAL_TENANT_ID,
  dataMode: "sandbox",
  dataSpaceId: "00000000-0000-4000-8000-000000000109",
  sandboxGeneration: 9,
  establishedAt: "2026-09-11T00:00:00Z",
  user: {
    id: "staff-a",
    fullName: "Staff A",
    username: "staff",
    role: "superadmin",
    active: true,
    mustChangePassword: false,
  },
};
const targetTenantId = "00000000-0000-4000-8000-000000000201";
const tenantResponse = {
  sessionToken: "next-token",
  sessionId: "next-session",
  contextKind: "tenant",
  tenantId: targetTenantId,
  membershipId: "membership-b",
  isPlatformAdmin: false,
  tenant: {
    id: targetTenantId,
    name: "Bisnis B",
    slug: "bisnis-b",
    status: "active",
  },
  dataMode: "production",
  dataSpaceId: "00000000-0000-4000-8000-000000000301",
  sandboxGeneration: 0,
  user: { ...original.user, role: "admin" },
  terminal: { id: "enrollment-b" },
} as LoginResponse;
const accountResponse = {
  ...tenantResponse,
  sessionToken: "account-token",
  sessionId: "account-session",
  contextKind: "account",
  tenantId: null,
  membershipId: null,
  tenant: null,
  dataMode: null,
  dataSpaceId: null,
  terminal: null,
} as LoginResponse;

describe("authenticated tenant context handoff", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    resetMutationBarrierForTests();
    setModeFromSession(original);
    useAuthStore.setState({
      session: original,
      terminalEnrolled: true,
      scopeLocked: false,
      switchingMode: false,
      booting: false,
      bootError: null,
      notice: null,
    });
    mockNetwork.mockResolvedValue({
      isConnected: true,
      isInternetReachable: true,
    });
    mockApiRequest.mockResolvedValue(tenantResponse);
    mockPending.mockResolvedValue(0);
    mockReadSession.mockResolvedValue(original);
    mockGetIdentity.mockResolvedValue({ serverTerminalId: null });
    mockRunSync.mockResolvedValue({
      pushed: 0,
      pulled: 0,
      conflicts: 0,
      completedAt: "2026-09-11T00:00:00Z",
    });
  });
  afterEach(() => {
    resetMutationBarrierForTests();
    setModeFromSession(null);
  });

  it("holds the handoff until the entire physical-print lease finishes, then drains and enters target Production", async () => {
    const finishPrint = beginLocalMutation(original);
    const switching = useAuthStore
      .getState()
      .switchContext("tenant", targetTenantId);
    expect(useAuthStore.getState().switchingMode).toBe(true);
    await Promise.resolve();
    expect(mockRunSync).not.toHaveBeenCalled();
    expect(mockApiRequest).not.toHaveBeenCalled();
    expect(() => beginLocalMutation(original)).toThrow("Pergantian mode");
    finishPrint();
    await switching;
    expect(mockRunSync).toHaveBeenNthCalledWith(1, original);
    expect(mockPending).toHaveBeenCalledWith(original);
    expect(mockApiRequest).toHaveBeenCalledWith("/auth/switch-context", {
      method: "POST",
      token: original.token,
      body: {
        kind: "tenant",
        tenantId: targetTenantId,
        installationId: "physical-phone",
      },
    });
    const next = useAuthStore.getState().session!;
    expect(next).toMatchObject({
      tenantId: targetTenantId,
      dataMode: "production",
      sandboxGeneration: null,
      membershipId: "membership-b",
      user: { role: "admin" },
    });
    expect(mockWriteSession).toHaveBeenCalledWith(next);
    expect(mockPrepare).toHaveBeenCalledWith(next);
    expect(mockMarkEnrolled).toHaveBeenCalledWith(
      "enrollment-b",
      targetTenantId,
    );
    expect(mockRunSync).toHaveBeenNthCalledWith(2, next);
    expect(mockWriteSession.mock.invocationCallOrder[0]).toBeLessThan(
      mockPrepare.mock.invocationCallOrder[0]!,
    );
    expect(useModeStore.getState()).toMatchObject({
      tenantId: targetTenantId,
      contextKind: "tenant",
      dataMode: "production",
    });
    expect(useAuthStore.getState().switchingMode).toBe(false);
  });

  it.each(["offline", "pending", "failed-sync"])(
    "keeps original credentials and queues on %s",
    async (failure) => {
      if (failure === "offline")
        mockNetwork.mockResolvedValue({ isConnected: false });
      if (failure === "pending") mockPending.mockResolvedValue(2);
      if (failure === "failed-sync")
        mockRunSync.mockRejectedValue(new Error("server offline"));
      await expect(
        useAuthStore.getState().switchContext("tenant", targetTenantId),
      ).rejects.toThrow();
      expect(useAuthStore.getState().session).toBe(original);
      expect(useAuthStore.getState().switchingMode).toBe(false);
      expect(mockApiRequest).not.toHaveBeenCalled();
      expect(mockWriteSession).not.toHaveBeenCalled();
    },
  );

  it("can leave a locked tenant without replaying quarantined work", async () => {
    useAuthStore.setState({ scopeLocked: true });
    useModeStore.setState({ accessBlocked: true });
    await useAuthStore.getState().switchContext("tenant", targetTenantId);
    expect(mockPending).not.toHaveBeenCalled();
    expect(mockRunSync).toHaveBeenCalledTimes(1);
    expect(mockRunSync).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: targetTenantId }),
    );
    expect(mockMarkScopeRevalidated).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: targetTenantId }),
    );
    expect(useAuthStore.getState().scopeLocked).toBe(false);
  });

  it("does not enroll or sync a business when exchanging into account context", async () => {
    mockApiRequest.mockResolvedValue(accountResponse);
    await useAuthStore.getState().switchContext("account");
    expect(useAuthStore.getState().session).toMatchObject({
      contextKind: "account",
      tenantId: null,
      dataSpaceId: null,
    });
    expect(mockRunSync).toHaveBeenCalledTimes(1);
    expect(mockMarkEnrolled).not.toHaveBeenCalled();
    expect(mockGetIdentity).not.toHaveBeenCalled();
    expect(mockMarkScopeRevalidated).not.toHaveBeenCalled();
  });

  it.each(["secure-store", "database"])(
    "hides the revoked old scope when replacement %s setup fails",
    async (failure) => {
      if (failure === "secure-store")
        mockWriteSession.mockRejectedValue(new Error("keystore unavailable"));
      else mockPrepare.mockRejectedValue(new Error("database unavailable"));
      await expect(
        useAuthStore.getState().switchContext("tenant", targetTenantId),
      ).rejects.toThrow();
      expect(useAuthStore.getState().session?.sessionId).toBe("next-session");
      expect(useAuthStore.getState().bootError).toBeTruthy();
      expect(useModeStore.getState().tenantId).toBe(targetTenantId);
      expect(useAuthStore.getState().switchingMode).toBe(false);
    },
  );

  it("retains the replacement session if its initial pull fails", async () => {
    mockRunSync
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("connection lost"));
    await expect(
      useAuthStore.getState().switchContext("tenant", targetTenantId),
    ).rejects.toThrow("connection lost");
    expect(useAuthStore.getState()).toMatchObject({
      session: { sessionId: "next-session" },
      terminalEnrolled: true,
      switchingMode: false,
      bootError: null,
    });
  });

  it("keeps the account chooser for multiple memberships and after password recovery", async () => {
    mockApiRequest
      .mockResolvedValueOnce(accountResponse)
      .mockResolvedValueOnce({
        tenants: [
          { tenant: { id: INITIAL_TENANT_ID, status: "active" } },
          { tenant: { id: targetTenantId, status: "active" } },
        ],
        platformAdmin: false,
      });
    await useAuthStore.getState().login("staff", "test-password");
    expect(useAuthStore.getState().session?.contextKind).toBe("account");
    expect(mockApiRequest).not.toHaveBeenCalledWith(
      "/auth/switch-context",
      expect.anything(),
    );
    mockApiRequest.mockClear();
    mockApiRequest.mockResolvedValueOnce({
      ...accountResponse,
      user: { ...original.user, mustChangePassword: true },
    });
    await useAuthStore.getState().login("staff", "temporary-password");
    expect(mockApiRequest).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().session?.user.mustChangePassword).toBe(true);
  });

  it("automatically selects the sole active membership in Production on normal login", async () => {
    mockApiRequest
      .mockResolvedValueOnce(accountResponse)
      .mockResolvedValueOnce({
        tenants: [{ tenant: { id: targetTenantId, status: "active" } }],
        platformAdmin: false,
      })
      .mockResolvedValueOnce(tenantResponse);
    await useAuthStore.getState().login("staff", "test-password");
    expect(useAuthStore.getState().session).toMatchObject({
      tenantId: targetTenantId,
      dataMode: "production",
    });
    expect(mockPending).not.toHaveBeenCalled();
  });

  it("logs out without deleting business storage and removes the selected context", async () => {
    useAuthStore.setState({
      session: {
        ...original,
        dataMode: "production",
        dataSpaceId: PRODUCTION_DATA_SPACE_ID,
        sandboxGeneration: null,
      },
    });
    await useAuthStore.getState().logout();
    expect(mockClearSession).toHaveBeenCalledTimes(1);
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(useAuthStore.getState().session).toBeNull();
    expect(useModeStore.getState()).toMatchObject({
      contextKind: "account",
      tenantId: null,
      dataMode: "production",
    });
  });

  it("upgrades only after printing completes and drains the unchanged legacy queue before issuing protocol3", async () => {
    const upgraded = {
      ...tenantResponse,
      tenantId: original.tenantId,
      dataMode: "sandbox",
      dataSpaceId: original.dataSpaceId,
      sandboxGeneration: 9,
      protocolVersion: 3,
      sandboxQrisPolicy: "transaction_total",
    } as LoginResponse;
    mockApiRequest.mockResolvedValue(upgraded);
    const finishPrint = beginLocalMutation(original);
    const promise = useAuthStore.getState().upgradeSession();
    await Promise.resolve();
    expect(mockRunSync).not.toHaveBeenCalled();
    finishPrint();
    await promise;
    expect(mockRunSync).toHaveBeenNthCalledWith(1, original);
    expect(mockPending).toHaveBeenCalledWith(original);
    expect(mockApiRequest).toHaveBeenCalledWith("/auth/upgrade-session", {
      method: "POST",
      token: original.token,
      body: { protocolVersion: 3 },
    });
    expect(useAuthStore.getState().session).toMatchObject({
      dataMode: "sandbox",
      dataSpaceId: original.dataSpaceId,
      sandboxGeneration: 9,
      protocolVersion: 3,
      sandboxQrisPolicy: "transaction_total",
    });
    expect(mockRunSync.mock.invocationCallOrder[0]).toBeLessThan(
      mockApiRequest.mock.invocationCallOrder[0]!,
    );
    expect(original.sandboxQrisPolicy).toBeUndefined();
  });

  it.each(["offline", "pending", "failed-sync", "failed-exchange"])(
    "keeps legacy auth and queue evidence after %s during upgrade",
    async (failure) => {
      if (failure === "offline")
        mockNetwork.mockResolvedValue({ isConnected: false });
      if (failure === "pending") mockPending.mockResolvedValue(1);
      if (failure === "failed-sync")
        mockRunSync.mockRejectedValue(new Error("sync unavailable"));
      if (failure === "failed-exchange")
        mockApiRequest.mockRejectedValue(new Error("upgrade unavailable"));
      await expect(useAuthStore.getState().upgradeSession()).rejects.toThrow();
      expect(useAuthStore.getState().session).toBe(original);
      expect(useAuthStore.getState().switchingMode).toBe(false);
      expect(mockWriteSession).not.toHaveBeenCalled();
      expect(mockClearSession).not.toHaveBeenCalled();
    },
  );

  it("quarantines account-revoked work and requires fresh login without deleting databases or signing keys", async () => {
    await handleAccessFailure(original.token, "ACCOUNT_ACCESS_CHANGED");
    expect(mockQuarantine).toHaveBeenCalledWith(
      original,
      "ACCOUNT_ACCESS_CHANGED",
    );
    expect(mockClearSession).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().notice).toContain("Masuk kembali");
    expect(mockRunSync).not.toHaveBeenCalled();
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(mockMarkScopeRevalidated).not.toHaveBeenCalled();
  });

  it("does not clear a newer login after a delayed account quarantine", async () => {
    let complete!: () => void;
    mockQuarantine.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const failure = handleAccessFailure(
      original.token,
      "ACCOUNT_ACCESS_CHANGED",
    );
    const next = {
      ...original,
      token: "fresh-token",
      sessionId: "fresh-session",
    };
    useAuthStore.setState({ session: next, scopeLocked: false });
    setModeFromSession(next);
    complete();
    await failure;
    expect(mockClearSession).not.toHaveBeenCalled();
    expect(useAuthStore.getState().session).toBe(next);
  });

  it.each(["UNAUTHORIZED", "HTTP_401"])(
    "automatically signs out a revoked tenant session for %s while preserving pending work",
    async (code) => {
      mockPending.mockResolvedValue(4);
      await handleAccessFailure(original.token, code);
      expect(mockQuarantine).toHaveBeenCalledWith(original, "SESSION_INVALID");
      expect(mockClearSession).toHaveBeenCalledWith(
        original.token,
        expect.stringContaining("masuk kembali"),
      );
      expect(useAuthStore.getState()).toMatchObject({
        session: null,
        terminalEnrolled: false,
        scopeLocked: false,
        bootError: null,
        notice: expect.stringContaining("belum tersinkron"),
      });
      expect(useModeStore.getState()).toMatchObject({
        contextKind: "account",
        tenantId: null,
        dataMode: "production",
      });
      expect(mockPending).not.toHaveBeenCalled();
      expect(mockRunSync).not.toHaveBeenCalled();
      expect(mockPrepare).not.toHaveBeenCalled();
      expect(mockMarkScopeRevalidated).not.toHaveBeenCalled();
      expect(mockMarkEnrolled).not.toHaveBeenCalled();
    },
  );

  it("automatically signs out account context without touching business storage", async () => {
    const account = {
      ...original,
      contextKind: "account" as const,
      tenantId: null,
      dataSpaceId: null,
    };
    useAuthStore.setState({ session: account, terminalEnrolled: false });
    setModeFromSession(account);
    await handleAccessFailure(account.token, "UNAUTHORIZED");
    expect(useAuthStore.getState().session).toBeNull();
    expect(mockClearSession).toHaveBeenCalledWith(
      account.token,
      expect.any(String),
    );
    expect(mockQuarantine).not.toHaveBeenCalled();
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(mockRunSync).not.toHaveBeenCalled();
  });

  it("allows logout when sync rejects an invalid session even with unsynced entries", async () => {
    mockPending.mockResolvedValue(3);
    mockRunSync.mockRejectedValue({ status: 401, code: "UNAUTHORIZED" });
    await expect(useAuthStore.getState().logout()).resolves.toBeUndefined();
    expect(mockRunSync).toHaveBeenCalledWith(original);
    expect(mockQuarantine).toHaveBeenCalledWith(original, "SESSION_INVALID");
    expect(mockClearSession).toHaveBeenCalledWith(
      original.token,
      expect.any(String),
    );
    expect(mockPending).not.toHaveBeenCalled();
    expect(mockApiRequest).not.toHaveBeenCalled();
    expect(mockMarkScopeRevalidated).not.toHaveBeenCalled();
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(useAuthStore.getState()).toMatchObject({
      session: null,
      switchingMode: false,
    });
  });

  it.each(["UNAUTHORIZED", "HTTP_401"])(
    "allows logout when the logout endpoint already rejects the token with %s",
    async (code) => {
      mockApiRequest.mockRejectedValue({ status: 401, code });
      await expect(useAuthStore.getState().logout()).resolves.toBeUndefined();
      expect(mockApiRequest).toHaveBeenCalledWith("/auth/logout", {
        method: "POST",
        token: original.token,
      });
      expect(mockQuarantine).toHaveBeenCalledWith(original, "SESSION_INVALID");
      expect(mockClearSession).toHaveBeenCalledTimes(1);
      expect(useAuthStore.getState()).toMatchObject({
        session: null,
        switchingMode: false,
      });
    },
  );

  it.each(["network", "forbidden", "pending"])(
    "retains normal logout safeguards for %s instead of treating it as invalid authentication",
    async (failure) => {
      if (failure === "network")
        mockRunSync.mockRejectedValue(new Error("server offline"));
      if (failure === "forbidden")
        mockRunSync.mockRejectedValue({ status: 403, code: "FORBIDDEN" });
      if (failure === "pending") mockPending.mockResolvedValue(1);
      await expect(useAuthStore.getState().logout()).rejects.toBeDefined();
      expect(useAuthStore.getState().session).toBe(original);
      expect(useAuthStore.getState().switchingMode).toBe(false);
      expect(mockClearSession).not.toHaveBeenCalled();
      expect(mockQuarantine).not.toHaveBeenCalled();
    },
  );

  it("ignores an authentication failure belonging to an earlier token", async () => {
    await handleAccessFailure("stale-token", "UNAUTHORIZED");
    expect(useAuthStore.getState().session).toBe(original);
    expect(useAuthStore.getState().scopeLocked).toBe(false);
    expect(mockQuarantine).not.toHaveBeenCalled();
    expect(mockClearSession).not.toHaveBeenCalled();
    expect(mockReadSession).not.toHaveBeenCalled();
  });

  it("does not clear replacement in-memory authentication after delayed secure-store cleanup", async () => {
    let finishClear!: () => void;
    let clearStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      clearStarted = resolve;
    });
    mockClearSession.mockImplementationOnce(() => {
      clearStarted();
      return new Promise<void>((resolve) => {
        finishClear = resolve;
      });
    });
    const invalidation = handleAccessFailure(original.token, "UNAUTHORIZED");
    await started;
    const next = {
      ...original,
      token: "fresh-token",
      sessionId: "fresh-session",
    };
    useAuthStore.setState({ session: next, scopeLocked: false, notice: null });
    setModeFromSession(next);
    finishClear();
    await invalidation;
    expect(mockClearSession).toHaveBeenCalledWith(
      original.token,
      expect.any(String),
    );
    expect(useAuthStore.getState().session).toBe(next);
    expect(useAuthStore.getState().scopeLocked).toBe(false);
    expect(useModeStore.getState().dataSpaceId).toBe(next.dataSpaceId);
  });

  it("coalesces concurrent rejected requests into one quarantine and one conditional clear", async () => {
    let finish!: () => void;
    mockQuarantine.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const first = handleAccessFailure(original.token, "UNAUTHORIZED");
    const second = handleAccessFailure(original.token, "HTTP_401");
    const third = handleAccessFailure(original.token, "UNAUTHORIZED");
    expect(mockQuarantine).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().scopeLocked).toBe(true);
    finish();
    await Promise.all([first, second, third]);
    expect(mockClearSession).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().session).toBeNull();
  });

  it.each(["profile", "password"])(
    "does not persist a successful %s response that resumes while revocation is quarantining work",
    async (operation) => {
      const production = {
        ...original,
        dataMode: "production" as const,
        dataSpaceId: PRODUCTION_DATA_SPACE_ID,
        sandboxGeneration: null,
      };
      useAuthStore.setState({ session: production });
      setModeFromSession(production);
      let finishResponse!: () => void;
      let requestStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        requestStarted = resolve;
      });
      mockApiRequest.mockImplementationOnce(() => {
        requestStarted();
        return new Promise((resolve) => {
          finishResponse = () =>
            resolve({ ...production.user, fullName: "Updated Name" });
        });
      });
      let finishQuarantine!: () => void;
      mockQuarantine.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishQuarantine = resolve;
          }),
      );
      const updating =
        operation === "profile"
          ? useAuthStore.getState().updateProfile("Updated Name")
          : useAuthStore
              .getState()
              .changePassword("old-password", "new-password");
      await started;
      const invalidation = handleAccessFailure(
        production.token,
        "UNAUTHORIZED",
      );
      try {
        expect(useAuthStore.getState().scopeLocked).toBe(true);
        finishResponse();
        await expect(updating).resolves.toBeUndefined();
        expect(mockWriteSession).not.toHaveBeenCalled();
        expect(mockPrepare).not.toHaveBeenCalled();
        expect(useAuthStore.getState().session).toBe(production);
        expect(useAuthStore.getState().scopeLocked).toBe(true);
        expect(useModeStore.getState().accessBlocked).toBe(true);
      } finally {
        finishQuarantine();
        await invalidation;
      }
      expect(useAuthStore.getState().session).toBeNull();
      expect(mockClearSession).toHaveBeenCalledWith(
        production.token,
        expect.any(String),
      );
    },
  );

  it.each(["profile", "password"])(
    "does not restore a revoked %s session when database preparation finishes after persistence",
    async (operation) => {
      const production = {
        ...original,
        dataMode: "production" as const,
        dataSpaceId: PRODUCTION_DATA_SPACE_ID,
        sandboxGeneration: null,
      };
      useAuthStore.setState({ session: production });
      setModeFromSession(production);
      mockApiRequest.mockResolvedValueOnce({
        ...production.user,
        fullName: "Updated Name",
      });
      let finishPrepare!: () => void;
      let prepareStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        prepareStarted = resolve;
      });
      mockPrepare.mockImplementationOnce(() => {
        prepareStarted();
        return new Promise<void>((resolve) => {
          finishPrepare = resolve;
        });
      });
      const updating =
        operation === "profile"
          ? useAuthStore.getState().updateProfile("Updated Name")
          : useAuthStore
              .getState()
              .changePassword("old-password", "new-password");
      await started;
      expect(mockWriteSession).toHaveBeenCalledTimes(1);
      await handleAccessFailure(production.token, "UNAUTHORIZED");
      expect(useAuthStore.getState().session).toBeNull();
      finishPrepare();
      await expect(updating).rejects.toThrow("Sesi");
      expect(mockWriteSession).toHaveBeenCalledTimes(1);
      expect(useAuthStore.getState()).toMatchObject({
        session: null,
        terminalEnrolled: false,
        bootError: null,
        notice: expect.stringContaining("masuk kembali"),
      });
      expect(useModeStore.getState()).toMatchObject({
        contextKind: "account",
        tenantId: null,
        dataMode: "production",
      });
    },
  );

  it.each(["switch", "upgrade"])(
    "retains the reauthentication notice when a %s replacement is revoked during its initial sync",
    async (operation) => {
      mockApiRequest.mockResolvedValueOnce(
        operation === "switch"
          ? tenantResponse
          : {
              ...tenantResponse,
              tenantId: original.tenantId,
              dataMode: "sandbox",
              dataSpaceId: original.dataSpaceId,
              sandboxGeneration: original.sandboxGeneration,
              protocolVersion: 3,
              sandboxQrisPolicy: "transaction_total",
            },
      );
      mockRunSync
        .mockResolvedValueOnce({})
        .mockImplementationOnce(async (session: Session) => {
          await handleAccessFailure(session.token, "UNAUTHORIZED");
          throw { status: 401, code: "UNAUTHORIZED" };
        });
      const changing =
        operation === "switch"
          ? useAuthStore.getState().switchContext("tenant", targetTenantId)
          : useAuthStore.getState().upgradeSession();
      await expect(changing).rejects.toMatchObject({
        status: 401,
        code: "UNAUTHORIZED",
      });
      expect(mockQuarantine).toHaveBeenCalledWith(
        expect.objectContaining({ token: tenantResponse.sessionToken }),
        "SESSION_INVALID",
      );
      expect(useAuthStore.getState()).toMatchObject({
        session: null,
        terminalEnrolled: false,
        scopeLocked: false,
        switchingMode: false,
        notice: expect.stringContaining("masuk kembali"),
      });
      expect(useAuthStore.getState().notice).not.toContain(
        "Konteks sudah berganti",
      );
      expect(useAuthStore.getState().notice).not.toContain(
        "Sesi baru sudah diterbitkan",
      );
      expect(useModeStore.getState().tenantId).toBeNull();
    },
  );

  it("does not erase a new revocation notice when login notice cleanup resumes", async () => {
    mockApiRequest.mockResolvedValueOnce(accountResponse);
    let finishNoticeClear!: () => void;
    let noticeClearStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      noticeClearStarted = resolve;
    });
    jest.mocked(clearAuthNotice).mockImplementationOnce(() => {
      noticeClearStarted();
      return new Promise<void>((resolve) => {
        finishNoticeClear = resolve;
      });
    });
    const loggingIn = useAuthStore.getState().login("staff", "test-password");
    await started;
    expect(clearAuthNotice).toHaveBeenCalledWith(accountResponse.sessionToken);
    await handleAccessFailure(accountResponse.sessionToken, "UNAUTHORIZED");
    finishNoticeClear();
    await expect(loggingIn).rejects.toThrow("Sesi");
    expect(useAuthStore.getState()).toMatchObject({
      session: null,
      terminalEnrolled: false,
      scopeLocked: false,
      notice: expect.stringContaining("masuk kembali"),
    });
    expect(mockApiRequest).toHaveBeenCalledTimes(1);
    expect(mockQuarantine).not.toHaveBeenCalled();
  });

  it.each(["local", "transition"])(
    "invalidates without deadlocking when its request already holds a real %s lease",
    async (kind) => {
      const release =
        kind === "local"
          ? beginLocalMutation(original)
          : (await beginModeTransition()).release;
      try {
        await handleAccessFailure(original.token, "UNAUTHORIZED");
        expect(useAuthStore.getState().session).toBeNull();
        expect(mockQuarantine).toHaveBeenCalledTimes(1);
      } finally {
        release();
      }
    },
  );

  it.each([
    "FORBIDDEN",
    "NETWORK_ERROR",
    "HTTP_500",
    "SANDBOX_GENERATION_RETIRED",
    "SANDBOX_DISABLED",
  ])("does not auto-logout for %s", async (code) => {
    await handleAccessFailure(original.token, code);
    expect(useAuthStore.getState().session).toBe(original);
    expect(useAuthStore.getState().scopeLocked).toBe(false);
    expect(mockClearSession).not.toHaveBeenCalled();
    expect(mockQuarantine).not.toHaveBeenCalled();
  });

  it("keeps invalid access locked with recovery feedback if quarantining evidence fails", async () => {
    mockQuarantine.mockRejectedValue(new Error("database unavailable"));
    await expect(
      handleAccessFailure(original.token, "UNAUTHORIZED"),
    ).rejects.toThrow("database unavailable");
    expect(useAuthStore.getState()).toMatchObject({
      session: original,
      scopeLocked: true,
      bootError: expect.stringContaining("Jangan hapus data aplikasi"),
    });
    expect(useModeStore.getState().accessBlocked).toBe(true);
    expect(mockClearSession).not.toHaveBeenCalled();
    expect(mockMarkScopeRevalidated).not.toHaveBeenCalled();
  });

  it("finishes headless invalidation even when hydration finishes before quarantine", async () => {
    useAuthStore.setState({
      session: null,
      booting: true,
      terminalEnrolled: false,
    });
    setModeFromSession(null);
    let finishQuarantine!: () => void;
    let quarantineStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      quarantineStarted = resolve;
    });
    mockQuarantine.mockImplementationOnce(() => {
      quarantineStarted();
      return new Promise<void>((resolve) => {
        finishQuarantine = resolve;
      });
    });
    const invalidation = handleAccessFailure(original.token, "UNAUTHORIZED");
    await started;
    useAuthStore.setState({ booting: false });
    finishQuarantine();
    await invalidation;
    expect(mockClearSession).toHaveBeenCalledWith(
      original.token,
      expect.any(String),
    );
    expect(useAuthStore.getState()).toMatchObject({
      session: null,
      booting: false,
      scopeLocked: false,
      notice: expect.stringContaining("masuk kembali"),
    });
  });

  it("invalidates a headless durable session without letting in-flight hydration restore it", async () => {
    useAuthStore.setState({
      session: null,
      booting: true,
      terminalEnrolled: false,
    });
    setModeFromSession(null);
    let finishPrepare!: () => void;
    let prepareStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      prepareStarted = resolve;
    });
    mockPrepare.mockImplementationOnce(() => {
      prepareStarted();
      return new Promise<void>((resolve) => {
        finishPrepare = resolve;
      });
    });
    const hydration = useAuthStore.getState().hydrate();
    await started;
    await handleAccessFailure(original.token, "UNAUTHORIZED");
    finishPrepare();
    await hydration;
    expect(mockReadSession).toHaveBeenCalledTimes(2);
    expect(mockQuarantine).toHaveBeenCalledWith(original, "SESSION_INVALID");
    expect(mockClearSession).toHaveBeenCalledWith(
      original.token,
      expect.any(String),
    );
    expect(useAuthStore.getState()).toMatchObject({
      session: null,
      booting: false,
      bootError: null,
      notice: expect.stringContaining("masuk kembali"),
    });
    expect(useModeStore.getState()).toMatchObject({
      contextKind: "account",
      tenantId: null,
    });
  });
});
