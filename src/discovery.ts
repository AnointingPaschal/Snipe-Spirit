import { fetch } from 'undici';
import { logger } from './logger.js';
import type { DiscoveredPool, DexScreenerPair } from './types.js';

/**
 * Multi-source discovery for Solana memecoin gems:
 * 1. DexScreener Token Boosts — tokens paying for visibility (active projects)
 * 2. DexScreener Latest Profiles — newly listed tokens
 * 3. DexScreener Search — fallback trending search
 * 
 * Meteora API is currently dead, so we skip it.
 */

function toNumber(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
}

interface BoostedToken {
  chainId: string;
  tokenAddress: string;
  totalAmount?: number;
  description?: string;
  links?: Array<{ type?: string; url?: string; label?: string }>;
}

/**
 * Source 1: Top boosted tokens on DexScreener (active promotion = active community)
 */
async function discoverFromBoosts(): Promise<string[]> {
  const res = await fetch('https://api.dexscreener.com/token-boosts/top/v1', {
    headers: { accept: 'application/json' }
  });
  if (!res.ok) throw new Error(`Boosts API error ${res.status}`);
  const json: any = await res.json();
  const tokens: BoostedToken[] = Array.isArray(json) ? json : [];
  
  // Filter Solana tokens only
  return tokens
    .filter(t => t.chainId === 'solana')
    .map(t => t.tokenAddress);
}

/**
 * Source 2: Latest token profiles (newly listed)
 */
async function discoverFromProfiles(): Promise<string[]> {
  const res = await fetch('https://api.dexscreener.com/token-profiles/latest/v1', {
    headers: { accept: 'application/json' }
  });
  if (!res.ok) throw new Error(`Profiles API error ${res.status}`);
  const json: any = await res.json();
  const tokens: Array<{ chainId: string; tokenAddress: string }> = Array.isArray(json) ? json : [];
  
  return tokens
    .filter(t => t.chainId === 'solana')
    .map(t => t.tokenAddress);
}

/**
 * Fetch pair data for a batch of token addresses using DexScreener
 */
async function fetchPairData(tokenAddresses: string[]): Promise<DiscoveredPool[]> {
  const pools: DiscoveredPool[] = [];
  
  // DexScreener token-pairs endpoint: one token at a time (rate limit: 60/min)
  // Batch by doing a few at a time
  const batch = tokenAddresses.slice(0, 20); // Max 20 tokens per scan
  
  for (const mint of batch) {
    try {
      const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/solana/${mint}`, {
        headers: { accept: 'application/json' }
      });
      if (!res.ok) continue;
      
      const json: any = await res.json();
      const pairs: DexScreenerPair[] = Array.isArray(json) ? json : [];
      
      if (!pairs.length) continue;
      
      // Pick highest liquidity pair
      pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
      const best = pairs[0];
      
      if (!best.baseToken?.address || !best.quoteToken?.address) continue;
      
      // Calculate token age in hours
      const createdAt = best.pairCreatedAt ? Number(best.pairCreatedAt) : 0;
      const ageHours = createdAt ? (Date.now() - createdAt) / (1000 * 60 * 60) : Infinity;
      
      pools.push({
        source: 'dexscreener',
        poolAddress: best.pairAddress,
        tokenMintA: best.baseToken.address,
        tokenMintB: best.quoteToken.address,
        symbolA: best.baseToken.symbol,
        symbolB: best.quoteToken.symbol,
        tvlUsd: best.liquidity?.usd,
        volume24hUsd: best.volume?.h24,
        // Extra metadata for better decisions
        priceUsd: toNumber(best.priceUsd),
        marketCapUsd: best.marketCap ?? best.fdv,
        priceChange24hPct: best.priceChange?.h24,
        priceChange1hPct: best.priceChange?.h1,
        ageHours,
        pairCreatedAt: createdAt || undefined,
      });
      
      // Small delay to respect rate limits
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      logger.debug({ err: e, mint }, 'Failed to fetch pair data');
    }
  }
  
  return pools;
}

/**
 * Fallback: DexScreener search for trending Solana tokens
 */
async function discoverFromSearch(): Promise<DiscoveredPool[]> {
  const queries = ['pump.fun', 'solana meme'];
  const pools: DiscoveredPool[] = [];
  
  for (const q of queries) {
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`, {
        headers: { accept: 'application/json' }
      });
      if (!res.ok) continue;
      
      const json: any = await res.json();
      const pairs: DexScreenerPair[] = Array.isArray(json?.pairs) ? json.pairs : [];
      
      for (const p of pairs.filter(p => p.chainId === 'solana').slice(0, 10)) {
        if (!p.baseToken?.address || !p.quoteToken?.address) continue;
        
        const createdAt = p.pairCreatedAt ? Number(p.pairCreatedAt) : 0;
        const ageHours = createdAt ? (Date.now() - createdAt) / (1000 * 60 * 60) : Infinity;
        
        pools.push({
          source: 'dexscreener',
          poolAddress: p.pairAddress,
          tokenMintA: p.baseToken.address,
          tokenMintB: p.quoteToken.address,
          symbolA: p.baseToken.symbol,
          symbolB: p.quoteToken.symbol,
          tvlUsd: p.liquidity?.usd,
          volume24hUsd: p.volume?.h24,
          priceUsd: toNumber(p.priceUsd),
          marketCapUsd: p.marketCap ?? p.fdv,
          priceChange24hPct: p.priceChange?.h24,
          priceChange1hPct: p.priceChange?.h1,
          ageHours,
          pairCreatedAt: createdAt || undefined,
        });
      }
    } catch (e) {
      logger.debug({ err: e, q }, 'Search fallback failed');
    }
  }
  
  return pools;
}

/**
 * Main discovery: combines boosted tokens + latest profiles + search fallback
 * Deduplicates by token mint address
 */
export async function discoverPools(limit = 20): Promise<DiscoveredPool[]> {
  const seenMints = new Set<string>();
  let allMints: string[] = [];
  
  // Source 1: Boosted tokens (highest signal — projects spending money)
  try {
    const boosted = await discoverFromBoosts();
    logger.info({ count: boosted.length }, 'Boosted Solana tokens found');
    allMints.push(...boosted);
  } catch (e) {
    logger.warn({ err: e }, 'Boosts discovery failed');
  }
  
  // Source 2: Latest profiles (new listings)
  try {
    const profiles = await discoverFromProfiles();
    logger.info({ count: profiles.length }, 'Latest Solana profiles found');
    allMints.push(...profiles);
  } catch (e) {
    logger.warn({ err: e }, 'Profiles discovery failed');
  }
  
  // Deduplicate
  const uniqueMints: string[] = [];
  for (const m of allMints) {
    if (!seenMints.has(m)) {
      seenMints.add(m);
      uniqueMints.push(m);
    }
  }
  
  logger.info({ unique: uniqueMints.length }, 'Unique tokens to evaluate');
  
  // Fetch actual pair data
  let pools = await fetchPairData(uniqueMints.slice(0, limit));
  
  // If we got too few, use search fallback
  if (pools.length < 5) {
    logger.info('Low pool count; adding search fallback');
    const searchPools = await discoverFromSearch();
    for (const p of searchPools) {
      if (!seenMints.has(p.tokenMintA)) {
        seenMints.add(p.tokenMintA);
        pools.push(p);
      }
    }
  }
  
  logger.info({ total: pools.length }, 'Total pools discovered with data');
  return pools.slice(0, limit);
}
