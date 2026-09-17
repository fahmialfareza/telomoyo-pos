import { ApiError } from "@/api/client";
import {
  queryRetryDelay,
  QUERY_MAX_RETRY_ATTEMPTS,
  QUERY_RETRY_DELAY_CAP_MS,
  shouldRetryQuery,
} from "@/api/query-client";

describe("shouldRetryQuery", () => {
  it.each([0, 500, 502, 503, 503, 599])(
    "retries transient status %s",
    (status) => {
      expect(
        shouldRetryQuery(1, new ApiError({ status, code: "X", message: "x" })),
      ).toBe(true);
    },
  );

  it.each([400, 401, 403, 404, 409, 422])("never retries status %s", (status) => {
    expect(
      shouldRetryQuery(1, new ApiError({ status, code: "X", message: "x" })),
    ).toBe(false);
  });

  it("never retries non-ApiError failures", () => {
    expect(shouldRetryQuery(1, new Error("boom"))).toBe(false);
    expect(shouldRetryQuery(1, undefined)).toBe(false);
  });

  it("stops at the retry attempt budget", () => {
    const error = new ApiError({ status: 0, code: "X", message: "x" });
    expect(shouldRetryQuery(QUERY_MAX_RETRY_ATTEMPTS - 1, error)).toBe(true);
    expect(shouldRetryQuery(QUERY_MAX_RETRY_ATTEMPTS, error)).toBe(false);
    expect(shouldRetryQuery(QUERY_MAX_RETRY_ATTEMPTS + 1, error)).toBe(false);
  });
});

describe("queryRetryDelay", () => {
  it("grows exponentially and stays within the cap", () => {
    const seen = new Set<number>();
    for (let attempt = 0; attempt < 10; attempt++) {
      const delay = queryRetryDelay(attempt);
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(QUERY_RETRY_DELAY_CAP_MS);
      seen.add(delay);
    }
    // Jitter makes repeats unlikely but not impossible; the first attempts
    // must clearly grow on average.
    const early = queryRetryDelay(0);
    const late = Array.from({ length: 20 }, () => queryRetryDelay(4));
    const lateAverage = late.reduce((a, b) => a + b, 0) / late.length;
    expect(lateAverage).toBeGreaterThan(early);
  });
});
