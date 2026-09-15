import NetInfo from "@react-native-community/netinfo";
import Constants from "expo-constants";
import { create } from "zustand";

import { apiRequest, registerAccessFailureHandler } from "@/api/client";
import type { LoginResponse, AuthContextsResponse } from "@/api/contracts";
import { sessionFromLoginResponse } from "@/auth/session";
import {
  isSessionReauthenticationError,
  requiresSessionReauthentication,
  SESSION_INVALID_MESSAGE,
} from "@/auth/session-errors";
import { prepareDatabaseForSession } from "@/db/client";
import {
  countPendingOutbox,
  recoverInterruptedPrintAttempts,
} from "@/db/repositories";
import {
  PRODUCTION_DATA_SPACE_ID,
  INITIAL_TENANT_ID,
  type ContextKind,
  type DataMode,
  type Role,
  type Session,
} from "@/domain/types";
import { setModeFromSession, useModeStore } from "@/mode/mode-store";
import {
  beginModeTransition,
  beginModeSafeLocalAccess,
  MODE_TRANSITION_BUSY_MESSAGE,
  type ModeTransitionLease,
} from "@/mode/mutation-barrier";
import {
  isSandboxGenerationRetired,
  recoverRetiredSandboxGeneration,
  retireSandboxSession,
  SANDBOX_RECOVERY_ERROR,
  SANDBOX_RETIRED_MESSAGE,
} from "@/mode/recovery";
import {
  clearAuthNotice,
  clearSession,
  readAuthNotice,
  readSession,
  writeSession,
  getOrCreateInstallationId,
} from "@/security/secure-store";
import {
  getOrCreateTerminalIdentity,
  getTerminalPublicKeyBase64,
  markTerminalEnrolled,
  markTerminalRevoked,
} from "@/security/terminal-identity";
import { runSync } from "@/sync/engine";
import {
  hydrateSyncStateForSession,
  resetSyncStateForSession,
} from "@/sync/state-handoff";
import {
  blockedScopeReason,
  markScopeRevalidated,
  quarantineScope,
  SCOPE_ACCESS_CODES,
} from "@/tenant/quarantine";

export interface AuthStore {
  session: Session | null;
  booting: boolean;
  bootError: string | null;
  notice: string | null;
  demoEnabled: boolean;
  terminalEnrolled: boolean;
  switchingMode: boolean;
  scopeLocked: boolean;
  switchContext: (kind: ContextKind, tenantId?: string) => Promise<void>;
  upgradeSession: () => Promise<void>;
  dismissNotice: () => Promise<void>;
  hydrate: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  demoLogin: (role: Role) => Promise<void>;
  switchMode: (mode: DataMode) => Promise<void>;
  updateProfile: (fullName: string) => Promise<void>;
  changePassword: (
    currentPassword: string,
    newPassword: string,
  ) => Promise<void>;
  enrollTerminal: (label: string) => Promise<void>;
  logout: () => Promise<void>;
}

const demoEnabled =
  __DEV__ &&
  (Constants.expoConfig?.extra?.enableDemoLogin as boolean | undefined) ===
    true;

let hydration: Promise<void> | null = null;
let sessionInvalidationEpoch = 0;
const sessionInvalidations = new Map<string, Promise<void>>();

const MODE_DATABASE_ERROR =
  "Penyimpanan terenkripsi untuk mode baru belum dapat dibuka. Tutup dan buka kembali aplikasi untuk mencoba lagi.";

const MODE_SESSION_ERROR =
  "Sesi mode baru belum dapat diamankan pada perangkat. Masuk kembali sebelum melanjutkan.";

const LOGOUT_STORAGE_ERROR =
  "Logout berhasil di server, tetapi sesi lokal belum dapat dibersihkan. Tutup dan buka kembali aplikasi sebelum melanjutkan.";

function exposeSession(
  session: Session,
  set: (state: Partial<AuthStore>) => void,
  bootError: string | null = null,
) {
  setModeFromSession(session);
  set({ session, bootError });
}

async function persistSession(
  session: Session,
  set: (state: Partial<AuthStore>) => void,
) {
  const epoch = sessionInvalidationEpoch;
  const stillValid = () =>
    epoch === sessionInvalidationEpoch &&
    !sessionInvalidations.has(session.token);
  if (!stillValid()) throw new Error(SESSION_INVALID_MESSAGE);
  // Persist first, prepare the explicitly scoped store, then expose the
  // session to providers. If preparation fails, expose only behind bootError
  // so screens cannot render data from a previously active scope.
  try {
    await writeSession(session);
  } catch (error) {
    if (stillValid()) {
      resetSyncStateForSession(session);
      exposeSession(session, set, MODE_SESSION_ERROR);
    }
    throw error;
  }
  if (!stillValid()) throw new Error(SESSION_INVALID_MESSAGE);
  try {
    await prepareDatabaseForSession(session);
    if (!stillValid()) throw new Error(SESSION_INVALID_MESSAGE);
    await hydrateSyncStateForSession(session);
  } catch (error) {
    // A successfully issued session must replace the old scope even when its
    // local database cannot be opened. Blocking the protected layout prevents
    // data from the previous mode from rendering under the new credentials.
    if (stillValid()) {
      resetSyncStateForSession(session);
      exposeSession(session, set, MODE_DATABASE_ERROR);
    }
    throw error;
  }
  if (!stillValid()) {
    resetSyncStateForSession(useAuthStore.getState().session);
    throw new Error(SESSION_INVALID_MESSAGE);
  }
  exposeSession(session, set);
}

async function recoverRetiredSandboxSession(
  session: Session,
  targetMode: DataMode,
  set: (state: Partial<AuthStore>) => void,
  transitionLease: ModeTransitionLease,
): Promise<void> {
  // Remove the authenticated tree before recovery changes the active database,
  // so no screen can read a replacement scope before its first pull completes.
  set({
    session: null,
    terminalEnrolled: false,
    notice: SANDBOX_RETIRED_MESSAGE,
    bootError: null,
  });
  resetSyncStateForSession(null);
  try {
    const recovered = await recoverRetiredSandboxGeneration(
      session,
      targetMode,
      async (result) => {
        await hydrateSyncStateForSession(result.session, result.summary);
      },
      { transitionLease },
    );
    exposeSession(recovered.session, set);
    set({
      terminalEnrolled: recovered.terminalEnrolled,
      notice: recovered.notice,
    });
  } catch (error) {
    set({
      session: null,
      terminalEnrolled: false,
      notice: SANDBOX_RECOVERY_ERROR,
      bootError: null,
    });
    throw error;
  }
}

function modeChangedButSetupIncomplete(
  error: unknown,
  state: { localScopeReady: boolean; durable: boolean },
): Error {
  const message = !state.localScopeReady
    ? state.durable
      ? "Mode operasi sudah berhasil diganti di server dan sesi baru sudah disimpan, tetapi penyimpanan terenkripsi belum dapat dibuka. Tutup lalu buka kembali aplikasi untuk mencoba lagi."
      : "Mode operasi sudah berhasil diganti di server, tetapi sesi dan penyimpanan terenkripsi baru belum dapat diamankan di perangkat. Jangan tutup aplikasi dan hubungi dukungan."
    : state.durable
      ? "Mode operasi sudah berhasil diganti, tetapi data awal belum selesai disinkronkan. Sesi baru tetap tersimpan; periksa koneksi lalu coba Sinkronkan sekarang."
      : "Mode operasi di server sudah berhasil diganti, tetapi sesi baru belum dapat disimpan di perangkat. Database mode baru sudah aman; jangan tutup aplikasi dan coba ganti mode kembali setelah penyimpanan perangkat tersedia.";
  const wrapped = new Error(message);
  Object.defineProperty(wrapped, "cause", {
    configurable: true,
    value: error,
  });
  return wrapped;
}

export const useAuthStore = create<AuthStore>((set, get) => ({
  session: null,
  booting: true,
  bootError: null,
  notice: null,
  demoEnabled,
  terminalEnrolled: false,
  switchingMode: false,
  scopeLocked: false,

  dismissNotice: async () => {
    await clearAuthNotice();
    set({ notice: null });
  },

  hydrate: () => {
    hydration ??= beginModeSafeLocalAccess()
      .then(async (releaseLocalAccess) => {
        const epoch = sessionInvalidationEpoch;
        try {
          const [storedSession, notice] = await Promise.all([
            readSession(),
            readAuthNotice(),
          ]);
          const isTenant =
            storedSession &&
            (!storedSession.contextKind ||
              storedSession.contextKind === "tenant");
          const terminal = isTenant
            ? await getOrCreateTerminalIdentity(
                storedSession.tenantId ?? INITIAL_TENANT_ID,
              )
            : null;
          if (epoch !== sessionInvalidationEpoch) return;
          setModeFromSession(storedSession);
          resetSyncStateForSession(storedSession);
          if (storedSession) {
            await prepareDatabaseForSession(storedSession);
          }
          const locked = isTenant
            ? Boolean(await blockedScopeReason(storedSession))
            : false;
          if (epoch !== sessionInvalidationEpoch) return;
          useModeStore.setState({ accessBlocked: locked });
          if (isTenant && !locked) {
            await recoverInterruptedPrintAttempts(storedSession).catch(
              () => undefined,
            );
          }
          await hydrateSyncStateForSession(storedSession);
          if (epoch !== sessionInvalidationEpoch) {
            resetSyncStateForSession(get().session);
            return;
          }
          // A background reset may have requested the transition while this
          // startup read held the local-access lease. It now owns exposure of
          // the replacement session, so never put the retired one back.
          if (!get().switchingMode) {
            set({
              session: storedSession,
              terminalEnrolled: Boolean(terminal?.enrolledAt),
              scopeLocked: locked,
              notice,
              bootError: null,
            });
          }
        } finally {
          releaseLocalAccess();
        }
      })
      .catch((error: unknown) => {
        set({
          bootError:
            error instanceof Error
              ? error.message
              : "Penyimpanan lokal tidak dapat disiapkan.",
        });
        throw error;
      })
      .finally(() => set({ booting: false }));
    return hydration;
  },

  login: async (username, password) => {
    const installationId = await getOrCreateInstallationId();
    const result = await apiRequest<LoginResponse>("/auth/login", {
      method: "POST",
      body: {
        username: username.trim(),
        password,
        installationId,
        protocolVersion: 3,
      },
    });
    const session = sessionFromLoginResponse(result);
    await persistSession(session, set);
    if (
      get().session?.token !== session.token ||
      sessionInvalidations.has(session.token)
    )
      throw new Error(SESSION_INVALID_MESSAGE);
    await clearAuthNotice(session.token);
    if (
      get().session?.token !== session.token ||
      sessionInvalidations.has(session.token)
    )
      throw new Error(SESSION_INVALID_MESSAGE);
    set({ notice: null, scopeLocked: false, terminalEnrolled: false });
    if (session.contextKind === "account" && !session.user.mustChangePassword) {
      const contexts = await apiRequest<AuthContextsResponse>(
        "/auth/contexts",
        { token: session.token },
      );
      const active = contexts.tenants.filter(
        (item) => item.tenant.status === "active",
      );
      if (active.length === 1)
        await get().switchContext("tenant", active[0]!.tenant.id);
      return;
    }
    if (session.contextKind === "platform" || session.contextKind === "account")
      return;
    const terminal = await getOrCreateTerminalIdentity(
      session.tenantId ?? INITIAL_TENANT_ID,
    );
    if (result.terminal) {
      await markTerminalEnrolled(
        result.terminal.id,
        session.tenantId ?? INITIAL_TENANT_ID,
      );
      set({ terminalEnrolled: true });
      return;
    }
    if (terminal.serverTerminalId) {
      await markTerminalRevoked(
        terminal.serverTerminalId,
        session.tenantId ?? INITIAL_TENANT_ID,
      );
    }
    set({ terminalEnrolled: false });
  },

  upgradeSession: async () => {
    const session = get().session;
    if (!session || get().scopeLocked)
      throw new Error("Pilih konteks yang aktif sebelum memperbarui sesi.");
    if (get().switchingMode) throw new Error(MODE_TRANSITION_BUSY_MESSAGE);
    set({ switchingMode: true });
    let lease: ModeTransitionLease | null = null;
    let replacement: Session | null = null;
    try {
      lease = await beginModeTransition();
      const network = await NetInfo.fetch();
      if (!network.isConnected || network.isInternetReachable === false)
        throw new Error(
          "Pembaruan sesi memerlukan internet. Antrean dan data lama tetap tersimpan.",
        );
      const business = !session.contextKind || session.contextKind === "tenant";
      if (business) {
        await runSync(session);
        if (await countPendingOutbox(session))
          throw new Error(
            "Selesaikan perubahan dan konflik di Pusat Sinkron sebelum memperbarui sesi.",
          );
      }
      const result = await apiRequest<LoginResponse>("/auth/upgrade-session", {
        method: "POST",
        token: session.token,
        body: { protocolVersion: 3 },
      });
      replacement = sessionFromLoginResponse(result);
      await persistSession(replacement, set);
      if (
        (replacement.protocolVersion ?? 2) < 3 ||
        replacement.sandboxQrisPolicy !== "transaction_total"
      )
        throw new Error(
          "Backend belum mendukung Mode Uji nominal penuh. Minta pengelola memperbarui backend; data lama tetap aman.",
        );
      if (business && get().terminalEnrolled) {
        const summary = await runSync(replacement);
        await hydrateSyncStateForSession(replacement, summary);
      }
      set({
        notice:
          "Sesi diperbarui. Transaksi Mode Uji baru menggunakan nominal penuh; transaksi lama tidak berubah.",
      });
    } catch (error) {
      if (replacement && get().session?.token === replacement.token)
        set({
          notice:
            "Sesi baru sudah diterbitkan. Periksa koneksi dan lanjutkan sinkronisasi; jangan hapus data aplikasi.",
        });
      throw error;
    } finally {
      lease?.release();
      set({ switchingMode: false });
    }
  },

  switchContext: async (kind, tenantId) => {
    if (kind === "platform")
      throw new Error(
        "Pengelolaan sekarang menggunakan konteks akun Superadmin.",
      );
    const session = get().session;
    if (!session)
      throw new Error("Masuk terlebih dahulu untuk memilih bisnis.");
    if (get().switchingMode) throw new Error(MODE_TRANSITION_BUSY_MESSAGE);
    set({ switchingMode: true });
    let lease: ModeTransitionLease | null = null;
    let replacement: Session | null = null;
    try {
      lease = await beginModeTransition();
      const network = await NetInfo.fetch();
      if (!network.isConnected || network.isInternetReachable === false)
        throw new Error(
          "Pergantian bisnis memerlukan internet agar data tetap aman.",
        );
      if (
        (!session.contextKind || session.contextKind === "tenant") &&
        !get().scopeLocked
      ) {
        await runSync(session);
        if (await countPendingOutbox(session))
          throw new Error(
            "Selesaikan perubahan dan konflik di Pusat Sinkron sebelum berpindah bisnis.",
          );
      }
      const result = await apiRequest<LoginResponse>("/auth/switch-context", {
        method: "POST",
        token: session.token,
        body: {
          kind,
          ...(tenantId ? { tenantId } : {}),
          installationId: await getOrCreateInstallationId(),
        },
      });
      replacement = sessionFromLoginResponse(result);
      await persistSession(replacement, set);
      set({ scopeLocked: false, terminalEnrolled: false });
      if (!replacement.contextKind || replacement.contextKind === "tenant") {
        await markScopeRevalidated(replacement);
        if (result.terminal) {
          await markTerminalEnrolled(
            result.terminal.id,
            replacement.tenantId ?? INITIAL_TENANT_ID,
          );
          set({ terminalEnrolled: true });
          const summary = await runSync(replacement);
          await hydrateSyncStateForSession(replacement, summary);
        } else {
          const terminal = await getOrCreateTerminalIdentity(
            replacement.tenantId ?? INITIAL_TENANT_ID,
          );
          if (terminal.serverTerminalId)
            await markTerminalRevoked(
              terminal.serverTerminalId,
              replacement.tenantId ?? INITIAL_TENANT_ID,
            );
        }
      }
    } catch (error) {
      if (replacement && get().session?.token === replacement.token)
        set({
          notice:
            "Konteks sudah berganti. Jika sinkronisasi awal belum selesai, periksa koneksi lalu coba lagi.",
        });
      throw error;
    } finally {
      lease?.release();
      set({ switchingMode: false });
    }
  },

  demoLogin: async (role) => {
    if (!get().demoEnabled) {
      throw new Error("Login demo hanya tersedia pada development build.");
    }
    await persistSession(
      {
        token: `dev-only-${role}`,
        contextKind: "tenant",
        tenantId: INITIAL_TENANT_ID,
        tenant: {
          id: INITIAL_TENANT_ID,
          name: "Telomoyo",
          slug: "telomoyo",
          status: "active",
        },
        sessionId: `DEV-SESSION-${role}`,
        user: {
          id: `DEV-${role.toUpperCase()}`,
          fullName: role === "superadmin" ? "Penyok" : "Putu",
          username: role,
          role,
          active: true,
          mustChangePassword: false,
        },
        establishedAt: new Date().toISOString(),
        dataMode: "production",
        dataSpaceId: PRODUCTION_DATA_SPACE_ID,
        sandboxGeneration: null,
      },
      set,
    );
    const terminal = await getOrCreateTerminalIdentity(INITIAL_TENANT_ID);
    if (!terminal.enrolledAt) {
      await markTerminalEnrolled("00000000-0000-4000-8000-000000000099");
    }
    set({ terminalEnrolled: true });
  },

  switchMode: async (mode) => {
    const session = get().session;
    if (!session) throw new Error("Sesi tidak tersedia.");
    if (
      (session.contextKind && session.contextKind !== "tenant") ||
      get().scopeLocked
    )
      throw new Error("Pilih bisnis yang aktif sebelum mengganti mode.");
    if (session.dataMode === mode) return;
    if (session.token.startsWith("dev-only-")) {
      throw new Error("Mode Uji server tidak tersedia pada sesi demo lokal.");
    }
    if (get().switchingMode) {
      throw new Error(MODE_TRANSITION_BUSY_MESSAGE);
    }

    set({ switchingMode: true });
    let nextSession: Session | null = null;
    let replacementDatabaseReady = false;
    let replacementMetadataReady = false;
    let replacementPersisted = false;
    let transitionLease: ModeTransitionLease | null = null;
    try {
      transitionLease = await beginModeTransition();
      const network = await NetInfo.fetch();
      if (!network.isConnected || network.isInternetReachable === false) {
        throw new Error(
          "Pergantian mode memerlukan internet agar data saat ini tetap aman.",
        );
      }

      await runSync(session);
      if ((await countPendingOutbox(session)) > 0) {
        throw new Error(
          "Masih ada perubahan, konflik, atau operasi ditolak yang belum diselesaikan di Pusat Sinkron.",
        );
      }

      const result = await apiRequest<LoginResponse>("/auth/switch-mode", {
        method: "POST",
        token: session.token,
        body: { mode },
      });
      nextSession = sessionFromLoginResponse(result);
      try {
        await writeSession(nextSession);
        replacementPersisted = true;
      } catch (firstWriteError) {
        // The server has already revoked the previous session. Remove its
        // durable copy if possible, prepare the generation-scoped database
        // before exposing the replacement, and retry secure persistence once.
        await clearSession().catch(() => undefined);
        await prepareDatabaseForSession(nextSession);
        replacementDatabaseReady = true;
        try {
          await writeSession(nextSession);
          replacementPersisted = true;
        } catch {
          throw firstWriteError;
        }
      }
      if (!replacementDatabaseReady) {
        await prepareDatabaseForSession(nextSession);
        replacementDatabaseReady = true;
      }
      const summary = await runSync(nextSession);
      await hydrateSyncStateForSession(nextSession, summary);
      replacementMetadataReady = true;
      exposeSession(nextSession, set);
    } catch (error) {
      const affectedSession = nextSession ?? session;
      if (isSessionReauthenticationError(error)) {
        // A replacement can be revoked during its initial pull, before it is
        // exposed to providers. Do not restore it as an incomplete setup.
        if (nextSession && get().session?.token === session.token)
          exposeSession(nextSession, set);
        await handleAccessFailure(affectedSession.token, error.code);
        throw error;
      }
      if (
        affectedSession.dataMode === "sandbox" &&
        isSandboxGenerationRetired(error)
      ) {
        if (!transitionLease) throw error;
        await recoverRetiredSandboxSession(
          affectedSession,
          mode,
          set,
          transitionLease,
        );
        return;
      }
      if (nextSession) {
        let setupError = error;
        if (replacementDatabaseReady && !replacementMetadataReady) {
          try {
            await hydrateSyncStateForSession(nextSession);
            replacementMetadataReady = true;
          } catch (metadataError) {
            setupError = metadataError;
          }
        }
        const localScopeReady =
          replacementDatabaseReady && replacementMetadataReady;
        if (!localScopeReady) {
          resetSyncStateForSession(nextSession);
        }
        exposeSession(
          nextSession,
          set,
          !replacementPersisted
            ? MODE_SESSION_ERROR
            : localScopeReady
              ? null
              : MODE_DATABASE_ERROR,
        );
        throw modeChangedButSetupIncomplete(setupError, {
          localScopeReady,
          durable: replacementPersisted,
        });
      }
      throw error;
    } finally {
      transitionLease?.release();
      set({ switchingMode: false });
    }
  },

  updateProfile: async (fullName) => {
    const release = await beginModeSafeLocalAccess();
    try {
      const session = get().session;
      if (!session || get().scopeLocked)
        throw new Error(
          "Pilih konteks akun yang aktif sebelum mengubah profil.",
        );
      if (session.dataMode === "sandbox")
        throw new Error(
          "Profil hanya dapat diubah dari Mode Produksi atau konteks akun.",
        );
      const result = await apiRequest<Session["user"]>("/profile", {
        method: "PATCH",
        token: session.token,
        body: { fullName: fullName.trim() },
      });
      if (get().session?.token !== session.token || get().scopeLocked) return;
      // Account roles are global, but profile editing changes only the owner's name.
      await persistSession(
        { ...session, user: { ...session.user, fullName: result.fullName } },
        set,
      );
    } finally {
      release();
    }
  },

  changePassword: async (currentPassword, newPassword) => {
    const release = await beginModeSafeLocalAccess();
    try {
      const session = get().session;
      if (!session) throw new Error("Sesi tidak tersedia.");
      if (session.dataMode === "sandbox") {
        throw new Error(
          "Kata sandi tidak dapat diubah dari Mode Uji. Kembali ke Mode Produksi terlebih dahulu.",
        );
      }
      if (!session.token.startsWith("dev-only-")) {
        await apiRequest("/profile/password", {
          method: "POST",
          token: session.token,
          body: { currentPassword, newPassword },
        });
      }
      if (get().session?.token !== session.token || get().scopeLocked) return;
      await persistSession(
        {
          ...session,
          user: { ...session.user, mustChangePassword: false },
        },
        set,
      );
    } finally {
      release();
    }
  },

  enrollTerminal: async (label) => {
    const session = get().session;
    if (!session) throw new Error("Sesi tidak tersedia.");
    if (session.contextKind && session.contextKind !== "tenant")
      throw new Error("Pilih bisnis sebelum mendaftarkan terminal.");
    if (session.dataMode === "sandbox") {
      throw new Error(
        "Terminal tidak dapat didaftarkan dari Mode Uji. Kembali ke Mode Produksi terlebih dahulu.",
      );
    }
    const terminal = await getOrCreateTerminalIdentity(
      session.tenantId ?? INITIAL_TENANT_ID,
    );
    let serverTerminalId = "00000000-0000-4000-8000-000000000099";
    if (!session.token.startsWith("dev-only-")) {
      const publicKey = await getTerminalPublicKeyBase64(
        session.tenantId ?? INITIAL_TENANT_ID,
      );
      const result = await apiRequest<{ id: string }>("/terminals/enroll", {
        method: "POST",
        token: session.token,
        body: {
          installationId: terminal.installationId,
          name: label.trim(),
          publicKey,
          algorithm: "Ed25519",
        },
      });
      serverTerminalId = result.id;
    }
    if (get().session?.token !== session.token || get().scopeLocked) return;
    await markTerminalEnrolled(
      serverTerminalId,
      session.tenantId ?? INITIAL_TENANT_ID,
    );
    set({ terminalEnrolled: true });
    if (!session.token.startsWith("dev-only-")) await runSync(session);
  },

  logout: async () => {
    const session = get().session;
    if (!session) return;
    if (get().switchingMode) {
      throw new Error(MODE_TRANSITION_BUSY_MESSAGE);
    }

    set({ switchingMode: true });
    let transitionLease: ModeTransitionLease | null = null;
    try {
      transitionLease = await beginModeTransition();
      const network = await NetInfo.fetch();
      if (!network.isConnected || network.isInternetReachable === false) {
        throw new Error("Logout memerlukan koneksi internet.");
      }
      // Always join any foreground pull before clearing SecureStore. An active
      // sync may refresh the user snapshot even when the outbox is empty; if it
      // finished after logout it could otherwise restore the revoked session.
      if (
        (!session.contextKind || session.contextKind === "tenant") &&
        !get().scopeLocked
      )
        await runSync(session);
      if (
        (!session.contextKind || session.contextKind === "tenant") &&
        !get().scopeLocked &&
        (await countPendingOutbox(session)) > 0
      ) {
        throw new Error(
          "Masih ada perubahan yang belum tersinkron. Selesaikan sebelum logout.",
        );
      }
      if (!session.token.startsWith("dev-only-")) {
        await apiRequest("/auth/logout", {
          method: "POST",
          token: session.token,
        });
      }
      try {
        await clearSession(session.token);
      } catch (error) {
        setModeFromSession(null);
        resetSyncStateForSession(null);
        set({
          session: null,
          terminalEnrolled: false,
          bootError: LOGOUT_STORAGE_ERROR,
        });
        throw error;
      }
      if (get().session?.token !== session.token) return;
      setModeFromSession(null);
      resetSyncStateForSession(null);
      set({
        session: null,
        terminalEnrolled: false,
        bootError: null,
        scopeLocked: false,
      });
    } catch (error) {
      if (isSessionReauthenticationError(error)) {
        // Sync or /auth/logout may discover that the server already revoked
        // this token. Local sign-out must not depend on syncing it successfully.
        await handleAccessFailure(session.token, error.code);
        return;
      }
      if (session.dataMode === "sandbox" && isSandboxGenerationRetired(error)) {
        // Logout never rotates into another authenticated session. Clear only
        // the retired Sandbox scope and retain the normal Production default.
        set({ session: null, terminalEnrolled: false, bootError: null });
        resetSyncStateForSession(null);
        await retireSandboxSession(session);
        return;
      }
      throw error;
    } finally {
      transitionLease?.release();
      set({ switchingMode: false });
    }
  },
}));

async function invalidateSession(token: string, code: string): Promise<void> {
  const auth = useAuthStore.getState();
  // Headless sync can run before AuthProvider hydrates. Only the matching
  // durable token may be invalidated then; never infer a session from a scope.
  const fromStorage = !auth.session && auth.booting;
  const session = fromStorage ? await readSession() : auth.session;
  if (session?.token !== token) return;
  const current = useAuthStore.getState();
  if (
    current.session?.token !== token &&
    !(fromStorage && current.booting && !current.session)
  )
    return;
  const epoch = ++sessionInvalidationEpoch;
  const stillCurrent = () => {
    const current = useAuthStore.getState();
    return (
      current.session?.token === token ||
      (fromStorage && !current.session && sessionInvalidationEpoch === epoch)
    );
  };
  const accountChanged = code === "ACCOUNT_ACCESS_CHANGED";
  const message = accountChanged
    ? "Akses akun atau kata sandi berubah. Masuk kembali untuk melanjutkan. Data yang belum tersinkron tetap diamankan pada bisnis asalnya."
    : SESSION_INVALID_MESSAGE;
  useModeStore.setState({ accessBlocked: true });
  useAuthStore.setState({ scopeLocked: true, notice: message });
  try {
    // Do not wait on a transition here: this callback may run inside a sync,
    // logout, profile update, or print that already owns a local/transition lease.
    if (!session.contextKind || session.contextKind === "tenant")
      await quarantineScope(session, accountChanged ? code : "SESSION_INVALID");
    if (!stillCurrent()) return;
    await clearSession(token, message);
    if (stillCurrent()) {
      setModeFromSession(null);
      resetSyncStateForSession(null);
      useAuthStore.setState({
        session: null,
        terminalEnrolled: false,
        scopeLocked: false,
        bootError: null,
        notice: message,
      });
    }
  } catch (error) {
    if (stillCurrent())
      useAuthStore.setState({
        bootError:
          "Sesi tidak valid dan akses sudah dikunci, tetapi penyimpanan lokal belum dapat diamankan. Jangan hapus data aplikasi; coba keluar lagi atau hubungi pengelola.",
      });
    throw error;
  }
}

async function handleAccessFailure(token: string, code: string): Promise<void> {
  if (requiresSessionReauthentication(code)) {
    const pending = sessionInvalidations.get(token);
    if (pending) return pending;
    const invalidation = invalidateSession(token, code).finally(() => {
      if (sessionInvalidations.get(token) === invalidation)
        sessionInvalidations.delete(token);
    });
    sessionInvalidations.set(token, invalidation);
    return invalidation;
  }
  const auth = useAuthStore.getState();
  if (!SCOPE_ACCESS_CODES.has(code) || auth.session?.token !== token) return;
  const session = auth.session;
  if (session.contextKind && session.contextKind !== "tenant") return;
  useAuthStore.setState({
    scopeLocked: true,
    notice:
      "Akses bisnis ini dihentikan. Data yang belum tersinkron diamankan di perangkat. Pilih bisnis lain atau hubungi pengelola.",
  });
  useModeStore.setState({ accessBlocked: true });
  await quarantineScope(session, code);
}

registerAccessFailureHandler(handleAccessFailure);
