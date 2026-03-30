import { fetch } from 'undici';
import type { DexScreenerPair, EnrichedPool, ValidatedPool } from './types.js';

function safeNum(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
}

export async function fetchDexPairByMint(mint: string): Promise<DexScreenerPair | null> {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) return null;
  const json: any = await res.json();
  const pairs: DexScreenerPair[] = Array.isArray(json?.pairs) ? json.pairs : [];
  const solPairs = pairs.filter((p) => p.chainId === 'solana');
  // Pick the highest liquidity pair
  solPairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  return solPairs[0] ?? null;
}

export function computeOrganicScore(args: {
  liquidityUsd?: number;
  volume24hUsd?: number;
  priceChange24hPct?: number;
  marketCapUsd?: number;
}): number {
  const liq = args.liquidityUsd ?? 0;
  const vol = args.volume24hUsd ?? 0;
  const pc = Math.abs(args.priceChange24hPct ?? 0);
  const mc = args.marketCapUsd ?? 0;

  // Heuristic: prefer decent liq + volume, penalize extreme volatility, penalize ultra tiny caps.
  const liqScore = Math.min(40, Math.log10(1 + liq) * 8);
  const volScore = Math.min(40, Math.log10(1 + vol) * 8);
  const volPenalty = Math.min(30, pc * 0.5);
  const capScore = mc > 0 ? Math.min(20, Math.log10(1 + mc) * 2) : 0;

  const score = liqScore + volScore + capScore - volPenalty;
  return Math.max(0, Math.min(100, Number(score.toFixed(2))));
}

export async function enrichPool(pool: ValidatedPool): Promise<EnrichedPool> {
  // Fetch by base mint first; if empty, try quote mint.
  const base = await fetchDexPairByMint(pool.tokenMintA);
  const quote = base ? null : await fetchDexPairByMint(pool.tokenMintB);
  const pair = base ?? quote;

  const priceUsd = safeNum(pair?.priceUsd);
  const liquidityUsd = pair?.liquidity?.usd;
  const volume24hUsd = pair?.volume?.h24;
  const marketCapUsd = pair?.marketCap ?? pair?.fdv;
  const priceChange24hPct = pair?.priceChange?.h24;

  const organicScore = computeOrganicScore({
    liquidityUsd,
    volume24hUsd,
    priceChange24hPct,
    marketCapUsd
  });

  const summary = [
    `Pair: ${(pool.symbolA ?? pool.tokenMintA.slice(0, 4))}/${(pool.symbolB ?? pool.tokenMintB.slice(0, 4))}`,
    pool.poolAddress ? `Pool: ${pool.poolAddress}` : undefined,
    priceUsd ? `PriceUSD: ${priceUsd}` : undefined,
    liquidityUsd ? `LiqUSD: ${Math.round(liquidityUsd)}` : undefined,
    volume24hUsd ? `Vol24hUSD: ${Math.round(volume24hUsd)}` : undefined,
    priceChange24hPct !== undefined ? `Chg24h: ${priceChange24hPct}%` : undefined,
    marketCapUsd ? `MCap/FDV: ${Math.round(marketCapUsd)}` : undefined,
    `OrganicScore: ${organicScore}`
  ]
    .filter(Boolean)
    .join(' | ');

  return {
    ...pool,
    organicScore,
    dex: {
      url: pair?.url,
      priceUsd,
      liquidityUsd,
      volume24hUsd,
      marketCapUsd,
      fdvUsd: pair?.fdv,
      priceChange24hPct
    },
    summary
  };
}
