export const SESSION_INVALID_MESSAGE =
  "Sesi Anda sudah tidak valid atau telah dicabut. Silakan masuk kembali. Data yang belum tersinkron tetap tersimpan aman di perangkat.";

export const SANDBOX_DISABLED_CODE = "SANDBOX_DISABLED";
export const SANDBOX_DISABLED_MESSAGE =
  "Mode Uji telah dinonaktifkan untuk bisnis ini. Data dan antrean Mode Uji tetap tersimpan; kembali ke Mode Produksi untuk melanjutkan.";

export function isSandboxDisabledError(
  error: unknown,
): error is { code: string } {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === SANDBOX_DISABLED_CODE
  );
}

export function requiresSessionReauthentication(code: string): boolean {
  return (
    code === "UNAUTHORIZED" ||
    code === "HTTP_401" ||
    code === "ACCOUNT_ACCESS_CHANGED"
  );
}

export function isSessionReauthenticationError(
  error: unknown,
): error is { code: string; status?: number } {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const failure = error as { code?: unknown; status?: unknown };
  return (
    typeof failure.code === "string" &&
    requiresSessionReauthentication(failure.code) &&
    (failure.status === 401 || failure.code === "ACCOUNT_ACCESS_CHANGED")
  );
}
