import { ApiError, apiRequest } from "@/api/client";
import type { LoginResponse } from "@/api/contracts";
import { sessionFromLoginResponse } from "@/auth/session";
import { clearLocalDatabase, prepareDatabaseForSession } from "@/db/client";
import { INITIAL_TENANT_ID, type DataMode, type Session } from "@/domain/types";
import { bindServerTerminal } from "@/security/terminal-identity";
import {
  clearSession,
  writeAuthNotice,
  writeSession,
} from "@/security/secure-store";
import { runSync, type SyncSummary } from "@/sync/engine";

import { setModeFromSession } from "./mode-store";
import {
  beginModeTransition,
  isModeTransitionLeaseActive,
  MODE_TRANSITION_BUSY_MESSAGE,
  type ModeTransitionLease,
} from "./mutation-barrier";

export const SANDBOX_RETIRED_MESSAGE =
  "Mode Uji telah direset oleh superadmin. Data Mode Uji lama sudah dibersihkan dari perangkat. Masuk kembali, lalu aktifkan Mode Uji untuk memuat generasi terbaru.";

export const SANDBOX_RECOVERY_ERROR =
  "Mode Uji telah direset, tetapi pemulihan otomatis belum berhasil. Data Mode Uji lama sudah dibersihkan. Silakan masuk kembali untuk melanjutkan.";

export const SANDBOX_RECOVERED_MESSAGE =
  "Mode Uji telah direset oleh superadmin. Perangkat otomatis terhubung ke generasi Mode Uji terbaru.";

export const SANDBOX_RECOVERED_TO_PRODUCTION_MESSAGE =
  "Mode Uji telah direset oleh superadmin. Perangkat otomatis kembali ke Mode Produksi.";

export const SANDBOX_RECOVERY_TARGET_CONFLICT_MESSAGE =
  "Pemulihan Mode Uji sedang berjalan menuju mode operasi yang berbeda. Tunggu hingga selesai lalu coba lagi.";

export interface SandboxRecoveryResult {
  session: Session;
  summary: SyncSummary;
  terminalEnrolled: boolean;
  notice: string;
}

type BeforeRecoveryExposure = (result: SandboxRecoveryResult) => Promise<void>;

interface SandboxRecoveryOptions {
  /** The caller keeps this verified mutation-barrier lease until recovery returns. */
  transitionLease?: ModeTransitionLease;
}

interface RecoveryEntry {
  callbacks: BeforeRecoveryExposure[];
  phase: "recovering" | "callbacks" | "settled";
  promise: Promise<SandboxRecoveryResult>;
  targetMode: DataMode;
  transitionStarted: boolean;
}

// The server permits exactly one recovery rotation for a retired session.
// Sharing and retaining the result prevents a concurrent foreground/background
// observer from losing that race and deleting the successful replacement.
const recoveryEntries = new Map<string, RecoveryEntry>();

function recoveryKey(session: Session): string {
  // Session IDs are globally unique; avoid retaining the retired bearer token
  // in a long-lived settled single-flight map entry.
  return session.sessionId;
}

export function activeRetiredSandboxRecovery(
  session: Session,
): Promise<SandboxRecoveryResult> | null {
  return recoveryEntries.get(recoveryKey(session))?.promise ?? null;
}

export function isSandboxGenerationRetired(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.code === "SANDBOX_GENERATION_RETIRED";
  }
  if (!error || typeof error !== "object") return false;
  return "code" in error && error.code === "SANDBOX_GENERATION_RETIRED";
}

export async function retireSandboxSession(session: Session): Promise<void> {
  if (session.dataMode !== "sandbox") return;

  let failure: unknown;
  try {
    await clearSession();
  } catch (error) {
    failure = error;
  }
  setModeFromSession(null);
  try {
    await clearLocalDatabase(session);
  } catch (error) {
    failure ??= error;
  }
  try {
    await writeAuthNotice(SANDBOX_RETIRED_MESSAGE);
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw failure;
}

/**
 * Performs the server's one-time recovery rotation for a retired Sandbox
 * session. Callers must remove the authenticated UI before invoking this so a
 * database cannot be observed while its generation is changing.
 */
export async function recoverRetiredSandboxGeneration(
  retiredSession: Session,
  targetMode: DataMode = "sandbox",
  beforeExposure?: BeforeRecoveryExposure,
  options: SandboxRecoveryOptions = {},
): Promise<SandboxRecoveryResult> {
  if (retiredSession.dataMode !== "sandbox") {
    throw new Error("Pemulihan generasi hanya tersedia untuk sesi Mode Uji.");
  }

  const key = recoveryKey(retiredSession);
  const existing = recoveryEntries.get(key);
  if (existing) {
    // A foreground mode switch may acquire the transition barrier immediately
    // before an automatic observer tries to recover. That observer creates an
    // entry but cannot start any destructive work. Let the verified owner take
    // over after that harmless attempt rejects instead of inheriting it.
    if (options.transitionLease && !existing.transitionStarted) {
      return existing.promise.catch(() => {
        if (existing.transitionStarted) {
          throw new Error(SANDBOX_RECOVERY_TARGET_CONFLICT_MESSAGE);
        }
        if (recoveryEntries.get(key) === existing) {
          recoveryEntries.delete(key);
        }
        return recoverRetiredSandboxGeneration(
          retiredSession,
          targetMode,
          beforeExposure,
          options,
        );
      });
    }
    if (existing.targetMode !== targetMode) {
      throw new Error(SANDBOX_RECOVERY_TARGET_CONFLICT_MESSAGE);
    }
    if (beforeExposure && existing.phase === "recovering") {
      existing.callbacks.push(beforeExposure);
      return existing.promise;
    }
    if (beforeExposure) {
      return existing.promise.then(async (result) => {
        await beforeExposure(result);
        return result;
      });
    }
    return existing.promise;
  }

  const entry: RecoveryEntry = {
    callbacks: beforeExposure ? [beforeExposure] : [],
    phase: "recovering",
    promise: Promise.resolve(null as never),
    targetMode,
    transitionStarted: false,
  };
  entry.promise = performRetiredSandboxRecovery(
    retiredSession,
    targetMode,
    key,
    entry,
    options,
  ).finally(() => {
    entry.phase = "settled";
  });
  recoveryEntries.set(key, entry);
  return entry.promise;
}

async function performRetiredSandboxRecovery(
  retiredSession: Session,
  targetMode: DataMode,
  recoveryKey: string,
  entry: RecoveryEntry,
  options: SandboxRecoveryOptions,
): Promise<SandboxRecoveryResult> {
  let ownedTransition: ModeTransitionLease | null = null;
  try {
    if (options.transitionLease) {
      if (!isModeTransitionLeaseActive(options.transitionLease)) {
        throw new Error(MODE_TRANSITION_BUSY_MESSAGE);
      }
    } else {
      ownedTransition = await beginModeTransition();
    }
    entry.transitionStarted = true;
    setModeFromSession(null);
    // The Production database is intentionally preserved. A fresh Sandbox
    // database also prevents stale outbox entries from crossing generations.
    await clearLocalDatabase(retiredSession);
    const response = await apiRequest<LoginResponse>("/auth/switch-mode", {
      method: "POST",
      token: retiredSession.token,
      body: { mode: targetMode },
    });
    const session = sessionFromLoginResponse(response);

    // Persist and fully prepare/synchronize the replacement scope before any
    // caller is allowed to expose the authenticated tree again.
    await writeSession(session);
    await prepareDatabaseForSession(session);
    setModeFromSession(session);
    // Verify the device still holds this terminal's key before syncing, so a
    // stale binding cannot push operations the server will reject.
    const terminalEnrolled = response.terminal
      ? await bindServerTerminal(
          response.terminal,
          session.tenantId ?? INITIAL_TENANT_ID,
        )
      : false;
    const summary = await runSync(session);
    const notice =
      targetMode === "sandbox"
        ? SANDBOX_RECOVERED_MESSAGE
        : SANDBOX_RECOVERED_TO_PRODUCTION_MESSAGE;
    const result: SandboxRecoveryResult = {
      session,
      summary,
      terminalEnrolled,
      notice,
    };
    entry.phase = "callbacks";
    while (entry.callbacks.length > 0) {
      const callbacks = entry.callbacks.splice(0, entry.callbacks.length);
      await Promise.all(callbacks.map((callback) => callback(result)));
    }
    await writeAuthNotice(notice).catch(() => undefined);
    return result;
  } catch (error) {
    // A failed barrier acquisition has not touched session or database state.
    // Remove it so the verified transition owner can perform the one-time
    // rotation; critically, do not run fail-closed cleanup in this branch.
    if (!entry.transitionStarted) {
      if (recoveryEntries.get(recoveryKey) === entry) {
        recoveryEntries.delete(recoveryKey);
      }
      throw error;
    }

    // Recovery is deliberately fail-closed. The replacement endpoint is
    // one-time, so any incomplete local handoff returns the operator to login.
    setModeFromSession(null);
    await clearSession().catch(() => undefined);
    await clearLocalDatabase(retiredSession).catch(() => undefined);
    await writeAuthNotice(SANDBOX_RECOVERY_ERROR).catch(() => undefined);

    const recoveryError = new Error(SANDBOX_RECOVERY_ERROR);
    Object.defineProperty(recoveryError, "cause", {
      configurable: true,
      value: error,
    });
    throw recoveryError;
  } finally {
    ownedTransition?.release();
  }
}

export function resetSandboxRecoveryForTests(): void {
  recoveryEntries.clear();
}
