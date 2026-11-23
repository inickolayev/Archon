import type { Context } from 'hono';
// Imported from the pure config module rather than the barrel: route tests mock '../auth'.
import { webAuthHeaderName } from '../auth/config';

/** What a tool sees of one in-process REST call. */
export interface ApiResult {
  status: number;
  ok: boolean;
  /** Parsed JSON body, or the raw text when the body is not JSON. */
  data: unknown;
}

export interface ApiCallOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

export type ApiCall = (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  options?: ApiCallOptions
) => Promise<ApiResult>;

/** The slice of the Hono app the client needs; `app.request` runs a request in-process. */
export interface InProcessApp {
  request: (input: string, init?: RequestInit) => Response | Promise<Response>;
}

/**
 * The caller's own credentials, forwarded verbatim so every tool call is
 * authenticated and authorized by the same /api/* gate as a direct REST call:
 * a tool can never do more than the token's owner could with curl.
 */
function forwardedCredentialHeaders(c: Context): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const name of ['authorization', 'cookie', webAuthHeaderName()]) {
    const value = c.req.header(name);
    if (value !== undefined) forwarded[name] = value;
  }
  return forwarded;
}

export function createInProcessApiCall(app: InProcessApp, c: Context): ApiCall {
  const credentials = forwardedCredentialHeaders(c);
  return async (method, path, options = {}) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) search.set(key, String(value));
    }
    const url = search.size > 0 ? `${path}?${search.toString()}` : path;
    const response = await app.request(url, {
      method,
      headers: {
        ...credentials,
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    let data: unknown = text;
    try {
      data = text === '' ? null : JSON.parse(text);
    } catch {
      // Not JSON: keep the text so the error reaches the caller as the API wrote it.
    }
    return { status: response.status, ok: response.ok, data };
  };
}
