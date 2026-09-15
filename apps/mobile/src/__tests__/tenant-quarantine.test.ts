import {
  INITIAL_TENANT_ID,
  PRODUCTION_DATA_SPACE_ID,
  type Session,
} from "@/domain/types";
import {
  blockedScopeReason,
  markScopeRevalidated,
  quarantineScope,
  revalidateQuarantinedOperations,
} from "@/tenant/quarantine";

const mockGetDatabase = jest.fn();
const mockGetAllAsync = jest.fn();
const mockGetFirstAsync = jest.fn();
const mockRunAsync = jest.fn();
const mockApiRequest = jest.fn();

jest.mock("@/db/client", () => ({
  getDatabase: (...args: unknown[]) => mockGetDatabase(...args),
}));
jest.mock("@/api/client", () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
}));

const session: Session = {
  token: "current-token",
  sessionId: "current-session",
  contextKind: "tenant",
  tenantId: INITIAL_TENANT_ID,
  dataMode: "production",
  dataSpaceId: PRODUCTION_DATA_SPACE_ID,
  sandboxGeneration: null,
  establishedAt: "2026-09-10T00:00:00Z",
  user: {
    id: "staff-a",
    fullName: "Staff A",
    username: "a",
    role: "admin",
    active: true,
    mustChangePassword: false,
  },
};

function queued(
  id: string,
  actor = session.user.id,
  origin = "old-session",
  terminal = "original-terminal",
) {
  return {
    operation_id: id,
    // Keep whitespace: exact stored bytes, not a reserialized replacement, must
    // be compared when releasing the original signed operation.
    operation_json: `{ "operationId": "${id}", "originActorId": "${actor}", "originSessionId": "${origin}", "terminalId": "${terminal}", "payload": {"total": 75000}, "signature": "original-signature" }`,
  };
}

function originOf(row: ReturnType<typeof queued>) {
  const { originSessionId, originActorId, terminalId } = JSON.parse(
    row.operation_json,
  ) as { originSessionId: string; originActorId: string; terminalId: string };
  return { originSessionId, originActorId, terminalId };
}

describe("tenant quarantine and explicit origin revalidation", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockGetDatabase.mockResolvedValue({
      sqlite: {
        getAllAsync: (...args: unknown[]) => mockGetAllAsync(...args),
        getFirstAsync: (...args: unknown[]) => mockGetFirstAsync(...args),
        runAsync: (...args: unknown[]) => mockRunAsync(...args),
        withTransactionAsync: async (callback: () => Promise<void>) =>
          callback(),
      },
    });
    mockGetAllAsync.mockResolvedValue([]);
    mockRunAsync.mockResolvedValue({ changes: 1 });
  });

  it("locks only the supplied scope and flags unresolved operations without modifying signed evidence", async () => {
    await quarantineScope(session, "MEMBERSHIP_INACTIVE");
    expect(mockGetDatabase).toHaveBeenCalledWith(session);
    expect(mockRunAsync).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("UPDATE scope_access"),
      "MEMBERSHIP_INACTIVE",
      "staff-a",
      expect.any(String),
    );
    expect(mockRunAsync).toHaveBeenNthCalledWith(
      2,
      "UPDATE outbox_operations SET quarantine_reason = ? WHERE state IN ('pending', 'error', 'conflict', 'rejected')",
      "MEMBERSHIP_INACTIVE",
    );
    for (const [sql] of mockRunAsync.mock.calls) {
      expect(sql).not.toMatch(
        /SET\s+(operation_json|actor_id|terminal_id|signature)|DELETE|INSERT/,
      );
    }
  });

  it("tenant suspension locks all actors while membership suspension follows only the affected actor", async () => {
    await quarantineScope(session, "TENANT_SUSPENDED");
    expect(mockRunAsync).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      "TENANT_SUSPENDED",
      null,
      expect.any(String),
    );
    mockGetFirstAsync.mockResolvedValue({
      blocked_reason: "MEMBERSHIP_INACTIVE",
      blocked_actor_id: "staff-a",
    });
    await expect(blockedScopeReason(session)).resolves.toBe(
      "MEMBERSHIP_INACTIVE",
    );
    await expect(
      blockedScopeReason({
        ...session,
        user: { ...session.user, id: "staff-b" },
      }),
    ).resolves.toBeNull();
    mockGetFirstAsync.mockResolvedValue({
      blocked_reason: "TENANT_SUSPENDED",
      blocked_actor_id: null,
    });
    await expect(
      blockedScopeReason({
        ...session,
        user: { ...session.user, id: "staff-b" },
      }),
    ).resolves.toBe("TENANT_SUSPENDED");
  });

  it.each(["ACCOUNT_ACCESS_CHANGED", "SESSION_INVALID"])(
    "%s follows the affected actor without changing signed outbox bytes",
    async (reason) => {
      await quarantineScope(session, reason);
      expect(mockRunAsync).toHaveBeenNthCalledWith(
        1,
        expect.any(String),
        reason,
        session.user.id,
        expect.any(String),
      );
      mockGetFirstAsync.mockResolvedValue({
        blocked_reason: reason,
        blocked_actor_id: session.user.id,
      });
      await expect(
        blockedScopeReason({
          ...session,
          user: { ...session.user, id: "another-account" },
        }),
      ).resolves.toBeNull();
      await expect(blockedScopeReason(session)).resolves.toBe(reason);
      expect(
        mockRunAsync.mock.calls.some(([sql]) =>
          /SET\s+operation_json|DELETE/.test(String(sql)),
        ),
      ).toBe(false);
    },
  );

  it("deduplicates immutable origins and releases only the exact approved actor/session/enrollment tuple", async () => {
    const first = queued("one");
    const sameOrigin = queued("two");
    const denied = queued(
      "three",
      "staff-a",
      "different-session",
      "revoked-terminal",
    );
    mockGetAllAsync.mockResolvedValue([first, sameOrigin, denied]);
    mockApiRequest.mockResolvedValue({
      origins: [
        { ...originOf(first), allowed: true },
        { ...originOf(denied), allowed: false },
        { ...originOf(denied), originActorId: "staff-b", allowed: true },
        {
          ...originOf(denied),
          terminalId: "replacement-terminal",
          allowed: true,
        },
      ],
    });

    await expect(revalidateQuarantinedOperations(session)).resolves.toBe(2);
    expect(mockGetDatabase).toHaveBeenCalledWith(session);
    expect(mockGetAllAsync).toHaveBeenCalledWith(
      expect.stringContaining(
        "json_extract(operation_json, '$.originActorId') = ?",
      ),
      "staff-a",
    );
    expect(mockApiRequest).toHaveBeenCalledWith("/sync/revalidate", {
      method: "POST",
      token: session.token,
      body: { origins: [originOf(first), originOf(denied)] },
    });
    expect(mockRunAsync.mock.calls).toEqual([
      [
        "UPDATE outbox_operations SET quarantine_reason = NULL WHERE operation_id = ? AND operation_json = ? AND quarantine_reason IS NOT NULL",
        first.operation_id,
        first.operation_json,
      ],
      [
        "UPDATE outbox_operations SET quarantine_reason = NULL WHERE operation_id = ? AND operation_json = ? AND quarantine_reason IS NOT NULL",
        sameOrigin.operation_id,
        sameOrigin.operation_json,
      ],
      ["UPDATE sync_metadata SET cursor = NULL WHERE singleton = 1"],
    ]);
  });

  it("another staff member cannot release a quarantined entry even if an unexpected server response includes it", async () => {
    const original = queued("original");
    const other = {
      ...session,
      token: "other-token",
      user: { ...session.user, id: "staff-b" },
    };
    // Defensive client-side check even if the SQL adapter returned an incorrect row.
    mockGetAllAsync.mockResolvedValue([original]);
    mockApiRequest.mockResolvedValue({
      origins: [{ ...originOf(original), allowed: true }],
    });
    await expect(revalidateQuarantinedOperations(other)).resolves.toBe(0);
    expect(mockGetAllAsync).toHaveBeenCalledWith(expect.any(String), "staff-b");
    expect(mockRunAsync).not.toHaveBeenCalled();
  });

  it("preserves every queued byte and quarantine flag if online revalidation fails", async () => {
    const original = queued("original");
    const bytesBefore = original.operation_json;
    mockGetAllAsync.mockResolvedValue([original]);
    mockApiRequest.mockRejectedValue(
      new Error("Tidak dapat terhubung ke server."),
    );
    await expect(revalidateQuarantinedOperations(session)).rejects.toThrow(
      "Tidak dapat terhubung",
    );
    expect(original.operation_json).toBe(bytesBefore);
    expect(mockRunAsync).not.toHaveBeenCalled();
  });

  it("batches more than 100 distinct origins and counts only successful compare-and-set releases", async () => {
    const rows = Array.from({ length: 101 }, (_, index) =>
      queued(`operation-${index}`, "staff-a", `origin-${index}`),
    );
    mockGetAllAsync.mockResolvedValue(rows);
    mockApiRequest.mockImplementation(async (_path, options) => ({
      origins: options.body.origins.map(
        (origin: ReturnType<typeof originOf>) => ({ ...origin, allowed: true }),
      ),
    }));
    mockRunAsync
      .mockResolvedValueOnce({ changes: 0 })
      .mockResolvedValue({ changes: 1 });
    await expect(revalidateQuarantinedOperations(session)).resolves.toBe(100);
    expect(mockApiRequest).toHaveBeenCalledTimes(2);
    expect(mockApiRequest.mock.calls[0]?.[1].body.origins).toHaveLength(100);
    expect(mockApiRequest.mock.calls[1]?.[1].body.origins).toHaveLength(1);
    expect(mockRunAsync).toHaveBeenCalledTimes(103);
    expect(
      mockRunAsync.mock.calls.filter(
        ([sql]) =>
          sql === "UPDATE sync_metadata SET cursor = NULL WHERE singleton = 1",
      ),
    ).toHaveLength(2);
  });

  it("restoring business access never automatically clears signed-entry quarantine", async () => {
    await markScopeRevalidated(session);
    expect(mockGetDatabase).toHaveBeenCalledWith(session);
    expect(mockRunAsync.mock.calls).toEqual([
      [
        "UPDATE scope_access SET blocked_reason = NULL, blocked_actor_id = NULL, blocked_at = NULL WHERE singleton = 1",
      ],
    ]);
    expect(mockApiRequest).not.toHaveBeenCalled();
  });
});
