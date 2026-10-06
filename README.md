# Mint Bouncer

Screen wallets for mint whitelists. Flipper, dumper, and sybil-cluster detection as an MCP server.

Point your agent here with an applicant wallet and get back a verdict — **allow**, **deny**, or **review** — with per-signal risk scores, plain-words reasons, and a cited explorer link for every claim. No black box: a denied wallet can read exactly why.

## Tools (all read-only, never signs)

- `bouncer_screen_wallet` — screen one wallet: flip rate (NFTs sold within 24h of acquiring), dump rate (received token lots sold off in full), wallet age, and funding freshness. Returns the verdict, 0-100 risk score, signals, and evidence links.
- `bouncer_funding_trace` — walk back where a wallet's first funds came from, hop by hop (1-5 hops). Flags fresh funders, the classic sybil smell.
- `bouncer_cluster_check` — group applicant wallets by first funder. Wallets sharing one funder are one cluster and deserve one decision, not N.
- `bouncer_screen_batch` — screen a whole applicant list at once: per-wallet verdicts, an allow/deny/review tally, plus the clusters.

## Install

```bash
npx -y 402-mint-bouncer-mcp@latest
```

Or from source: clone, `npm install`, then `npm run mcp`.

```json
{
  "mcpServers": {
    "mint-bouncer": {
      "command": "npx",
      "args": ["-y", "402-mint-bouncer-mcp@latest"]
    }
  }
}
```

No keys, no secrets, no environment setup. There is nothing to sign, so there is nothing to configure.

## How the verdict works

| Signal | Deny threshold |
|---|---|
| Flip rate | ≥70% of NFTs flipped within 24h (min 3 acquisitions) |
| Dump rate | ≥80% of received token lots fully sold off (min 5 lots) |
| Sybil pattern | Funded by a wallet <7 days old, wallet itself <30 days old |
| Rotation pattern | New wallet (<30d) funded by a wallet flagged as flipper/dumper — the funder's own history is screened one hop deep |

Young wallets (<30 days) or thin history go to **review**, never auto-deny on age alone. An old wallet with clean history is not punished for ancient funding — the funder signal stays visible, the verdict doesn't flip. Every threshold lives in `src/scoring.ts` — deterministic, auditable, forkable.

## Chains

Ink (Blockscout API) today. The chain client is Blockscout-compatible, so any EVM chain with one can be added to `CHAINS` in `src/chain.ts`.

## Key posture

This server cannot move funds. It makes unauthenticated reads against public explorer APIs and returns analysis. The most dangerous thing it can do is fetch a web page.

## Develop

```bash
npm test        # 11 checks, no network
npm run typecheck
npm run build
```
