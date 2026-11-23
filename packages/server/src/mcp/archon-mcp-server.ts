import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ApiCall } from './api-client';
import { registerChatTools, type ChatToolDeps } from './chat-tools';
import { registerRunTools } from './run-tools';

/**
 * The factory's MCP surface. A server is built per request (the endpoint is
 * stateless), and every tool is a thin wrapper over the REST API through `call`,
 * so validation, authorization and schemas stay where the routes define them.
 */
export function createArchonMcpServer(call: ApiCall, deps: ChatToolDeps = {}): McpServer {
  const server = new McpServer({ name: 'archon', version: '1.0.0' });
  registerChatTools(server, call, deps);
  registerRunTools(server, call);
  return server;
}
