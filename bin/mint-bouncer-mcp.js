#!/usr/bin/env node
// Bin entrypoint: always starts the stdio server.
const { main } = await import('../dist/server.js');
await main().catch((e) => {
  console.error(`[mint-bouncer] fatal: ${e.message}`);
  process.exit(1);
});
