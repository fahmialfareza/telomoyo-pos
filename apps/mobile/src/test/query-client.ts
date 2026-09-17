import { createQueryClient } from "@/api/query-client";

/** Isolated client for tests: no retries and no cache GC timers. */
export function createTestQueryClient() {
  return createQueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false, gcTime: 0 },
    },
  });
}
