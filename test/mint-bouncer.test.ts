/**
 * Mint Bouncer tests.
 *
 *   npx tsx test/mint-bouncer.test.ts
 *
 * Covers: NFT holding pairing, funding-trace walks, the scoring verdicts
 * (flipper → deny, dumper → deny, fresh wallet → review, clean → allow,
 * no history → review), sybil clustering, and service input validation.
 *
 * Pure scoring tests use fixtures; service tests use a mock fetch.
 * No network, no keys, nothing signed. Deterministic.
 */
import assert from 'node:assert/strict';
import {
  clusterByFunder,
  pairNftHoldings,
  screenWallet,
  traceFunding,
  type FundingHop,
} from '../src/scoring.js';
import type { ChainTransfer, ChainTx, FetchFn } from '../src/chain.js';
import { createMintBouncerService } from '../src/service.js';

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ok: ${name}`);
  } catch (e) {
    console.error(`  FAIL: ${name}\n    ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

const W = '0x' + 'aa'.repeat(20);
const F = '0x' + 'bb'.repeat(20);
const G = '0x' + 'cc'.repeat(20);
const NOW = 1_800_000_000;
const DAY = 86400;
const txUrl = (h: string) => `https://explorer/tx/${h}`;

function nft(
  from: string,
  to: string,
  ts: number,
  tokenID: string,
  contract = '0x' + 'dd'.repeat(20),
  hash = `0x${tokenID}${'00'.repeat(30)}`.slice(0, 66),
): ChainTransfer {
  return {
    hash, blockNumber: '1', timeStamp: String(ts), from, to,
    contractAddress: contract, tokenID, tokenName: 'T', tokenSymbol: 'T', value: '1',
  };
}

function tok(
  from: string,
  to: string,
  ts: number,
  contract = '0x' + 'ee'.repeat(20),
  hash = `0x${'11'.repeat(20)}${String(ts).slice(-4)}`.slice(0, 66).padEnd(66, '0'),
): ChainTransfer {
  return {
    hash, blockNumber: '1', timeStamp: String(ts), from, to,
    contractAddress: contract, tokenID: '', tokenName: 'T', tokenSymbol: 'T', value: '100',
  };
}

function tx(from: string, to: string, ts: number, value = '1000000000000000'): ChainTx {
  return {
    hash: `0x${'22'.repeat(20)}${String(ts).slice(-6)}`.slice(0, 66).padEnd(66, '0'),
    blockNumber: '1', timeStamp: String(ts), from, to, value,
    input: '0x', contractAddress: '', isError: '0',
  };
}

// ---------- pairing ----------

await check('pairNftHoldings pairs acquisitions with first later disposal', () => {
  const transfers = [
    nft('0x' + '00'.repeat(20), W, 1000, '1'),
    nft(W, '0x' + 'ff'.repeat(20), 2000, '1'), // held 1000s → flip
    nft('0x' + '00'.repeat(20), W, 3000, '2'), // never sold
  ];
  const holdings = pairNftHoldings(W, transfers);
  assert.equal(holdings.length, 2);
  assert.equal(holdings[0].disposedTs, 2000);
  assert.equal(holdings[1].disposedTs, null);
});

// ---------- funding trace ----------

await check('traceFunding walks back earliest incoming transfers', async () => {
  const byAddr: Record<string, ChainTx[]> = {
    [W.toLowerCase()]: [tx(F, W, 100), tx(F, W, 200)],
    [F.toLowerCase()]: [tx(G, F, 50)],
    [G.toLowerCase()]: [],
  };
  const hops = await traceFunding(
    W,
    async (addr) => byAddr[addr.toLowerCase()] ?? [],
    3,
  );
  assert.equal(hops.length, 2);
  assert.equal(hops[0].from, F);
  assert.equal(hops[0].timeStamp, 100); // earliest, not latest
  assert.equal(hops[1].from, G);
});

// ---------- verdicts ----------

function baseInput(over: Partial<Parameters<typeof screenWallet>[0]> = {}) {
  return {
    wallet: W,
    nowS: NOW,
    txs: [tx(F, W, NOW - 100 * DAY)],
    nftTransfers: [],
    tokenTransfers: [],
    fundingHops: [
      { from: F, to: W, valueWei: '1000', txHash: '0x01', timeStamp: NOW - 100 * DAY },
    ] as FundingHop[],
    funderFirstSeenS: NOW - 200 * DAY,
    ...over,
  };
}

await check('serial flipper → deny with cited evidence', () => {
  const nftTransfers: ChainTransfer[] = [];
  for (let i = 1; i <= 4; i++) {
    nftTransfers.push(nft('0x' + '00'.repeat(20), W, NOW - 10 * DAY + i * 100, String(i)));
    nftTransfers.push(nft(W, '0x' + 'ff'.repeat(20), NOW - 10 * DAY + i * 100 + 3600, String(i)));
  }
  const v = screenWallet(baseInput({ nftTransfers }), txUrl);
  assert.equal(v.verdict, 'deny');
  assert.equal(v.signals.find((s) => s.name === 'flip_rate')!.score, 100);
  assert.ok(v.signals.find((s) => s.name === 'flip_rate')!.evidence.length > 0);
  assert.match(v.reasons.join(' '), /flipper/);
});

await check('serial dumper → deny', () => {
  const tokenTransfers: ChainTransfer[] = [];
  for (let i = 1; i <= 6; i++) {
    const c = `0x${String(i).padStart(2, '0')}${'ee'.repeat(19)}`;
    tokenTransfers.push(tok('0x' + '00'.repeat(20), W, NOW - 10 * DAY, c));
    tokenTransfers.push(tok(W, '0x' + 'ff'.repeat(20), NOW - 9 * DAY, c));
  }
  const v = screenWallet(baseInput({ tokenTransfers }), txUrl);
  assert.equal(v.verdict, 'deny');
  assert.equal(v.signals.find((s) => s.name === 'dump_rate')!.score, 100);
});

await check('fresh wallet, old funder → review', () => {
  const v = screenWallet(
    baseInput({
      txs: [tx(F, W, NOW - 5 * DAY)],
      fundingHops: [
        { from: F, to: W, valueWei: '1000', txHash: '0x01', timeStamp: NOW - 5 * DAY },
      ] as FundingHop[],
      funderFirstSeenS: NOW - 90 * DAY,
    }),
    txUrl,
  );
  assert.equal(v.verdict, 'review');
  assert.match(v.reasons.join(' '), /new/);
});

await check('fresh funder + fresh wallet → deny (sybil pattern)', () => {
  const v = screenWallet(
    baseInput({
      txs: [tx(F, W, NOW - 5 * DAY)],
      fundingHops: [
        { from: F, to: W, valueWei: '1000', txHash: '0x01', timeStamp: NOW - 5 * DAY },
      ] as FundingHop[],
      funderFirstSeenS: NOW - 6 * DAY, // funder was 1 day old
    }),
    txUrl,
  );
  assert.equal(v.verdict, 'deny');
  assert.match(v.reasons.join(' '), /Sybil/);
});

await check('clean holder → allow', () => {
  const nftTransfers: ChainTransfer[] = [];
  for (let i = 1; i <= 5; i++) {
    nftTransfers.push(nft('0x' + '00'.repeat(20), W, NOW - 60 * DAY, String(i)));
  }
  const v = screenWallet(baseInput({ nftTransfers }), txUrl);
  assert.equal(v.verdict, 'allow');
  assert.equal(v.signals.find((s) => s.name === 'flip_rate')!.score, 0);
});

await check('new wallet funded by flipper → deny (rotation pattern)', () => {
  const v = screenWallet(
    baseInput({
      txs: [tx(F, W, NOW - 5 * DAY)],
      fundingHops: [
        { from: F, to: W, valueWei: '1000', txHash: '0x01', timeStamp: NOW - 5 * DAY },
      ] as FundingHop[],
      funderFirstSeenS: NOW - 90 * DAY, // old funder: no sybil-on-age flag
      funderScreen: { verdict: 'deny' },
    }),
    txUrl,
  );
  assert.equal(v.verdict, 'deny');
  assert.equal(v.signals.find((s) => s.name === 'funder_behavior')!.score, 85);
  assert.match(v.reasons.join(' '), /Rotation pattern/);
});

await check('old wallet funded long ago by flipper → allow, signal visible', () => {
  const v = screenWallet(
    baseInput({
      funderScreen: { verdict: 'deny' },
    }),
    txUrl,
  );
  assert.equal(v.verdict, 'allow');
  assert.equal(v.signals.find((s) => s.name === 'funder_behavior')!.score, 85);
  assert.match(
    v.signals.find((s) => s.name === 'funder_behavior')!.detail,
    /flagged as a flipper\/dumper/,
  );
});

await check('clean funder → low funder_behavior score', () => {
  const v = screenWallet(baseInput({ funderScreen: { verdict: 'allow' } }), txUrl);
  assert.equal(v.signals.find((s) => s.name === 'funder_behavior')!.score, 5);
});

await check('no history → review', () => {
  const v = screenWallet(
    baseInput({ txs: [], nftTransfers: [], tokenTransfers: [], fundingHops: [], funderFirstSeenS: null }),
    txUrl,
  );
  assert.equal(v.verdict, 'review');
});

// ---------- clustering ----------

await check('clusterByFunder groups wallets by shared funder', () => {
  const clusters = clusterByFunder([
    { wallet: W, funder: F },
    { wallet: '0x' + '11'.repeat(20), funder: F },
    { wallet: '0x' + '22'.repeat(20), funder: G },
    { wallet: '0x' + '33'.repeat(20), funder: null },
  ]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].funder, F);
  assert.equal(clusters[0].wallets.length, 2);
});

// ---------- service validation ----------

function mockFetch(routes: [string, unknown][]): FetchFn {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    for (const [key, body] of routes) {
      if (u.includes(key)) {
        return { ok: true, json: async () => body } as Response;
      }
    }
    throw new Error(`unexpected url: ${u}`);
  }) as FetchFn;
}

const okList = (result: unknown[]) => ({ message: 'OK', result });

await check('service: bad address / chain / depth rejected', async () => {
  const svc = createMintBouncerService({
    fetchFn: mockFetch([]),
    nowS: () => NOW,
  });
  await assert.rejects(svc.screenWallet({ address: 'nope' }), /0x EVM address/);
  await assert.rejects(svc.screenWallet({ address: W, chain: 'solana' }), /unknown chain/);
  await assert.rejects(svc.fundingTrace({ address: W, depth: 0 }), /depth must be/);
  await assert.rejects(svc.fundingTrace({ address: W, depth: 9 }), /depth must be/);
  await assert.rejects(svc.clusterCheck({ addresses: [] }), /non-empty array/);
  await assert.rejects(
    svc.screenBatch({ addresses: new Array(51).fill(W) }),
    /caps at 50/,
  );
});

await check('service: fundingTrace returns hops with explorer links', async () => {
  const wTxs = okList([tx(F, W, 100), tx('0x' + 'ff'.repeat(20), W, 200)]);
  const fTxs = okList([tx(G, F, 50)]);
  const gTxs = okList([]);
  const svc = createMintBouncerService({
    fetchFn: mockFetch([
      [`address=${W}`, wTxs],
      [`address=${F}`, fTxs],
      [`address=${G}`, gTxs],
    ]),
    nowS: () => NOW,
  });
  const out = await svc.fundingTrace({ address: W, depth: 2 });
  assert.equal(out.hops.length, 2);
  assert.equal(out.hops[0].from, F);
  assert.match(out.hops[0].txUrl, /explorer.inkonchain.com\/tx\//);
  assert.equal(out.chain, 'Ink');
});

console.log(`\n${passed} mint-bouncer checks passed`);
