import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ApiResult } from './api-client';

export function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/** An API failure becomes an MCP tool error carrying the API's status and message. */
export function apiFailure(result: ApiResult): CallToolResult {
  const body = result.data;
  const message =
    typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
      ? body.error
      : typeof body === 'string' && body !== ''
        ? body
        : 'Request failed';
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ status: result.status, error: message }) }],
  };
}

/** Pass a successful API body through `shape`; turn anything else into a tool error. */
export function respond(result: ApiResult, shape: (data: unknown) => unknown): CallToolResult {
  return result.ok ? jsonResult(shape(result.data)) : apiFailure(result);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The listed fields of `source` that are present, in order. */
export function pick(source: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = asRecord(source);
  return Object.fromEntries(keys.filter(key => key in record).map(key => [key, record[key]]));
}
