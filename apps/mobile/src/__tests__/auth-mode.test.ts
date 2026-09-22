import NetInfo from "@react-native-community/netinfo";

import type { LoginResponse } from "@/api/contracts";
import { useAuthStore } from "@/auth/auth-store";
import type { Session } from "@/domain/types";

const mockApiRequest = jest.fn();
const mockPrepareDatabaseForSession = jest.fn();
const mockCountPendingOutbox = jest.fn();
const mockRunSync = jest.fn();
const mockWriteSession = jest.fn();
const mockClearSession = jest.fn();
const mockSetModeFromSession = jest.fn();
const mockIsSandboxGenerationRetired = jest.fn();
const mockRetireSandboxSession = jest.fn();
const mockRecoverRetiredSandboxGeneration = jest.fn();
const mockBeginModeTransition = jest.fn();
const mockReleaseModeTransition = jest.fn();
const mockModeTransitionLease = {
  id: Symbol("test-mode-transition"),
  release: mockReleaseModeTransition,
};
const mockHydrateSyncStateForSession = jest.fn();
const mockResetSyncStateForSession = jest.fn();

jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: { fetch: jest.fn() },
}));

jest.mock("@/api/client", () => ({
  registerAccessFailureHandler: jest.fn(),
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
}));

jest.mock("@/db/client", () => ({
  prepareDatabaseForSession: (...args: unknown[]) =>
    mockPrepareDatabaseForSession(...args),
}));

jest.mock("@/db/repositories", () => ({
  countPendingOutbox: (...args: unknown[]) => mockCountPendingOutbox(...args),
  recoverInterruptedPrintAttempts: jest.fn(),
}));

jest.mock("@/mode/mode-store", () => ({
  setModeFromSession: (...args: unknown[]) => mockSetModeFromSession(...args),
}));

jest.mock("@/mode/mutation-barrier", () => ({
  beginModeSafeLocalAccess: async () => () => undefined,
  MODE_TRANSITION_BUSY_MESSAGE:
    "Pergantian mode sedang berlangsung. Tunggu hingga selesai sebelum mengubah data.",
  beginModeTransition: (...args: unknown[]) => mockBeginModeTransition(...args),
}));

jest.mock("@/mode/recovery", () => ({
  SANDBOX_RECOVERY_ERROR:
    "Mode Uji telah direset, tetapi pemulihan otomatis belum berhasil. Data Mode Uji lama sudah dibersihkan. Silakan masuk kembali untuk melanjutkan.",
  SANDBOX_RETIRED_MESSAGE:
    "Mode Uji telah direset oleh superadmin. Data Mode Uji lama sudah dibersihkan dari perangkat. Masuk kembali, lalu aktifkan Mode Uji untuk memuat generasi terbaru.",
  isSandboxGenerationRetired: (...args: unknown[]) =>
    mockIsSandboxGenerationRetired(...args),
  recoverRetiredSandboxGeneration: (...args: unknown[]) =>
    mockRecoverRetiredSandboxGeneration(...args),
  retireSandboxSession: (...args: unknown[]) =>
    mockRetireSandboxSession(...args),
}));

jest.mock("@/security/secure-store", () => ({
  clearAuthNotice: jest.fn(),
  clearSession: (...args: unknown[]) => mockClearSession(...args),
  readAuthNotice: jest.fn(),
  readSession: jest.fn(),
  writeSession: (...args: unknown[]) => mockWriteSession(...args),
}));

jest.mock("@/security/terminal-identity", () => ({
  getOrCreateTerminalIdentity: jest.fn(),
  getTerminalPublicKeyBase64: jest.fn(),
  markTerminalEnrolled: jest.fn(),
  markTerminalRevoked: jest.fn(),
}));

jest.mock("@/sync/engine", () => ({
  runSync: (...args: unknown[]) => mockRunSync(...args),
}));

jest.mock("@/sync/state-handoff", () => ({
  hydrateSyncStateForSession: (...args: unknown[]) =>
    mockHydrateSyncStateForSession(...args),
  resetSyncStateForSession: (...args: unknown[]) =>
    mockResetSyncStateForSession(...args),
}));

const productionSession: Session = {
  token: "production-token",
  sessionId: "PRODUCTION-SESSION",
  establishedAt: "2026-09-05T00:00:00.000Z",
  dataMode: "production",
  dataSpaceId: "00000000-0000-4000-8000-000000000100",
  sandboxGeneration: null,
  user: {
    id: "USER-1",
    fullName: "Putu",
    username: "putu",
    role: "admin",
    active: true,
    mustChangePassword: false,
  },
};

const sandboxResponse = {
  sessionToken: "sandbox-token",
  sessionId: "SANDBOX-SESSION",
  dataMode: "sandbox",
  dataSpaceId: "00000000-0000-4000-8000-000000000200",
  sandboxGeneration: 7,
  user: productionSession.user,
  terminal: null,
} as LoginResponse;

const recoveredSandboxSession: Session = {
  ...productionSession,
  token: "sandbox-token-8",
  sessionId: "SANDBOX-SESSION-8",
  dataMode: "sandbox",
  dataSpaceId: "00000000-0000-4000-8000-000000000208",
  sandboxGeneration: 8,
};

const recoverySummary = {
  pushed: 0,
  pulled: 4,
  conflicts: 0,
  completedAt: "2026-09-05T01:00:00.000Z",
};

describe("authentication mode switching", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (NetInfo.fetch as jest.Mock).mockResolvedValue({
      isConnected: true,
      isInternetReachable: true,
    });
    mockRunSync.mockResolvedValue({
      pushed: 0,
      pulled: 0,
      conflicts: 0,
      completedAt: "2026-09-05T00:00:00.000Z",
    });
    mockCountPendingOutbox.mockResolvedValue(0);
    mockPrepareDatabaseForSession.mockResolvedValue(undefined);
    mockWriteSession.mockResolvedValue(undefined);
    mockClearSession.mockResolvedValue(undefined);
    mockIsSandboxGenerationRetired.mockReturnValue(false);
    mockRetireSandboxSession.mockResolvedValue(undefined);
    mockRecoverRetiredSandboxGeneration.mockImplementation(
      async (
        _session: Session,
        _targetMode: string,
        beforeExposure?: (result: unknown) => Promise<void>,
      ) => {
        const result = {
          session: recoveredSandboxSession,
          summary: recoverySummary,
          terminalEnrolled: true,
          notice: "Mode Uji otomatis dipulihkan.",
        };
        await beforeExposure?.(result);
        return result;
      },
    );
    mockBeginModeTransition.mockResolvedValue(mockModeTransitionLease);
    mockHydrateSyncStateForSession.mockResolvedValue(undefined);
    useAuthStore.setState({
      session: productionSession,
      bootError: null,
      notice: null,
      switchingMode: false,
      terminalEnrolled: true,
    });
  });

  it("drains Production, exchanges the session, prepares Sandbox, and pulls it", async () => {
    mockApiRequest.mockResolvedValueOnce(sandboxResponse);

    await useAuthStore.getState().switchMode("sandbox");

    expect(mockRunSync).toHaveBeenNthCalledWith(1, productionSession);
    expect(mockCountPendingOutbox).toHaveBeenCalledWith(productionSession);
    expect(mockApiRequest).toHaveBeenCalledWith("/auth/switch-mode", {
      method: "POST",
      token: productionSession.token,
      body: { mode: "sandbox" },
    });
    expect(mockPrepareDatabaseForSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "SANDBOX-SESSION",
        dataMode: "sandbox",
        sandboxGeneration: 7,
      }),
    );
    expect(mockWriteSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "SANDBOX-SESSION" }),
    );
    expect(mockSetModeFromSession).toHaveBeenCalledWith(
      expect.objectContaining({ dataMode: "sandbox" }),
    );
    expect(mockRunSync).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sessionId: "SANDBOX-SESSION" }),
    );
    expect(mockHydrateSyncStateForSession).toHaveBeenCalledWith(
      expect.objectContaining({ dataSpaceId: sandboxResponse.dataSpaceId }),
      expect.objectContaining({ completedAt: "2026-09-05T00:00:00.000Z" }),
    );
    expect(useAuthStore.getState().session).toMatchObject({
      sessionId: "SANDBOX-SESSION",
      dataMode: "sandbox",
      sandboxGeneration: 7,
    });
    expect(useAuthStore.getState().switchingMode).toBe(false);
  });

  it("does not expose the target data space before its sync metadata is hydrated", async () => {
    mockApiRequest.mockResolvedValueOnce(sandboxResponse);
    let resolveHydration: () => void = () => undefined;
    let announceHydration: () => void = () => undefined;
    const hydrationStarted = new Promise<void>((resolve) => {
      announceHydration = resolve;
    });
    mockHydrateSyncStateForSession.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveHydration = resolve;
          announceHydration();
        }),
    );

    const switching = useAuthStore.getState().switchMode("sandbox");
    await hydrationStarted;

    expect(useAuthStore.getState().session).toEqual(productionSession);
    expect(mockSetModeFromSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ dataSpaceId: sandboxResponse.dataSpaceId }),
    );

    resolveHydration();
    await switching;

    expect(useAuthStore.getState().session?.dataSpaceId).toBe(
      sandboxResponse.dataSpaceId,
    );
  });

  it("durably saves the replacement before opening its database and never restores the revoked session", async () => {
    mockApiRequest.mockResolvedValueOnce(sandboxResponse);
    const databaseFailure = new Error("database unavailable");
    mockPrepareDatabaseForSession.mockRejectedValueOnce(databaseFailure);

    await expect(useAuthStore.getState().switchMode("sandbox")).rejects.toThrow(
      "Mode operasi sudah berhasil diganti",
    );

    expect(mockWriteSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "SANDBOX-SESSION" }),
    );
    expect(mockWriteSession.mock.invocationCallOrder[0]).toBeLessThan(
      mockPrepareDatabaseForSession.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(useAuthStore.getState().session).toMatchObject({
      sessionId: "SANDBOX-SESSION",
      dataMode: "sandbox",
    });
    expect(useAuthStore.getState().bootError).toContain(
      "Penyimpanan terenkripsi",
    );
    expect(mockRunSync).toHaveBeenCalledTimes(1);
  });

  it("keeps the new session when its initial pull must be retried", async () => {
    mockApiRequest.mockResolvedValueOnce(sandboxResponse);
    mockRunSync
      .mockResolvedValueOnce({
        pushed: 0,
        pulled: 0,
        conflicts: 0,
        completedAt: "2026-09-05T00:00:00.000Z",
      })
      .mockRejectedValueOnce(new Error("network lost during initial pull"));

    await expect(useAuthStore.getState().switchMode("sandbox")).rejects.toThrow(
      "Sesi baru tetap tersimpan",
    );

    expect(useAuthStore.getState().session).toMatchObject({
      sessionId: "SANDBOX-SESSION",
      dataMode: "sandbox",
    });
    expect(mockWriteSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "SANDBOX-SESSION" }),
    );
  });

  it("prepares the new generation before exposing a replacement that cannot be persisted", async () => {
    mockApiRequest.mockResolvedValueOnce(sandboxResponse);
    mockWriteSession.mockRejectedValue(new Error("secure store locked"));

    await expect(useAuthStore.getState().switchMode("sandbox")).rejects.toThrow(
      "belum dapat disimpan",
    );

    expect(mockClearSession).toHaveBeenCalledTimes(1);
    expect(mockPrepareDatabaseForSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "SANDBOX-SESSION",
        sandboxGeneration: 7,
      }),
    );
    expect(mockSetModeFromSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "SANDBOX-SESSION" }),
    );
    expect(useAuthStore.getState().session).toMatchObject({
      token: "sandbox-token",
      sessionId: "SANDBOX-SESSION",
      dataMode: "sandbox",
    });
  });

  it("recovers a transient secure-store failure before completing the switch", async () => {
    mockApiRequest.mockResolvedValueOnce(sandboxResponse);
    mockWriteSession
      .mockRejectedValueOnce(new Error("secure store temporarily locked"))
      .mockResolvedValueOnce(undefined);

    await expect(
      useAuthStore.getState().switchMode("sandbox"),
    ).resolves.toBeUndefined();

    expect(mockClearSession).toHaveBeenCalledTimes(1);
    expect(mockWriteSession).toHaveBeenCalledTimes(2);
    expect(mockPrepareDatabaseForSession).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxGeneration: 7 }),
    );
    expect(mockRunSync).toHaveBeenCalledTimes(2);
    expect(useAuthStore.getState()).toMatchObject({
      session: expect.objectContaining({ sessionId: "SANDBOX-SESSION" }),
      bootError: null,
      switchingMode: false,
    });
  });

  it("automatically re-enters the latest Sandbox generation when reset wins the initial pull", async () => {
    const retired = {
      code: "SANDBOX_GENERATION_RETIRED",
      message: "Sandbox generation retired",
    };
    mockApiRequest.mockResolvedValueOnce(sandboxResponse);
    mockRunSync
      .mockResolvedValueOnce({
        pushed: 0,
        pulled: 0,
        conflicts: 0,
        completedAt: "2026-09-05T00:00:00.000Z",
      })
      .mockRejectedValueOnce(retired);
    mockIsSandboxGenerationRetired.mockImplementation(
      (error: unknown) =>
        (error as { code?: string }).code === "SANDBOX_GENERATION_RETIRED",
    );

    await expect(
      useAuthStore.getState().switchMode("sandbox"),
    ).resolves.toBeUndefined();

    expect(mockRecoverRetiredSandboxGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "SANDBOX-SESSION",
        dataMode: "sandbox",
      }),
      "sandbox",
      expect.any(Function),
      { transitionLease: mockModeTransitionLease },
    );
    expect(useAuthStore.getState()).toMatchObject({
      session: {
        sessionId: "SANDBOX-SESSION-8",
        sandboxGeneration: 8,
      },
      terminalEnrolled: true,
      notice: "Mode Uji otomatis dipulihkan.",
      switchingMode: false,
    });
    expect(
      mockRecoverRetiredSandboxGeneration.mock.invocationCallOrder[0],
    ).toBeGreaterThan(mockRunSync.mock.invocationCallOrder[1] ?? 0);
    expect(mockHydrateSyncStateForSession).toHaveBeenLastCalledWith(
      recoveredSandboxSession,
      recoverySummary,
    );
  });

  it("falls back to login when automatic Sandbox recovery cannot finish", async () => {
    const sandboxSession: Session = {
      ...productionSession,
      token: "sandbox-token",
      sessionId: "SANDBOX-SESSION-7",
      dataMode: "sandbox",
      dataSpaceId: sandboxResponse.dataSpaceId,
      sandboxGeneration: 7,
    };
    const retired = {
      code: "SANDBOX_GENERATION_RETIRED",
      message: "Sandbox generation retired",
    };
    useAuthStore.setState({ session: sandboxSession });
    mockRunSync.mockRejectedValueOnce(retired);
    mockIsSandboxGenerationRetired.mockReturnValue(true);
    mockRecoverRetiredSandboxGeneration.mockRejectedValueOnce(
      new Error("Pemulihan otomatis gagal"),
    );

    await expect(
      useAuthStore.getState().switchMode("production"),
    ).rejects.toThrow("Pemulihan otomatis gagal");

    expect(useAuthStore.getState()).toMatchObject({
      session: null,
      terminalEnrolled: false,
      notice: expect.stringContaining("pemulihan otomatis belum berhasil"),
      bootError: null,
      switchingMode: false,
    });
  });

  it("does not revoke the current session while unresolved outbox data remains", async () => {
    mockCountPendingOutbox.mockResolvedValueOnce(1);

    await expect(useAuthStore.getState().switchMode("sandbox")).rejects.toThrow(
      "Masih ada perubahan",
    );

    expect(mockApiRequest).not.toHaveBeenCalled();
    expect(mockPrepareDatabaseForSession).not.toHaveBeenCalled();
    expect(useAuthStore.getState().session).toEqual(productionSession);
    expect(useAuthStore.getState().switchingMode).toBe(false);
  });

  it("returns from a disabled Sandbox without draining or deleting its pending outbox", async () => {
    const sandboxSession: Session = {
      ...productionSession,
      token: "sandbox-token",
      sessionId: "SANDBOX-SESSION",
      dataMode: "sandbox",
      dataSpaceId: sandboxResponse.dataSpaceId,
      sandboxGeneration: 7,
    };
    const productionResponse = {
      ...sandboxResponse,
      sessionToken: "production-token-2",
      sessionId: "PRODUCTION-SESSION-2",
      dataMode: "production",
      dataSpaceId: productionSession.dataSpaceId,
      sandboxGeneration: 0,
    } as LoginResponse;
    useAuthStore.setState({ session: sandboxSession });
    mockRunSync
      .mockRejectedValueOnce({
        status: 403,
        code: "SANDBOX_DISABLED",
        message: "Mode Uji dinonaktifkan",
      })
      .mockResolvedValueOnce(recoverySummary);
    mockApiRequest.mockResolvedValueOnce(productionResponse);

    await expect(
      useAuthStore.getState().switchMode("production"),
    ).resolves.toBeUndefined();

    expect(mockCountPendingOutbox).not.toHaveBeenCalled();
    expect(mockClearSession).not.toHaveBeenCalled();
    expect(mockApiRequest).toHaveBeenCalledWith("/auth/switch-mode", {
      method: "POST",
      token: sandboxSession.token,
      body: { mode: "production" },
    });
    expect(useAuthStore.getState()).toMatchObject({
      session: { dataMode: "production", sessionId: "PRODUCTION-SESSION-2" },
      notice: expect.stringContaining("antrean Mode Uji tetap tersimpan"),
    });
  });

  it("waits for an active pull before clearing the session even when the outbox is empty", async () => {
    let resolveSync: (value: typeof recoverySummary) => void = () => {
      throw new Error("Sync resolver was not initialized.");
    };
    let announceSync: () => void = () => undefined;
    const syncStarted = new Promise<void>((resolve) => {
      announceSync = resolve;
    });
    mockRunSync.mockImplementationOnce(
      () =>
        new Promise<typeof recoverySummary>((resolve) => {
          resolveSync = resolve;
          announceSync();
        }),
    );
    mockApiRequest.mockResolvedValueOnce(undefined);

    const loggingOut = useAuthStore.getState().logout();
    await syncStarted;

    expect(mockApiRequest).not.toHaveBeenCalled();
    expect(mockClearSession).not.toHaveBeenCalled();

    resolveSync(recoverySummary);
    await expect(loggingOut).resolves.toBeUndefined();

    expect(mockRunSync).toHaveBeenCalledWith(productionSession);
    expect(mockCountPendingOutbox).toHaveBeenCalledWith(productionSession);
    expect(mockApiRequest).toHaveBeenCalledWith("/auth/logout", {
      method: "POST",
      token: productionSession.token,
    });
    expect(mockClearSession).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().session).toBeNull();
  });

  it("finishes logout as Production recovery when Sandbox retires during its drain", async () => {
    const sandboxSession: Session = {
      ...productionSession,
      token: "sandbox-token",
      sessionId: "SANDBOX-SESSION",
      dataMode: "sandbox",
      dataSpaceId: sandboxResponse.dataSpaceId,
      sandboxGeneration: 7,
    };
    const retired = {
      code: "SANDBOX_GENERATION_RETIRED",
      message: "Sandbox generation retired",
    };
    useAuthStore.setState({ session: sandboxSession });
    mockCountPendingOutbox.mockResolvedValueOnce(1);
    mockRunSync.mockRejectedValueOnce(retired);
    mockIsSandboxGenerationRetired.mockReturnValue(true);

    await expect(useAuthStore.getState().logout()).resolves.toBeUndefined();

    expect(mockRetireSandboxSession).toHaveBeenCalledWith(sandboxSession);
    expect(mockResetSyncStateForSession).toHaveBeenCalledWith(null);
    expect(mockApiRequest).not.toHaveBeenCalled();
    expect(useAuthStore.getState()).toMatchObject({
      session: null,
      terminalEnrolled: false,
      switchingMode: false,
    });
    expect(mockReleaseModeTransition).toHaveBeenCalledTimes(1);
  });
});
