import { getDatabase } from "@/db/client";
import { apiRequest } from "@/api/client";
import type { Session } from "@/domain/types";

export const SCOPE_ACCESS_CODES = new Set([
  "TENANT_SUSPENDED",
  "MEMBERSHIP_INACTIVE",
  "MEMBERSHIP_REVOKED",
  "TERMINAL_REVOKED",
  "ACCOUNT_ACCESS_CHANGED",
]);

export async function quarantineScope(
  session: Session,
  reason: string,
): Promise<void> {
  const { sqlite } = await getDatabase(session);
  await sqlite.withTransactionAsync(async () => {
    await sqlite.runAsync(
      "UPDATE scope_access SET blocked_reason = ?, blocked_actor_id = ?, blocked_at = ? WHERE singleton = 1",
      reason,
      reason.startsWith("MEMBERSHIP_") ||
        reason === "ACCOUNT_ACCESS_CHANGED" ||
        reason === "SESSION_INVALID"
        ? session.user.id
        : null,
      new Date().toISOString(),
    );
    // Do not rewrite signed evidence; each original actor/session/enrollment
    // remains in operation_json, inside this tenant + data-space database.
    await sqlite.runAsync(
      `UPDATE outbox_operations SET quarantine_reason = ? WHERE state IN ('pending', 'error', 'conflict', 'rejected')`,
      reason,
    );
  });
}

interface Origin {
  originSessionId: string;
  originActorId: string;
  terminalId: string;
}

/** Explicit online release. Another staff member can never release these entries. */
export async function revalidateQuarantinedOperations(
  session: Session,
): Promise<number> {
  const { sqlite } = await getDatabase(session);
  const rows = await sqlite.getAllAsync<{
    operation_id: string;
    operation_json: string;
  }>(
    "SELECT operation_id, operation_json FROM outbox_operations WHERE quarantine_reason IS NOT NULL AND json_extract(operation_json, '$.originActorId') = ?",
    session.user.id,
  );
  const origins = new Map<string, Origin>();
  for (const row of rows) {
    const original = JSON.parse(row.operation_json) as Origin;
    origins.set(
      JSON.stringify([
        original.originSessionId,
        original.originActorId,
        original.terminalId,
      ]),
      {
        originSessionId: original.originSessionId,
        originActorId: original.originActorId,
        terminalId: original.terminalId,
      },
    );
  }
  let released = 0;
  const values = [...origins.values()];
  for (let offset = 0; offset < values.length; offset += 100) {
    const result = await apiRequest<{
      origins: (Origin & { allowed: boolean })[];
    }>("/sync/revalidate", {
      method: "POST",
      token: session.token,
      body: { origins: values.slice(offset, offset + 100) },
    });
    const allowed = new Set(
      result.origins
        .filter(
          (item) => item.allowed && item.originActorId === session.user.id,
        )
        .map((item) =>
          JSON.stringify([
            item.originSessionId,
            item.originActorId,
            item.terminalId,
          ]),
        ),
    );
    await sqlite.withTransactionAsync(async () => {
      let batchReleased = 0;
      for (const row of rows) {
        const original = JSON.parse(row.operation_json) as Origin;
        if (
          !allowed.has(
            JSON.stringify([
              original.originSessionId,
              original.originActorId,
              original.terminalId,
            ]),
          )
        )
          continue;
        const update = await sqlite.runAsync(
          "UPDATE outbox_operations SET quarantine_reason = NULL WHERE operation_id = ? AND operation_json = ? AND quarantine_reason IS NOT NULL",
          row.operation_id,
          row.operation_json,
        );
        released += update.changes;
        batchReleased += update.changes;
      }
      // Pulls deliberately leave quarantined transaction evidence untouched.
      // Re-fetch the authoritative history only after exact origins are allowed.
      if (batchReleased > 0)
        await sqlite.runAsync(
          "UPDATE sync_metadata SET cursor = NULL WHERE singleton = 1",
        );
    });
  }
  return released;
}

export async function blockedScopeReason(
  session: Session,
): Promise<string | null> {
  const { sqlite } = await getDatabase(session);
  const row = await sqlite.getFirstAsync<{
    blocked_reason: string | null;
    blocked_actor_id: string | null;
  }>(
    "SELECT blocked_reason, blocked_actor_id FROM scope_access WHERE singleton = 1",
  );
  return row &&
    (!row.blocked_actor_id || row.blocked_actor_id === session.user.id)
    ? row.blocked_reason
    : null;
}

export async function markScopeRevalidated(session: Session): Promise<void> {
  const { sqlite } = await getDatabase(session);
  await sqlite.runAsync(
    "UPDATE scope_access SET blocked_reason = NULL, blocked_actor_id = NULL, blocked_at = NULL WHERE singleton = 1",
  );
  // Quarantined signed evidence stays quarantined even after access returns.
}

export async function countQuarantinedOperations(
  session: Session,
): Promise<number> {
  const { sqlite } = await getDatabase(session);
  const row = await sqlite.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) AS count FROM outbox_operations WHERE quarantine_reason IS NOT NULL",
  );
  return row?.count ?? 0;
}
