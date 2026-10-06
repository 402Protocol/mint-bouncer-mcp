/**
 * Mint Bouncer scoring — pure, deterministic, explainable.
 *
 * Every signal is computed from onchain history alone and carries its
 * evidence (transaction hashes). No ML, no heuristics you can't audit:
 * a denied wallet can read exactly why.
 *
 * Risk scores run 0-100 per signal (higher = riskier). The verdict:
 *   deny   — strong flipper/dumper/sybil pattern
 *   review — young wallet or mixed signals, human decides
 *   allow  — no red flags
 */
import type { ChainTransfer, ChainTx } from './chain.js';

export const FLIP_WINDOW_S = 24 * 3600; // disposed within 24h of acquiring = flip
export const MIN_NFT_SAMPLE = 3; // need at least this many flips-worth of data
export const MIN_TOKEN_SAMPLE = 5;
export const NEW_WALLET_DAYS = 30;
export const FRESH_FUNDER_DAYS = 7;

const ZERO = '0x0000000000000000000000000000000000000000';

export interface Signal {
  /** Machine key, e.g. "flip_rate". */
  name: string;
  /** 0-100. Higher = riskier. null = insufficient data. */
  score: number | null;
  /** One plain-words line for the human. */
  detail: string;
  /** Explorer URLs backing the claim. */
  evidence: string[];
}

export interface Verdict {
  verdict: 'allow' | 'deny' | 'review';
  /** 0-100 aggregate. */
  riskScore: number;
  signals: Signal[];
  /** Plain-words reasons, in priority order. */
  reasons: string[];
}

export interface NftHolding {
  contractAddress: string;
  tokenID: string;
  acquiredTs: number;
  acquiredTx: string;
  disposedTs: number | null;
  disposedTx: string | null;
}

function tsOf(t: string): number {
  const n = Number(t);
  return Number.isFinite(n) ? n : 0;
}

/** Pair every NFT acquisition with its first later disposal, if any. */
export function pairNftHoldings(
  wallet: string,
  transfers: ChainTransfer[],
): NftHolding[] {
  const w = wallet.toLowerCase();
  const byToken = new Map<string, ChainTransfer[]>();
  for (const t of transfers) {
    if (!t.tokenID) continue;
    const key = `${t.contractAddress.toLowerCase()}:${t.tokenID}`;
    const list = byToken.get(key) ?? [];
    list.push(t);
    byToken.set(key, list);
  }
  const holdings: NftHolding[] = [];
  for (const list of byToken.values()) {
    const sorted = [...list].sort((a, b) => tsOf(a.timeStamp) - tsOf(b.timeStamp));
    const acquisitions = sorted.filter((t) => t.to.toLowerCase() === w);
    const disposals = sorted.filter((t) => t.from.toLowerCase() === w);
    for (const acq of acquisitions) {
      const acqTs = tsOf(acq.timeStamp);
      const disp = disposals.find((d) => tsOf(d.timeStamp) > acqTs);
      holdings.push({
        contractAddress: acq.contractAddress,
        tokenID: acq.tokenID,
        acquiredTs: acqTs,
        acquiredTx: acq.hash,
        disposedTs: disp ? tsOf(disp.timeStamp) : null,
        disposedTx: disp ? disp.hash : null,
      });
    }
  }
  return holdings.sort((a, b) => a.acquiredTs - b.acquiredTs);
}

export interface FundingHop {
  from: string;
  to: string;
  valueWei: string;
  txHash: string;
  timeStamp: number;
}

/**
 * Walk back the funding chain: the earliest incoming native transfer, then
 * the earliest incoming native transfer of THAT sender, up to `depth` hops.
 * getTxListOf is injected so tests don't touch the network.
 */
export async function traceFunding(
  wallet: string,
  getTxListOf: (address: string) => Promise<ChainTx[]>,
  depth = 3,
): Promise<FundingHop[]> {
  const hops: FundingHop[] = [];
  let current = wallet.toLowerCase();
  const seen = new Set<string>([current]);
  for (let i = 0; i < depth; i++) {
    const txs = await getTxListOf(current);
    const incoming = txs
      .filter(
        (t) =>
          t.to.toLowerCase() === current &&
          t.from.toLowerCase() !== ZERO &&
          BigInt(t.value || '0') > 0n &&
          t.isError === '0',
      )
      .sort((a, b) => tsOf(a.timeStamp) - tsOf(b.timeStamp));
    const first = incoming[0];
    if (!first) break;
    hops.push({
      from: first.from,
      to: first.to,
      valueWei: first.value,
      txHash: first.hash,
      timeStamp: tsOf(first.timeStamp),
    });
    const next = first.from.toLowerCase();
    if (seen.has(next)) break; // loop guard
    seen.add(next);
    current = next;
  }
  return hops;
}

export interface ScreenInput {
  wallet: string;
  nowS: number;
  txs: ChainTx[];
  nftTransfers: ChainTransfer[];
  tokenTransfers: ChainTransfer[];
  fundingHops: FundingHop[];
  /** First-seen timestamp of the hop-1 funder (for freshness checks). null = unknown. */
  funderFirstSeenS: number | null;
}

function ev(txUrl: (h: string) => string, hashes: string[]): string[] {
  return [...new Set(hashes)].slice(0, 8).map(txUrl);
}

export function screenWallet(
  input: ScreenInput,
  txUrl: (hash: string) => string,
): Verdict {
  const { wallet, nowS } = input;
  const w = wallet.toLowerCase();
  const signals: Signal[] = [];
  const reasons: string[] = [];

  // ---- wallet age ----
  const allTs = [
    ...input.txs.map((t) => tsOf(t.timeStamp)),
    ...input.nftTransfers.map((t) => tsOf(t.timeStamp)),
    ...input.tokenTransfers.map((t) => tsOf(t.timeStamp)),
  ].filter((n) => n > 0);
  const firstSeen = allTs.length ? Math.min(...allTs) : null;
  const ageDays = firstSeen === null ? null : (nowS - firstSeen) / 86400;
  signals.push({
    name: 'wallet_age',
    score: ageDays === null ? null : ageDays < 7 ? 70 : ageDays < NEW_WALLET_DAYS ? 40 : 5,
    detail:
      ageDays === null
        ? 'No onchain history found for this wallet.'
        : `Wallet first seen ${ageDays.toFixed(1)} days ago.`,
    evidence: [],
  });

  // ---- flip rate (NFTs) ----
  const holdings = pairNftHoldings(w, input.nftTransfers);
  const decided = holdings.filter((h) => h.disposedTs !== null);
  let flipScore: number | null = null;
  let flipDetail = `Only ${holdings.length} NFT acquisition(s) on record — not enough to judge flipping.`;
  const flipEvidence: string[] = [];
  if (holdings.length >= MIN_NFT_SAMPLE) {
    const flips = decided.filter(
      (h) => h.disposedTs! - h.acquiredTs <= FLIP_WINDOW_S,
    );
    const rate = flips.length / holdings.length;
    flipScore = Math.round(rate * 100);
    flipDetail =
      `${flips.length} of ${holdings.length} NFTs sold within 24h of acquiring ` +
      `(${(rate * 100).toFixed(0)}% flip rate).`;
    flipEvidence.push(...ev(txUrl, flips.flatMap((h) => [h.acquiredTx, h.disposedTx!])));
  }
  signals.push({ name: 'flip_rate', score: flipScore, detail: flipDetail, evidence: flipEvidence });

  // ---- dump rate (ERC-20 lots) ----
  const lots = new Map<string, { acquired: number; dumped: number; txs: string[] }>();
  for (const t of input.tokenTransfers) {
    if (!t.value || t.tokenID) continue;
    const key = t.contractAddress.toLowerCase();
    const lot = lots.get(key) ?? { acquired: 0, dumped: 0, txs: [] };
    if (t.to.toLowerCase() === w) lot.acquired++;
    if (t.from.toLowerCase() === w) {
      lot.dumped++;
      lot.txs.push(t.hash);
    }
    lots.set(key, lot);
  }
  const lotList = [...lots.values()].filter((l) => l.acquired > 0);
  let dumpScore: number | null = null;
  let dumpDetail = `Only ${lotList.length} token lot(s) received — not enough to judge dumping.`;
  const dumpEvidence: string[] = [];
  if (lotList.length >= MIN_TOKEN_SAMPLE) {
    const dumped = lotList.filter((l) => l.dumped >= l.acquired && l.acquired > 0);
    const rate = dumped.length / lotList.length;
    dumpScore = Math.round(rate * 100);
    dumpDetail =
      `${dumped.length} of ${lotList.length} received token lots fully sold off ` +
      `(${(rate * 100).toFixed(0)}% dump rate).`;
    dumpEvidence.push(...ev(txUrl, dumped.flatMap((l) => l.txs)));
  }
  signals.push({ name: 'dump_rate', score: dumpScore, detail: dumpDetail, evidence: dumpEvidence });

  // ---- funding freshness ----
  const hop1 = input.fundingHops[0];
  let fundScore: number | null = null;
  let fundDetail = 'No incoming funding transfer found.';
  if (hop1) {
    const funderAgeDays =
      input.funderFirstSeenS === null
        ? null
        : (hop1.timeStamp - input.funderFirstSeenS) / 86400;
    fundScore =
      funderAgeDays === null ? 30 : funderAgeDays < FRESH_FUNDER_DAYS ? 80 : 10;
    fundDetail =
      funderAgeDays === null
        ? `First funded by ${hop1.from} (funder history unknown).`
        : `First funded by ${hop1.from}, a wallet that was ` +
          `${funderAgeDays.toFixed(1)} days old at the time` +
          (funderAgeDays < FRESH_FUNDER_DAYS ? ' — fresh funder, sybil smell.' : '.');
  }
  signals.push({
    name: 'funding_freshness',
    score: fundScore,
    detail: fundDetail,
    evidence: hop1 ? [txUrl(hop1.txHash)] : [],
  });

  // ---- verdict ----
  const scored = signals.filter((s) => s.score !== null) as (Signal & { score: number })[];
  const riskScore = scored.length
    ? Math.round(scored.reduce((a, s) => a + s.score, 0) / scored.length)
    : 50;
  const byName = Object.fromEntries(signals.map((s) => [s.name, s.score]));

  let verdict: Verdict['verdict'] = 'allow';
  if (
    (byName.flip_rate !== null && byName.flip_rate >= 70) ||
    (byName.dump_rate !== null && byName.dump_rate >= 80) ||
    (byName.funding_freshness !== null &&
      byName.funding_freshness >= 80 &&
      byName.wallet_age !== null &&
      byName.wallet_age >= 40)
  ) {
    verdict = 'deny';
  } else if (
    riskScore >= 45 ||
    byName.wallet_age === null ||
    (ageDays !== null && ageDays < NEW_WALLET_DAYS)
  ) {
    verdict = 'review';
  }

  if (verdict === 'deny') {
    if (byName.flip_rate !== null && byName.flip_rate >= 70)
      reasons.push('Serial flipper: most NFTs sold within 24h of acquiring.');
    if (byName.dump_rate !== null && byName.dump_rate >= 80)
      reasons.push('Serial dumper: most received token lots sold off in full.');
    if (byName.funding_freshness !== null && byName.funding_freshness >= 80)
      reasons.push('Sybil pattern: funded by a fresh wallet, wallet itself is new.');
    if (!reasons.length) reasons.push('High aggregate risk score.');
  } else if (verdict === 'review') {
    if (ageDays !== null && ageDays < NEW_WALLET_DAYS)
      reasons.push('Wallet is new — not enough history to clear automatically.');
    else reasons.push('Mixed signals — a human should decide.');
  } else {
    reasons.push('No flipper, dumper, or sybil patterns detected.');
  }

  return { verdict, riskScore, signals, reasons };
}

/** Sybil-cluster check: group applicant wallets by their hop-1 funder. */
export function clusterByFunder(
  applicants: { wallet: string; funder: string | null }[],
): { funder: string; wallets: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const a of applicants) {
    if (!a.funder) continue;
    const key = a.funder.toLowerCase();
    const list = groups.get(key) ?? [];
    list.push(a.wallet);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .filter(([, wallets]) => wallets.length > 1)
    .map(([funder, wallets]) => ({ funder, wallets }))
    .sort((a, b) => b.wallets.length - a.wallets.length);
}
