/**
 * Mint Bouncer MCP server — screen wallets for mint whitelists.
 *
 * Four tools, all read-only. This server never signs, never holds keys,
 * never moves funds. It reads public onchain history and returns verdicts
 * with cited evidence.
 *
 *   bouncer_screen_wallet  — allow / deny / review + per-signal scores
 *   bouncer_funding_trace  — where the first funds came from, hop by hop
 *   bouncer_cluster_check  — sybil clusters across applicant wallets
 *   bouncer_screen_batch   — screen a whole applicant list at once
 *
 * Run: npx -y 402-mint-bouncer-mcp@latest   (published package)
 *      npm run mcp                          (from source)
 */
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createMintBouncerService } from './service.js';

/** JSON with bigints rendered as decimal strings. */
function textResult(value: unknown): {
  content: { type: 'text'; text: string }[];
} {
  const text = JSON.stringify(
    value,
    (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
    2,
  );
  return { content: [{ type: 'text', text }] };
}

function errorResult(message: string, detail?: unknown) {
  return textResult({ ok: false, error: message, ...(detail !== undefined ? { detail } : {}) });
}

const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'address must be a 0x EVM address');
const chainSchema = z
  .string()
  .optional()
  .describe('Chain key (default "ink"). See bouncer_chains via the service — currently ink.');

export function createMintBouncerServer(): McpServer {
  const svc = createMintBouncerService();
  const server = new McpServer(
    { name: 'mint-bouncer', version: '0.2.0' },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    'bouncer_screen_wallet',
    {
      description:
        'Screen one wallet for a mint whitelist. Returns allow / deny / review with per-signal risk scores (flip rate, dump rate, wallet age, funding freshness), plain-words reasons, and cited explorer links for every claim. Read-only.',
      inputSchema: {
        address: addressSchema.describe('The applicant wallet to screen'),
        chain: chainSchema,
      },
    },
    async (args) => {
      try {
        return textResult({ ok: true, ...(await svc.screenWallet(args)) });
      } catch (e) {
        return errorResult('screen_wallet failed', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'bouncer_funding_trace',
    {
      description:
        'Trace where a wallet\'s first funds came from, hop by hop: the earliest incoming transfer, then the earliest incoming transfer of that sender, and so on. Flags fresh funders (sybil smell). Read-only.',
      inputSchema: {
        address: addressSchema.describe('The wallet to trace'),
        depth: z.number().int().min(1).max(5).optional().describe('How many hops back. Default 3.'),
        chain: chainSchema,
      },
    },
    async (args) => {
      try {
        return textResult({ ok: true, ...(await svc.fundingTrace(args)) });
      } catch (e) {
        return errorResult('funding_trace failed', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'bouncer_cluster_check',
    {
      description:
        'Sybil check across applicant wallets: groups them by first funder. Wallets sharing one funder are one cluster and deserve one decision, not N. Read-only.',
      inputSchema: {
        addresses: z.array(addressSchema).min(1).max(200).describe('Applicant wallets to compare'),
        chain: chainSchema,
      },
    },
    async (args) => {
      try {
        return textResult({ ok: true, ...(await svc.clusterCheck(args)) });
      } catch (e) {
        return errorResult('cluster_check failed', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'bouncer_screen_batch',
    {
      description:
        'Screen a whole whitelist applicant list at once: per-wallet verdicts, an allow/deny/review tally, and the sybil clusters across the batch. Read-only.',
      inputSchema: {
        addresses: z.array(addressSchema).min(1).max(50).describe('Applicant wallets'),
        chain: chainSchema,
      },
    },
    async (args) => {
      try {
        return textResult({ ok: true, ...(await svc.screenBatch(args)) });
      } catch (e) {
        return errorResult('screen_batch failed', (e as Error).message);
      }
    },
  );

  return server;
}

// ---- stdio entrypoint ----

async function main(): Promise<void> {
  const server = createMintBouncerServer();
  const transport = new StdioServerTransport();
  // Never log to stdout: it corrupts the MCP stdio protocol. stderr only.
  console.error('[mint-bouncer] serving over stdio');
  await server.connect(transport);
}

export { main };

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`[mint-bouncer] fatal: ${(e as Error).message}`);
    process.exit(1);
  });
}
