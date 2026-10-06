/**
 * Chain data access for Mint Bouncer.
 *
 * Reads wallet history from Blockscout-compatible explorer APIs (Ink first;
 * any EVM chain with a Blockscout API can be added to CHAINS). All reads,
 * no signing, no keys. fetchFn is injectable for tests.
 */

export interface ChainConfig {
  /** Human name, e.g. "Ink". */
  name: string;
  /** EVM chain id. */
  id: number;
  /** Blockscout API root, e.g. https://explorer.inkonchain.com/api */
  explorerApi: string;
  /** Explorer URL for linking transactions, e.g. https://explorer.inkonchain.com */
  explorerUrl: string;
}

export const CHAINS: Record<string, ChainConfig> = {
  ink: {
    name: 'Ink',
    id: 57073,
    explorerApi: 'https://explorer.inkonchain.com/api',
    explorerUrl: 'https://explorer.inkonchain.com',
  },
};

export function resolveChain(chain?: string): ChainConfig {
  const key = (chain ?? 'ink').toLowerCase();
  const cfg = CHAINS[key];
  if (!cfg) {
    throw new Error(
      `unknown chain "${chain}": supported chains are ${Object.keys(CHAINS).join(', ')}`,
    );
  }
  return cfg;
}

/** A native-currency transaction, Blockscout shape (string fields). */
export interface ChainTx {
  hash: string;
  blockNumber: string;
  timeStamp: string;
  from: string;
  to: string;
  value: string; // wei, decimal string
  input: string;
  contractAddress: string; // created contract, if any
  isError: string; // "0" | "1"
}

/** An ERC-20 / ERC-721 / ERC-1155 transfer, Blockscout shape. */
export interface ChainTransfer {
  hash: string;
  blockNumber: string;
  timeStamp: string;
  from: string;
  to: string;
  contractAddress: string;
  tokenID: string; // NFTs; "" for ERC-20
  tokenName: string;
  tokenSymbol: string;
  value: string; // ERC-20 amount / ERC-1155 qty
}

export type FetchFn = typeof fetch;

async function apiGet(
  cfg: ChainConfig,
  params: Record<string, string>,
  fetchFn: FetchFn,
): Promise<unknown[]> {
  const url = new URL(cfg.explorerApi);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetchFn(url.toString());
  if (!res.ok) throw new Error(`explorer API HTTP ${res.status} on ${cfg.name}`);
  const body = (await res.json()) as { message?: string; result?: unknown };
  if (body.message !== 'OK') {
    throw new Error(`explorer API error on ${cfg.name}: ${body.message ?? 'unknown'}`);
  }
  const result = body.result;
  if (typeof result === 'string') return []; // "No transactions found" etc.
  if (!Array.isArray(result)) throw new Error(`explorer API returned unexpected shape on ${cfg.name}`);
  return result as unknown[];
}

async function paged(
  cfg: ChainConfig,
  action: string,
  address: string,
  fetchFn: FetchFn,
  maxPages: number,
  pageSize = 100,
): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const rows = await apiGet(
      cfg,
      {
        module: 'account',
        action,
        address,
        page: String(page),
        offset: String(pageSize),
        sort: 'desc',
      },
      fetchFn,
    );
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

const asTx = (r: unknown): ChainTx => r as ChainTx;
const asTransfer = (r: unknown): ChainTransfer => r as ChainTransfer;

/** Native transactions, newest first. Caps at maxPages * pageSize rows. */
export async function getTxList(
  cfg: ChainConfig,
  address: string,
  fetchFn: FetchFn = fetch,
  maxPages = 5,
): Promise<ChainTx[]> {
  return (await paged(cfg, 'txlist', address, fetchFn, maxPages)).map(asTx);
}

/** ERC-721 + ERC-1155 transfers, newest first. */
export async function getNftTransfers(
  cfg: ChainConfig,
  address: string,
  fetchFn: FetchFn = fetch,
  maxPages = 5,
): Promise<ChainTransfer[]> {
  return (await paged(cfg, 'tokennfttx', address, fetchFn, maxPages)).map(asTransfer);
}

/** ERC-20 transfers, newest first. */
export async function getTokenTransfers(
  cfg: ChainConfig,
  address: string,
  fetchFn: FetchFn = fetch,
  maxPages = 5,
): Promise<ChainTransfer[]> {
  return (await paged(cfg, 'tokentx', address, fetchFn, maxPages)).map(asTransfer);
}

export function txUrl(cfg: ChainConfig, hash: string): string {
  return `${cfg.explorerUrl}/tx/${hash}`;
}

export function addressUrl(cfg: ChainConfig, address: string): string {
  return `${cfg.explorerUrl}/address/${address}`;
}
