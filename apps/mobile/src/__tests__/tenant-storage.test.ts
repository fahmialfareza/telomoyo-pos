import {
  clearLocalDatabase,
  databaseName,
  databaseScope,
  getDatabase,
  prepareDatabaseForSession,
  resetDatabaseSingletonForTests,
} from "@/db/client";
import {
  INITIAL_TENANT_ID,
  PRODUCTION_DATA_SPACE_ID,
  type Session,
} from "@/domain/types";
import { setModeFromSession } from "@/mode/mode-store";
import {
  getOrCreateDatabaseKey,
  preserveTerminalIdentity,
  readSession,
  readTerminalIdentity,
  writeTerminalIdentity,
} from "@/security/secure-store";

const mockGetItemAsync = jest.fn();
const mockSetItemAsync = jest.fn();
const mockDeleteItemAsync = jest.fn();
const mockOpenDatabaseAsync = jest.fn();
const mockDeleteDatabaseAsync = jest.fn();

jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "device-only",
  getItemAsync: (...args: unknown[]) => mockGetItemAsync(...args),
  setItemAsync: (...args: unknown[]) => mockSetItemAsync(...args),
  deleteItemAsync: (...args: unknown[]) => mockDeleteItemAsync(...args),
}));
jest.mock("expo-crypto", () => ({
  getRandomBytesAsync: async () => new Uint8Array(32).fill(5),
}));
jest.mock("expo-sqlite", () => ({
  openDatabaseAsync: (...args: unknown[]) => mockOpenDatabaseAsync(...args),
  deleteDatabaseAsync: (...args: unknown[]) => mockDeleteDatabaseAsync(...args),
}));
jest.mock("drizzle-orm/expo-sqlite", () => ({ drizzle: jest.fn() }));
jest.mock("@/db/migrations", () => ({ runMigrations: jest.fn() }));

const secondTenant = "00000000-0000-4000-8000-000000000201";
const session: Session = {
  token: "token",
  sessionId: "session",
  establishedAt: "2026-09-10T00:00:00Z",
  contextKind: "tenant",
  tenantId: INITIAL_TENANT_ID,
  dataMode: "production",
  dataSpaceId: PRODUCTION_DATA_SPACE_ID,
  sandboxGeneration: null,
  user: {
    id: "staff",
    fullName: "Staff",
    username: "staff",
    role: "admin",
    active: true,
    mustChangePassword: false,
  },
};

function sqliteConnection() {
  return {
    execAsync: jest.fn(),
    closeAsync: jest.fn(),
    getFirstAsync: jest.fn(async () => ({ generation: 1 })),
    runAsync: jest.fn(),
    withTransactionAsync: async (callback: () => Promise<void>) => callback(),
  };
}

describe("tenant-scoped encrypted storage", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    resetDatabaseSingletonForTests();
    setModeFromSession(session);
    mockGetItemAsync.mockResolvedValue("05".repeat(32));
    mockOpenDatabaseAsync.mockImplementation(async () => sqliteConnection());
  });

  afterEach(() => {
    resetDatabaseSingletonForTests();
    setModeFromSession(null);
  });

  it("preserves both Telomoyo filenames and encryption keys, namespacing other tenants", async () => {
    const scopes = [
      session,
      { ...session, dataMode: "sandbox" as const },
      { ...session, tenantId: secondTenant },
      { ...session, tenantId: secondTenant, dataMode: "sandbox" as const },
    ];
    expect(scopes.map(databaseName)).toEqual([
      "telomoyo-pos.db",
      "telomoyo-pos-sandbox.db",
      `telomoyo-pos-${secondTenant}-production.db`,
      `telomoyo-pos-${secondTenant}-sandbox.db`,
    ]);
    for (const scope of scopes) await getOrCreateDatabaseKey(scope);
    expect(mockGetItemAsync.mock.calls.map(([key]) => key)).toEqual([
      "sewa-motor.database-key.v1",
      "sewa-motor.database-key.sandbox.v1",
      `sewa-motor.database-key.tenant.${secondTenant}.production.v1`,
      `sewa-motor.database-key.tenant.${secondTenant}.sandbox.v1`,
    ]);
    expect(mockSetItemAsync).not.toHaveBeenCalled();
    expect(mockDeleteItemAsync).not.toHaveBeenCalled();
  });

  it("reuses only the matching tenant/mode connection and retains explicit scope after switching", async () => {
    const original = getDatabase(session);
    const rotatedSession = { ...session, sessionId: "new-session" };
    expect(getDatabase(rotatedSession)).toBe(original);
    const nextSession = { ...session, tenantId: secondTenant };
    setModeFromSession(nextSession);
    const second = getDatabase(nextSession);
    const sandbox = getDatabase({ ...nextSession, dataMode: "sandbox" });
    expect(getDatabase(session)).toBe(original);
    expect(getDatabase("production")).toBe(second);
    expect(second).not.toBe(original);
    expect(sandbox).not.toBe(second);
    await Promise.all([original, second, sandbox]);
    expect(mockOpenDatabaseAsync).toHaveBeenCalledTimes(3);
    expect(mockOpenDatabaseAsync).toHaveBeenCalledWith("telomoyo-pos.db");
    expect(mockOpenDatabaseAsync).toHaveBeenCalledWith(
      `telomoyo-pos-${secondTenant}-production.db`,
    );
    expect(mockOpenDatabaseAsync).toHaveBeenCalledWith(
      `telomoyo-pos-${secondTenant}-sandbox.db`,
    );
  });

  it.each(["account", "platform"] as const)(
    "does not open business SQLite in %s context",
    async (contextKind) => {
      const nonBusiness: Session = {
        ...session,
        contextKind,
        tenantId: null,
        dataSpaceId: null,
      };
      setModeFromSession(nonBusiness);
      await prepareDatabaseForSession(nonBusiness);
      expect(() => getDatabase(nonBusiness)).toThrow(
        "Pilih bisnis terlebih dahulu",
      );
      expect(() => getDatabase()).toThrow("Pilih bisnis");
      await expect(getOrCreateDatabaseKey(nonBusiness)).rejects.toThrow(
        "Pilih bisnis terlebih dahulu",
      );
      await expect(
        getOrCreateDatabaseKey({ ...nonBusiness, tenantId: INITIAL_TENANT_ID }),
      ).rejects.toThrow("Pilih bisnis terlebih dahulu");
      expect(mockOpenDatabaseAsync).not.toHaveBeenCalled();
      expect(mockGetItemAsync).not.toHaveBeenCalled();
    },
  );

  it("fails closed on missing tenant identity instead of falling back to the old database", async () => {
    expect(() => databaseScope({ dataMode: "production" })).toThrow(
      "Identitas bisnis wajib",
    );
    expect(() =>
      databaseName({ dataMode: "production", tenantId: "unknown" }),
    ).toThrow("Identitas bisnis tidak valid");
    await expect(
      getOrCreateDatabaseKey({ dataMode: "production" }),
    ).rejects.toThrow("Identitas bisnis wajib");
    expect(mockOpenDatabaseAsync).not.toHaveBeenCalled();
    expect(mockGetItemAsync).not.toHaveBeenCalled();
  });

  it("replaces only the reset tenant's Sandbox database, retaining other connections and all keys", async () => {
    const original = await getDatabase(session);
    const initialSandbox = await getDatabase({
      ...session,
      dataMode: "sandbox",
    });
    const secondProduction = await getDatabase({
      ...session,
      tenantId: secondTenant,
    });
    const target = {
      ...session,
      tenantId: secondTenant,
      dataMode: "sandbox" as const,
      sandboxGeneration: 2,
    };
    const retiredSandbox = await getDatabase(target);
    await prepareDatabaseForSession(target);

    expect(mockDeleteDatabaseAsync).toHaveBeenCalledTimes(1);
    expect(mockDeleteDatabaseAsync).toHaveBeenCalledWith(
      `telomoyo-pos-${secondTenant}-sandbox.db`,
    );
    expect(retiredSandbox.sqlite.closeAsync).toHaveBeenCalledTimes(1);
    expect(original.sqlite.closeAsync).not.toHaveBeenCalled();
    expect(initialSandbox.sqlite.closeAsync).not.toHaveBeenCalled();
    expect(secondProduction.sqlite.closeAsync).not.toHaveBeenCalled();
    expect(await getDatabase(session)).toBe(original);
    expect(await getDatabase(target)).not.toBe(retiredSandbox);
    expect(mockDeleteItemAsync).not.toHaveBeenCalled();
    expect(mockSetItemAsync).not.toHaveBeenCalled();
  });

  it("uses the supplied tenant for database deletion even when another tenant is active", async () => {
    setModeFromSession({ ...session, tenantId: secondTenant });
    await clearLocalDatabase(session);
    expect(mockDeleteDatabaseAsync).toHaveBeenCalledWith("telomoyo-pos.db");
  });

  it("only normalizes genuinely legacy sessions and preserves their immutable origin identity", async () => {
    const {
      contextKind: _context,
      tenantId: _tenant,
      dataSpaceId: _space,
      ...legacy
    } = session;
    mockGetItemAsync.mockResolvedValueOnce(JSON.stringify(legacy));
    await expect(readSession()).resolves.toEqual({
      ...legacy,
      contextKind: "tenant",
      tenantId: INITIAL_TENANT_ID,
      dataSpaceId: PRODUCTION_DATA_SPACE_ID,
    });
    mockGetItemAsync.mockResolvedValueOnce(
      JSON.stringify({ ...session, tenantId: undefined }),
    );
    await expect(readSession()).rejects.toThrow("sesi tersimpan tidak lengkap");
    expect(mockSetItemAsync).not.toHaveBeenCalled();
    expect(mockDeleteItemAsync).not.toHaveBeenCalled();
  });

  it("preserves legacy enrollment, writes independent tenant keys, and archives revoked proof without rotation", async () => {
    const identity = {
      installationId: "phone",
      serverTerminalId: "terminal-a",
      privateKeyHex: "aa",
      publicKeyHex: "bb",
      enrolledAt: "2026-09-10T00:00:00Z",
    };
    mockGetItemAsync.mockResolvedValueOnce(JSON.stringify(identity));
    await expect(readTerminalIdentity(INITIAL_TENANT_ID)).resolves.toEqual(
      identity,
    );
    expect(mockGetItemAsync).toHaveBeenCalledWith(
      "sewa-motor.terminal-identity.v1",
    );
    const secondIdentity = {
      ...identity,
      serverTerminalId: "terminal-b",
      privateKeyHex: "cc",
      publicKeyHex: "dd",
    };
    await writeTerminalIdentity(secondIdentity, secondTenant);
    await preserveTerminalIdentity(identity, INITIAL_TENANT_ID);
    expect(mockSetItemAsync.mock.calls).toEqual([
      [
        `sewa-motor.terminal-identity.v1.${secondTenant}`,
        JSON.stringify(secondIdentity),
        expect.any(Object),
      ],
      [
        `sewa-motor.terminal-identity.v1.${INITIAL_TENANT_ID}.retired.terminal-a`,
        JSON.stringify(identity),
        expect.any(Object),
      ],
    ]);
    expect(mockDeleteItemAsync).not.toHaveBeenCalled();
  });
});
