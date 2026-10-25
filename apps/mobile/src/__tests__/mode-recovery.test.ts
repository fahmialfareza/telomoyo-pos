import type { Session } from "@/domain/types";
import {
  beginModeTransition,
  resetMutationBarrierForTests,
} from "@/mode/mutation-barrier";
import {
  isSandboxGenerationRetired,
  recoverRetiredSandboxGeneration,
  resetSandboxRecoveryForTests,
  retireSandboxSession,
  SANDBOX_RECOVERED_MESSAGE,
  SANDBOX_RECOVERY_TARGET_CONFLICT_MESSAGE,
  SANDBOX_RETIRED_MESSAGE,
} from "@/mode/recovery";

const mockApiRequest = jest.fn();
const mockClearLocalDatabase = jest.fn();
const mockPrepareDatabaseForSession = jest.fn();
const mockClearSession = jest.fn();
const mockWriteAuthNotice = jest.fn();
const mockWriteSession = jest.fn();
const mockSetModeFromSession = jest.fn();
const mockRunSync = jest.fn();

jest.mock("@/api/client", () => ({
  ApiError: class MockApiError extends Error {
    code = "API_ERROR";
  },
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
}));

jest.mock("@/db/client", () => ({
  clearLocalDatabase: (...args: unknown[]) => mockClearLocalDatabase(...args),
  prepareDatabaseForSession: (...args: unknown[]) =>
    mockPrepareDatabaseForSession(...args),
}));

jest.mock("@/security/secure-store", () => ({
  clearSession: (...args: unknown[]) => mockClearSession(...args),
  writeAuthNotice: (...args: unknown[]) => mockWriteAuthNotice(...args),
  writeSession: (...args: unknown[]) => mockWriteSession(...args),
}));

jest.mock("@/mode/mode-store", () => ({
  setModeFromSession: (...args: unknown[]) => mockSetModeFromSession(...args),
}));

jest.mock("@/security/terminal-identity", () => ({
  // The device holds the key of the terminal returned by switch-mode.
  bindServerTerminal: jest.fn(async () => true),
}));
jest.mock("@/sync/engine", () => ({
  runSync: (...args: unknown[]) => mockRunSync(...args),
}));

const sandboxSession: Session = {
  token: "sandbox-token",
  sessionId: "SANDBOX-SESSION-7",
  establishedAt: "2026-09-05T00:00:00.000Z",
  dataMode: "sandbox",
  dataSpaceId: "00000000-0000-4000-8000-000000000207",
  sandboxGeneration: 7,
  user: {
    id: "USER-1",
    fullName: "Putu",
    username: "putu",
    role: "admin",
    active: true,
    mustChangePassword: false,
  },
};

const replacementResponse = {
  sessionToken: "sandbox-token-8",
  sessionId: "SANDBOX-SESSION-8",
  dataMode: "sandbox",
  dataSpaceId: "00000000-0000-4000-8000-000000000208",
  sandboxGeneration: 8,
  user: sandboxSession.user,
  terminal: { id: "TERMINAL-1" },
};

const syncSummary = {
  pushed: 0,
  pulled: 3,
  conflicts: 0,
  completedAt: "2026-09-05T01:00:00.000Z",
};

describe("retired Sandbox recovery", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetSandboxRecoveryForTests();
    resetMutationBarrierForTests();
    mockClearLocalDatabase.mockResolvedValue(undefined);
    mockClearSession.mockResolvedValue(undefined);
    mockWriteAuthNotice.mockResolvedValue(undefined);
    mockWriteSession.mockResolvedValue(undefined);
    mockPrepareDatabaseForSession.mockResolvedValue(undefined);
    mockApiRequest.mockResolvedValue(replacementResponse);
    mockRunSync.mockResolvedValue(syncSummary);
  });

  afterEach(() => {
    resetSandboxRecoveryForTests();
    resetMutationBarrierForTests();
  });

  it("recognizes serialized retired-generation errors by their stable code", () => {
    expect(
      isSandboxGenerationRetired({
        code: "SANDBOX_GENERATION_RETIRED",
        message: "reset",
      }),
    ).toBe(true);
    expect(isSandboxGenerationRetired(new Error("reset"))).toBe(false);
  });

  it("clears only the Sandbox database and records a login notice", async () => {
    await retireSandboxSession(sandboxSession);

    expect(mockClearSession).toHaveBeenCalledTimes(1);
    expect(mockSetModeFromSession).toHaveBeenCalledWith(null);
    expect(mockClearLocalDatabase).toHaveBeenCalledWith(sandboxSession);
    expect(mockClearLocalDatabase).not.toHaveBeenCalledWith("production");
    expect(mockWriteAuthNotice).toHaveBeenCalledWith(SANDBOX_RETIRED_MESSAGE);
  });

  it("still isolates and clears Sandbox when secure-session deletion fails", async () => {
    const secureStoreFailure = new Error("secure store unavailable");
    mockClearSession.mockRejectedValueOnce(secureStoreFailure);

    await expect(retireSandboxSession(sandboxSession)).rejects.toBe(
      secureStoreFailure,
    );

    expect(mockSetModeFromSession).toHaveBeenCalledWith(null);
    expect(mockClearLocalDatabase).toHaveBeenCalledWith(sandboxSession);
    expect(mockWriteAuthNotice).toHaveBeenCalledWith(SANDBOX_RETIRED_MESSAGE);
  });

  it("never clears Production for a non-Sandbox session", async () => {
    await retireSandboxSession({
      ...sandboxSession,
      dataMode: "production",
      sandboxGeneration: null,
    });

    expect(mockClearSession).not.toHaveBeenCalled();
    expect(mockClearLocalDatabase).not.toHaveBeenCalled();
  });

  it("rotates into the active generation and syncs it before exposure", async () => {
    const beforeExposure = jest.fn().mockResolvedValue(undefined);

    await expect(
      recoverRetiredSandboxGeneration(
        sandboxSession,
        "sandbox",
        beforeExposure,
      ),
    ).resolves.toMatchObject({
      session: {
        token: "sandbox-token-8",
        sessionId: "SANDBOX-SESSION-8",
        dataMode: "sandbox",
        sandboxGeneration: 8,
      },
      summary: syncSummary,
      terminalEnrolled: true,
      notice: SANDBOX_RECOVERED_MESSAGE,
    });

    expect(mockClearLocalDatabase).toHaveBeenCalledWith(sandboxSession);
    expect(mockClearLocalDatabase).not.toHaveBeenCalledWith("production");
    expect(mockApiRequest).toHaveBeenCalledWith("/auth/switch-mode", {
      method: "POST",
      token: sandboxSession.token,
      body: { mode: "sandbox" },
    });
    expect(mockWriteSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "SANDBOX-SESSION-8" }),
    );
    expect(mockPrepareDatabaseForSession).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxGeneration: 8 }),
    );
    expect(mockRunSync).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "SANDBOX-SESSION-8" }),
    );
    expect(beforeExposure).toHaveBeenCalledWith(
      expect.objectContaining({ summary: syncSummary }),
    );
    expect(mockRunSync.mock.invocationCallOrder[0]).toBeLessThan(
      beforeExposure.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mockWriteAuthNotice).toHaveBeenCalledWith(SANDBOX_RECOVERED_MESSAGE);
  });

  it("falls back to login and still never clears Production when recovery fails", async () => {
    const failure = new Error("recovery endpoint unavailable");
    mockApiRequest.mockRejectedValueOnce(failure);

    await expect(
      recoverRetiredSandboxGeneration(sandboxSession),
    ).rejects.toThrow("Silakan masuk kembali");

    expect(mockClearSession).toHaveBeenCalledTimes(1);
    expect(mockClearLocalDatabase).toHaveBeenCalledWith(sandboxSession);
    expect(mockClearLocalDatabase).not.toHaveBeenCalledWith("production");
    expect(mockWriteSession).not.toHaveBeenCalled();
    expect(mockSetModeFromSession).toHaveBeenLastCalledWith(null);
    expect(mockWriteAuthNotice).toHaveBeenLastCalledWith(
      expect.stringContaining("pemulihan otomatis belum berhasil"),
    );
  });

  it("does not expose a replacement if scoped state hydration fails", async () => {
    const beforeExposure = jest
      .fn()
      .mockRejectedValueOnce(new Error("metadata unavailable"));

    await expect(
      recoverRetiredSandboxGeneration(
        sandboxSession,
        "sandbox",
        beforeExposure,
      ),
    ).rejects.toThrow("Silakan masuk kembali");

    expect(mockRunSync).toHaveBeenCalledTimes(1);
    expect(mockClearSession).toHaveBeenCalledTimes(1);
    expect(mockSetModeFromSession).toHaveBeenLastCalledWith(null);
  });

  it("shares one server rotation between concurrent observers", async () => {
    let resolveResponse: (value: typeof replacementResponse) => void = () =>
      undefined;
    let announceRequest: () => void = () => undefined;
    const requestStarted = new Promise<void>((resolve) => {
      announceRequest = resolve;
    });
    mockApiRequest.mockImplementationOnce(
      () =>
        new Promise<typeof replacementResponse>((resolve) => {
          resolveResponse = resolve;
          announceRequest();
        }),
    );
    const firstExposure = jest.fn().mockResolvedValue(undefined);
    const secondExposure = jest.fn().mockResolvedValue(undefined);

    const first = recoverRetiredSandboxGeneration(
      sandboxSession,
      "sandbox",
      firstExposure,
    );
    const second = recoverRetiredSandboxGeneration(
      sandboxSession,
      "sandbox",
      secondExposure,
    );
    await requestStarted;
    resolveResponse(replacementResponse);

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(mockApiRequest).toHaveBeenCalledTimes(1);
    expect(mockClearLocalDatabase).toHaveBeenCalledTimes(1);
    expect(firstExposure).toHaveBeenCalledTimes(1);
    expect(secondExposure).toHaveBeenCalledTimes(1);
  });

  it("rejects a conflicting destination instead of silently following it", async () => {
    let resolveResponse: (value: typeof replacementResponse) => void = () =>
      undefined;
    let announceRequest: () => void = () => undefined;
    const requestStarted = new Promise<void>((resolve) => {
      announceRequest = resolve;
    });
    mockApiRequest.mockImplementationOnce(
      () =>
        new Promise<typeof replacementResponse>((resolve) => {
          resolveResponse = resolve;
          announceRequest();
        }),
    );

    const sandboxRecovery = recoverRetiredSandboxGeneration(
      sandboxSession,
      "sandbox",
    );
    await requestStarted;

    await expect(
      recoverRetiredSandboxGeneration(sandboxSession, "production"),
    ).rejects.toThrow(SANDBOX_RECOVERY_TARGET_CONFLICT_MESSAGE);

    resolveResponse(replacementResponse);
    await expect(sandboxRecovery).resolves.toBeDefined();
    expect(mockApiRequest).toHaveBeenCalledTimes(1);
  });

  it("lets the verified transition owner replace a blocked observer entry", async () => {
    const transitionLease = await beginModeTransition();
    const blockedObserver = recoverRetiredSandboxGeneration(
      sandboxSession,
      "sandbox",
    );

    const ownerRecovery = recoverRetiredSandboxGeneration(
      sandboxSession,
      "production",
      undefined,
      { transitionLease },
    );

    await expect(blockedObserver).rejects.toThrow(
      "Pergantian mode sedang berlangsung",
    );
    await expect(ownerRecovery).resolves.toMatchObject({
      session: { sessionId: "SANDBOX-SESSION-8" },
    });
    expect(mockApiRequest).toHaveBeenCalledTimes(1);
    expect(mockApiRequest).toHaveBeenCalledWith("/auth/switch-mode", {
      method: "POST",
      token: sandboxSession.token,
      body: { mode: "production" },
    });
    expect(mockClearLocalDatabase).toHaveBeenCalledTimes(1);

    transitionLease.release();
  });
});
