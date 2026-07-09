#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAriadneMcpServer } from './server.js';

/**
 * Entry point for the `ariadne-mcp-server` binary: any MCP-capable client
 * (Copilot Chat, Copilot CLI, Claude Code, Gemini CLI, Codex, custom agents)
 * spawns this over stdio and gets the same task state the `ariadne` CLI and
 * VS Code extension read/write.
 */
async function main(): Promise<void> {
  const server = createAriadneMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('ariadne-mcp-server failed to start:', err);
    process.exit(1);
  });
}

export { createAriadneMcpServer } from './server.js';
