import {
  clearAuthNotice,
  clearSession,
  writeSession,
} from "@/security/secure-store";
import type { Session } from "@/domain/types";

const mockStorage = new Map<string, string>();
const mockWrite = jest.fn(async (key: string, value: string) => {
  mockStorage.set(key, value);
});
const mockDelete = jest.fn(async (key: string) => {
  mockStorage.delete(key);
});
jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "device-only",
  getItemAsync: async (key: string) => mockStorage.get(key) ?? null,
  setItemAsync: (...args: [string, string]) => mockWrite(...args),
  deleteItemAsync: (key: string) => mockDelete(key),
}));

const original = {
  sessionId: "old-session",
  token: "old-token",
  sandboxQrisPolicy: "fixed_1000",
} as Session;
const replacement = {
  sessionId: "new-session",
  token: "new-token",
  sandboxQrisPolicy: "transaction_total",
} as Session;
const sessionKey = "sewa-motor.session.v1";
const noticeKey = "sewa-motor.auth-notice.v1";

describe("serialized session persistence", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStorage.clear();
  });

  it("does not delete a new account when delayed revocation clears the old token", async () => {
    await writeSession(original);
    await Promise.all([
      writeSession(replacement),
      clearSession(original.token),
    ]);
    expect(JSON.parse(mockStorage.get(sessionKey)!)).toEqual(replacement);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("does not restore an old policy or context from a background profile refresh", async () => {
    await writeSession(original);
    await Promise.all([
      writeSession(replacement),
      writeSession(original, original.sessionId),
    ]);
    expect(JSON.parse(mockStorage.get(sessionKey)!)).toEqual(replacement);
  });

  it("still clears the exact revoked token and permits subsequent writes", async () => {
    await writeSession(original);
    await clearSession(original.token);
    expect(mockStorage.has(sessionKey)).toBe(false);
    mockWrite.mockRejectedValueOnce(
      new Error("storage temporarily unavailable"),
    );
    await expect(writeSession(original)).rejects.toThrow(
      "storage temporarily unavailable",
    );
    await writeSession(replacement);
    expect(JSON.parse(mockStorage.get(sessionKey)!)).toEqual(replacement);
  });

  it("keeps the expired-session explanation across restart without changing scoped keys", async () => {
    const databaseKey = "sewa-motor.database-key.v1";
    const terminalKey = "sewa-motor.terminal-identity.v1";
    mockStorage.set(databaseKey, "existing-encryption-key");
    mockStorage.set(terminalKey, "existing-signing-evidence");
    await writeSession(original);
    await clearSession(original.token, "Silakan masuk kembali.");
    expect(mockStorage.has(sessionKey)).toBe(false);
    expect(mockStorage.get(noticeKey)).toBe("Silakan masuk kembali.");
    expect(mockStorage.get(databaseKey)).toBe("existing-encryption-key");
    expect(mockStorage.get(terminalKey)).toBe("existing-signing-evidence");
    expect(mockDelete).toHaveBeenCalledWith(sessionKey);
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });

  it("never applies an old session's logout notice to a replacement login", async () => {
    await writeSession(original);
    mockStorage.set(noticeKey, "Current notice");
    await Promise.all([
      writeSession(replacement),
      clearSession(original.token, "Stale revoked-session notice"),
    ]);
    expect(JSON.parse(mockStorage.get(sessionKey)!)).toEqual(replacement);
    expect(mockStorage.get(noticeKey)).toBe("Current notice");
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("prevents a delayed background refresh from restoring cleared authentication", async () => {
    await writeSession(original);
    await Promise.all([
      clearSession(original.token, "Silakan masuk kembali."),
      writeSession(original, original.sessionId),
    ]);
    expect(mockStorage.has(sessionKey)).toBe(false);
  });

  it("keeps the logout explanation when a late login callback tries to dismiss it", async () => {
    await writeSession(original);
    await Promise.all([
      clearSession(original.token, "Silakan masuk kembali."),
      clearAuthNotice(original.token),
    ]);
    expect(mockStorage.has(sessionKey)).toBe(false);
    expect(mockStorage.get(noticeKey)).toBe("Silakan masuk kembali.");
  });

  it("dismisses a login notice only for the matching active token", async () => {
    await writeSession(replacement);
    mockStorage.set(noticeKey, "New session notice");
    await clearAuthNotice(original.token);
    expect(mockStorage.get(noticeKey)).toBe("New session notice");
    await clearAuthNotice(replacement.token);
    expect(mockStorage.has(noticeKey)).toBe(false);
  });
});
