export const SESSION_INVALID_MESSAGE =
  "Sesi Anda sudah tidak valid atau telah dicabut. Silakan masuk kembali. Data yang belum tersinkron tetap tersimpan aman di perangkat.";

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
