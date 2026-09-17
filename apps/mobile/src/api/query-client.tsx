import {
  QueryClient,
  QueryClientProvider,
  type QueryClientConfig,
} from "@tanstack/react-query";
import type { ReactNode } from "react";

import { ApiError } from "./client";

export const QUERY_STALE_TIME_MS = 30_000;
export const QUERY_MAX_RETRY_ATTEMPTS = 3;
export const QUERY_RETRY_DELAY_CAP_MS = 15_000;

/**
 * Retry only transient failures: unreachable server (status 0, e.g. a sleeping
 * Railway backend waking from cold start) or server-side errors (5xx). Client
 * errors (4xx, auth/session codes) are never retried — they flow through the
 * API client's access-failure handler instead.
 */
export function shouldRetryQuery(
  failureCount: number,
  error: unknown,
): boolean {
  if (failureCount >= QUERY_MAX_RETRY_ATTEMPTS) return false;
  if (!(error instanceof ApiError)) return false;
  return error.status === 0 || error.status >= 500;
}

/** Exponential backoff (1s, 2s, 4s, …) capped and jittered. */
export function queryRetryDelay(attemptIndex: number): number {
  const exponential = 1000 * 2 ** attemptIndex;
  const capped = Math.min(exponential, QUERY_RETRY_DELAY_CAP_MS);
  return capped / 2 + Math.random() * (capped / 2);
}

export function createQueryClient(
  overrides: QueryClientConfig = {},
): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: QUERY_STALE_TIME_MS,
        networkMode: "online",
        retry: shouldRetryQuery,
        retryDelay: queryRetryDelay,
        ...(overrides.defaultOptions?.queries ?? {}),
      },
      mutations: {
        networkMode: "online",
        retry: false,
        ...(overrides.defaultOptions?.mutations ?? {}),
      },
    },
  });
}

export const queryClient = createQueryClient();

export function AppQueryProvider({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
}
