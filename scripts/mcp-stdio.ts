// MCP over stdio, for hosts that spawn the server as a local process (LM Studio, Claude Desktop).
// Run with `node scripts/mcp-stdio.ts` directly, not via npm, which writes to stdout.
// Set ROOTRULES_DIST to use a dist/ directory elsewhere.

import path from 'node:path';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createRootRulesServer } from '../src/server/mcp.ts';
import { RulebookStore } from '../src/server/store.ts';
import { PROJECT_ROOT } from '../src/snapshot.ts';

const dist = path.resolve(process.env.ROOTRULES_DIST ?? path.join(PROJECT_ROOT, 'dist'));
const store = new RulebookStore(path.join(dist, 'rulebook.json'));
store.get();

serveStdio(() => createRootRulesServer(() => store.get()));
console.error('root-rules: serving MCP on stdio');
