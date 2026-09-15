import Constants from "expo-constants";

import {
  INVALID_SERVER_RESPONSE_MESSAGE,
  SERVER_UNREACHABLE_MESSAGE,
} from "@/utils/errors";

import type { ApiEnvelope, ApiErrorEnvelope } from "./contracts";

let accessFailureHandler:
  ((token: string, code: string) => Promise<void>) | null = null;
export function registerAccessFailureHandler(
  handler: (token: string, code: string) => Promise<void>,
): void {
  accessFailureHandler = handler;
}
export async function noticeAccessFailure(
  token: string,
  code: string,
): Promise<void> {
  await accessFailureHandler?.(token, code);
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly requestId?: string | undefined;
  readonly diagnosticCause?: unknown;

  constructor(input: {
    status: number;
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
    diagnosticCause?: unknown;
  }) {
    super(input.message);
    this.name = "ApiError";
    this.status = input.status;
    this.code = input.code;
    this.details = input.details;
    this.requestId = input.requestId;
    if (input.diagnosticCause !== undefined) {
      Object.defineProperty(this, "diagnosticCause", {
        configurable: true,
        value: input.diagnosticCause,
      });
    }
  }
}

export function getApiBaseUrl(): string {
  // Expo supplies these values in the JS bundle. Prefer them over the native
  // manifest, which can still contain the URL from the last Android build.
  // Keep dotted process.env access so Expo can statically transform it.
  const environmentUrl =
    process.env.EXPO_PUBLIC_API_BASE_URL?.trim() ||
    process.env.EXPO_PUBLIC_API_URL?.trim();
  const manifestUrl = Constants.expoConfig?.extra?.apiUrl;
  const configured =
    environmentUrl ||
    (typeof manifestUrl === "string" ? manifestUrl.trim() : "") ||
    "http://10.0.2.2:8000/api/v1";
  return configured.replace(/\/$/, "");
}

export async function apiRequest<T>(
  path: string,
  options: {
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    token?: string;
    body?: unknown;
    signal?: AbortSignal;
    headers?: Record<string, string>;
  } = {},
): Promise<T> {
  let response: Response;
  try {
    const request: RequestInit = {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/json",
        ...(options.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...options.headers,
      },
    };
    if (options.body !== undefined) {
      request.body = JSON.stringify(options.body);
    }
    if (options.signal !== undefined) {
      request.signal = options.signal;
    }
    response = await fetch(`${getApiBaseUrl()}${path}`, request);
  } catch (error) {
    throw new ApiError({
      status: 0,
      code: "NETWORK_UNAVAILABLE",
      message: SERVER_UNREACHABLE_MESSAGE,
      diagnosticCause: error,
    });
  }

  const contentType = response.headers.get("content-type");
  let payload: ApiEnvelope<T> | ApiErrorEnvelope | null = null;
  if (contentType?.includes("application/json") === true) {
    try {
      payload = (await response.json()) as ApiEnvelope<T> | ApiErrorEnvelope;
    } catch (error) {
      throw new ApiError({
        status: response.status,
        code: "INVALID_RESPONSE",
        message: INVALID_SERVER_RESPONSE_MESSAGE,
        diagnosticCause: error,
      });
    }
  }

  if (!response.ok) {
    const error =
      payload && "error" in payload
        ? payload.error
        : {
            code: `HTTP_${response.status}`,
            message: "Permintaan tidak dapat diproses.",
          };
    if (options.token && accessFailureHandler)
      // Local cleanup errors must not hide the server's authentication result.
      // The handler keeps the affected scope locked if persistence fails.
      await accessFailureHandler(options.token, error.code).catch(
        () => undefined,
      );
    throw new ApiError({
      status: response.status,
      code: error.code,
      message: error.message,
      ...("details" in error ? { details: error.details } : {}),
      ...(!("requestId" in error) || error.requestId === undefined
        ? {}
        : { requestId: error.requestId }),
    });
  }

  if (!payload || !("data" in payload)) {
    throw new ApiError({
      status: response.status,
      code: "INVALID_RESPONSE",
      message: INVALID_SERVER_RESPONSE_MESSAGE,
    });
  }
  return payload.data;
}
