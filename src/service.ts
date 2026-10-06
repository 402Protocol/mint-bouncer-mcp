/**
 * Mint Bouncer service — wallet screening for mint whitelists.
 *
 * Three tools, all read-only. This server NEVER signs, NEVER holds keys,
 * and NEVER moves funds. It reads public onchain history and returns a
 * verdict with cited evidence. There is no approval flow because there is
 * nothing to approve: the worst this server can do is fetch a web page.
 */
import {
  CHAINS,
  addressUrl,
  getNftTransfers,
  getTokenTransfers,
  getTxList,
  resolveChain,
  txUrl,
  type ChainConfig,
  type ChainTx,
  type FetchFn,
} from './chain.js';
import {
  clusterByFunder,
  screenWallet,
  traceFunding,
  type Verdict,
} from './scoring.js';

export interface MintBouncerOptions {
  fetchFn?: FetchFn;
  /** Clock override (tests). */
  nowS?: () => number;
}

function requireAddress(address: unknown): string {
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error('address must be a 0x EVM address');
  }
  return address;
}

export function createMintBouncerService(opts: MintBouncerOptions = {}) {
  const fetchFn: FetchFn = opts.fetchFn ?? fetch;
  const nowS = opts.nowS ?? (() => Math.floor(Date.now() / 1000));

  async function screenOne(
    cfg: ChainConfig,
    wallet: string,
  ): Promise<Verdict & { wallet: string; chain: string; explorerUrl: string; funder: string | null; funderVerdict: Verdict['verdict'] | null }> {
    const [txs, nftTransfers, tokenTransfers] = await Promise.all([
      getTxList(cfg, wallet, fetchFn),
      getNftTransfers(cfg, wallet, fetchFn),
      getTokenTransfers(cfg, wallet, fetchFn),
    ]);
    const fundingHops = await traceFunding(
      wallet,
      (addr) => getTxList(cfg, addr, fetchFn, 2),
      3,
    );
    // Funder freshness: first-seen of the hop-1 funder from its own history.
    let funderFirstSeenS: number | null = null;
    if (fundingHops[0]) {
      const funderTxs = await getTxList(cfg, fundingHops[0].from, fetchFn, 2);
      const stamps = funderTxs
        .map((t) => Number(t.timeStamp))
        .filter((n) => Number.isFinite(n) && n > 0);
      funderFirstSeenS = stamps.length ? Math.min(...stamps) : null;
    }
    // One-hop recursive screen: run the funder's own history through the
    // same scoring (no deeper recursion). A flipper funding a fresh wallet
    // is the rotation pattern — the suspicion transfers.
    let funderScreen: { verdict: Verdict['verdict'] } | null = null;
    if (fundingHops[0]) {
      const funder = fundingHops[0].from;
      const [fNfts, fToks, fTxs] = await Promise.all([
        getNftTransfers(cfg, funder, fetchFn, 2),
        getTokenTransfers(cfg, funder, fetchFn, 2),
        getTxList(cfg, funder, fetchFn, 2),
      ]);
      const fVerdict = screenWallet(
        {
          wallet: funder,
          nowS: nowS(),
          txs: fTxs,
          nftTransfers: fNfts,
          tokenTransfers: fToks,
          fundingHops: [],
          funderFirstSeenS: null,
          funderScreen: null,
        },
        (h) => txUrl(cfg, h),
      );
      funderScreen = { verdict: fVerdict.verdict };
    }
    const verdict = screenWallet(
      {
        wallet,
        nowS: nowS(),
        txs,
        nftTransfers,
        tokenTransfers,
        fundingHops,
        funderFirstSeenS,
        funderScreen,
      },
      (h) => txUrl(cfg, h),
    );
    return {
      ...verdict,
      wallet,
      chain: cfg.name,
      explorerUrl: addressUrl(cfg, wallet),
      /** Hop-1 funder, for sybil clustering. */
      funder: fundingHops[0]?.from ?? null,
      /** The funder's own screen verdict (one hop, no deeper recursion). */
      funderVerdict: funderScreen?.verdict ?? null,
    };
  }

  return {
    chains: () => Object.values(CHAINS).map((c) => ({ name: c.name, id: c.id })),

    /**
     * Screen one wallet for a mint whitelist. Returns allow / deny / review
     * with per-signal scores, plain-words reasons, and cited transactions.
     */
    screenWallet: async (p: { address: string; chain?: string }) => {
      const wallet = requireAddress(p.address);
      const cfg = resolveChain(p.chain);
      return screenOne(cfg, wallet);
    },

    /**
     * Trace where a wallet's first funds came from, hop by hop. Each hop is
     * the earliest incoming native transfer of the previous address.
     */
    fundingTrace: async (p: { address: string; depth?: number; chain?: string }) => {
      const wallet = requireAddress(p.address);
      const cfg = resolveChain(p.chain);
      const depth = p.depth ?? 3;
      if (!Number.isInteger(depth) || depth < 1 || depth > 5) {
        throw new Error('depth must be an integer 1-5');
      }
      const hops = await traceFunding(
        wallet,
        (addr) => getTxList(cfg, addr, fetchFn, 2),
        depth,
      );
      return {
        wallet,
        chain: cfg.name,
        hops: hops.map((h) => ({
          ...h,
          txUrl: txUrl(cfg, h.txHash),
          fromUrl: addressUrl(cfg, h.from),
        })),
        note:
          hops.length === 0
            ? 'No incoming funding transfer found.'
            : hops.length < depth
              ? 'Trace ended: reached a wallet with no earlier incoming transfer.'
              : 'Trace stopped at the requested depth — it may continue.',
      };
    },

    /**
     * Sybil-cluster check across a batch of applicant wallets. Groups wallets
     * by their first funder; any group sharing one funder is a cluster that
     * deserves one decision, not N.
     */
    clusterCheck: async (p: { addresses: string[]; chain?: string }) => {
      if (!Array.isArray(p.addresses) || p.addresses.length === 0) {
        throw new Error('addresses must be a non-empty array');
      }
      if (p.addresses.length > 200) {
        throw new Error('cluster_check caps at 200 addresses per call');
      }
      const wallets = p.addresses.map(requireAddress);
      const cfg = resolveChain(p.chain);
      const funders = await Promise.all(
        wallets.map(async (w) => {
          const hops = await traceFunding(
            w,
            (addr) => getTxList(cfg, addr, fetchFn, 1),
            1,
          );
          return { wallet: w, funder: hops[0]?.from ?? null };
        }),
      );
      const clusters = clusterByFunder(funders);
      return {
        chain: cfg.name,
        screened: wallets.length,
        clusters: clusters.map((c) => ({
          funder: c.funder,
          funderUrl: addressUrl(cfg, c.funder),
          wallets: c.wallets,
          walletUrls: c.wallets.map((w) => addressUrl(cfg, w)),
        })),
        summary:
          clusters.length === 0
            ? 'No shared funders found across these wallets.'
            : `${clusters.length} cluster(s) share one funder — treat each cluster as one applicant.`,
      };
    },

    /**
     * Screen a whole applicant list. Returns per-wallet verdicts plus the
     * sybil clusters, so one human running twenty wallets gets one decision.
     */
    screenBatch: async (p: { addresses: string[]; chain?: string }) => {
      if (!Array.isArray(p.addresses) || p.addresses.length === 0) {
        throw new Error('addresses must be a non-empty array');
      }
      if (p.addresses.length > 50) {
        throw new Error('screen_batch caps at 50 addresses per call');
      }
      const wallets = p.addresses.map(requireAddress);
      const cfg = resolveChain(p.chain);
      const results = await Promise.all(wallets.map((w) => screenOne(cfg, w)));
      const clusters = clusterByFunder(
        results.map((r) => ({ wallet: r.wallet, funder: r.funder })),
      );
      const tally = {
        allow: results.filter((r) => r.verdict === 'allow').length,
        deny: results.filter((r) => r.verdict === 'deny').length,
        review: results.filter((r) => r.verdict === 'review').length,
      };
      return { chain: cfg.name, tally, results, clusters };
    },
  };
}

export type MintBouncerService = ReturnType<typeof createMintBouncerService>;
export type { ChainTx };
