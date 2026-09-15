import {
  ApiError,
  apiRequest,
  registerAccessFailureHandler,
} from "@/api/client";
import {
  INVALID_SERVER_RESPONSE_MESSAGE,
  SERVER_UNREACHABLE_MESSAGE,
} from "@/utils/errors";

const originalFetch = globalThis.fetch;
const mockFetch = jest.fn();
const mockAccessFailure = jest.fn<Promise<void>, [string, string]>();

describe("API client error boundary", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockAccessFailure.mockReset().mockResolvedValue(undefined);
    registerAccessFailureHandler(mockAccessFailure);
    globalThis.fetch = mockFetch as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("keeps native connection details diagnostic-only", async () => {
    const nativeError = new TypeError(
      "fetch failed: java.net.ConnectException: Failed to connect to /192.168.18.254:8080",
    );
    mockFetch.mockRejectedValue(nativeError);

    const error = await apiRequest("/users").catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 0,
      code: "NETWORK_UNAVAILABLE",
      message: SERVER_UNREACHABLE_MESSAGE,
      diagnosticCause: nativeError,
    });
    expect((error as Error).message).not.toMatch(
      /java|192\.168\.18\.254|8080/i,
    );
  });

  it("translates malformed JSON without exposing parser details", async () => {
    const parserError = new SyntaxError("Unexpected token <");
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: () => Promise.reject(parserError),
    } as unknown as Response);

    await expect(apiRequest("/users")).rejects.toMatchObject({
      status: 200,
      code: "INVALID_RESPONSE",
      message: INVALID_SERVER_RESPONSE_MESSAGE,
      diagnosticCause: parserError,
    });
  });

  it("preserves backend domain messages intended for users", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 422,
      headers: { get: () => "application/json" },
      json: () =>
        Promise.resolve({
          error: {
            code: "VALIDATION_ERROR",
            message: "Username sudah digunakan.",
            details: {},
            requestId: "REQUEST-1",
          },
        }),
    } as unknown as Response);

    await expect(apiRequest("/users")).rejects.toMatchObject({
      status: 422,
      code: "VALIDATION_ERROR",
      message: "Username sudah digunakan.",
      requestId: "REQUEST-1",
    });
  });

  it.each(["UNAUTHORIZED", "HTTP_401"])(
    "reports a top-level %s for the exact bearer token before rejecting",
    async (code) => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        headers: {
          get: () => (code === "HTTP_401" ? "text/plain" : "application/json"),
        },
        json: async () => ({
          error: { code, message: "Sesi tidak valid atau telah dicabut" },
        }),
      });
      await expect(
        apiRequest("/sync/pull", { token: "revoked-token" }),
      ).rejects.toMatchObject({ status: 401, code });
      expect(mockAccessFailure).toHaveBeenCalledTimes(1);
      expect(mockAccessFailure).toHaveBeenCalledWith("revoked-token", code);
    },
  );

  it("does not invalidate auth for a failed login without a bearer token", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      headers: { get: () => "application/json" },
      json: async () => ({
        error: { code: "UNAUTHORIZED", message: "Kredensial salah" },
      }),
    });
    await expect(
      apiRequest("/auth/login", { method: "POST" }),
    ).rejects.toMatchObject({ status: 401 });
    expect(mockAccessFailure).not.toHaveBeenCalled();
  });

  it("keeps the original API error when local invalidation cleanup fails", async () => {
    mockAccessFailure.mockRejectedValue(new Error("SecureStore unavailable"));
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      headers: { get: () => "application/json" },
      json: async () => ({
        error: {
          code: "UNAUTHORIZED",
          message: "Sesi tidak valid atau telah dicabut",
        },
      }),
    });
    await expect(
      apiRequest("/auth/logout", { token: "revoked-token", method: "POST" }),
    ).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
      message: "Sesi tidak valid atau telah dicabut",
    });
  });

  it("does not treat a rejected offline origin inside a successful sync envelope as a revoked uploading session", async () => {
    const data = {
      results: [
        {
          operationId: "old-operation",
          status: "rejected",
          error: { code: "UNAUTHORIZED", message: "Origin tidak valid" },
        },
      ],
    };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ data }),
    });
    await expect(
      apiRequest("/sync/push", { token: "valid-token", method: "POST" }),
    ).resolves.toEqual(data);
    expect(mockAccessFailure).not.toHaveBeenCalled();
  });
});
