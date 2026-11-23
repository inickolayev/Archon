import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createInProcessApiCall } from '../mcp/api-client';
import { createArchonMcpServer } from '../mcp/archon-mcp-server';
import type { ChatToolDeps } from '../mcp/chat-tools';
import { getLog } from './api-route-kit';

export const MCP_PATH = '/api/mcp';

/**
 * Streamable HTTP MCP endpoint, stateless: each POST gets its own transport and
 * server, there is no session to resume, and GET (server-initiated stream) and
 * DELETE (session end) are answered 405. Not part of the OpenAPI document: it
 * speaks JSON-RPC, not a REST resource. The /api/* gate has already
 * authenticated the request by the time this runs.
 */
export function registerMcpRoute(app: OpenAPIHono, deps: ChatToolDeps = {}): void {
  const methodNotAllowed = (c: Context): Response =>
    c.json({ error: 'Method not allowed: this MCP endpoint is stateless, use POST' }, 405, {
      Allow: 'POST',
    });
  app.get(MCP_PATH, methodNotAllowed);
  app.delete(MCP_PATH, methodNotAllowed);

  app.post(MCP_PATH, async c => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = createArchonMcpServer(createInProcessApiCall(app, c), deps);
    try {
      await server.connect(transport);
      return await transport.handleRequest(c.req.raw);
    } catch (err) {
      getLog().error({ err: err as Error }, 'mcp.request_failed');
      return c.json({ error: 'MCP request failed' }, 500);
    } finally {
      // The response is fully built (JSON mode) before handleRequest resolves.
      void server.close().catch(() => undefined);
    }
  });
}
