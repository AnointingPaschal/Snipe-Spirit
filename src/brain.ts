import type { BrainDecision, EnrichedPool } from './types.js';
import { logger } from './logger.js';

/**
 * Smart rule-based decision engine — no external API needed.
 * Scores candidates on multiple weighted signals and decides ENTER or SKIP.
 */

interface Signal {
  name: string;
  score: number; // -100 to +100
  weight: number;
  reason: string;
}

function evaluateLiquidity(pool: EnrichedPool): Signal {
  const liq = pool.dex?.liquidityUsd ?? pool.tvlUsd ?? 0;

  if (liq < 5000) return { name: 'liquidity', score: -80, weight: 0.25, reason: `Low liquidity ($${liq})` };
  if (liq < 20000) return { name: 'liquidity', score: 20, weight: 0.25, reason: `Decent liquidity ($${Math.round(liq)})` };
  if (liq < 100000) return { name: 'liquidity', score: 60, weight: 0.25, reason: `Good liquidity ($${Math.round(liq)})` };
  return { name: 'liquidity', score: 80, weight: 0.25, reason: `Strong liquidity ($${Math.round(liq)})` };
}

function evaluateVolume(pool: EnrichedPool): Signal {
  const vol = pool.dex?.volume24hUsd ?? pool.volume24hUsd ?? 0;
  const liq = pool.dex?.liquidityUsd ?? pool.tvlUsd ?? 1;
  const volToLiq = vol / liq; // healthy = 0.5-3x

  if (vol < 5000) return { name: 'volume', score: -60, weight: 0.2, reason: `Very low volume ($${Math.round(vol)})` };
  if (volToLiq > 10) return { name: 'volume', score: -40, weight: 0.2, reason: `Suspicious vol/liq ratio (${volToLiq.toFixed(1)}x) — possible wash trading` };
  if (volToLiq > 3) return { name: 'volume', score: 30, weight: 0.2, reason: `High volume relative to liquidity (${volToLiq.toFixed(1)}x)` };
  if (vol > 50000) return { name: 'volume', score: 70, weight: 0.2, reason: `Strong volume ($${Math.round(vol)})` };
  return { name: 'volume', score: 40, weight: 0.2, reason: `Moderate volume ($${Math.round(vol)})` };
}

function evaluatePriceAction(pool: EnrichedPool): Signal {
  const change = pool.dex?.priceChange24hPct;
  if (change === undefined) return { name: 'priceAction', score: 0, weight: 0.15, reason: 'No price change data' };

  // Sweet spot: slight pump (5-30%) is good momentum
  // Too high (>80%) = probably too late / dump incoming
  // Negative = avoid
  if (change < -20) return { name: 'priceAction', score: -70, weight: 0.15, reason: `Heavy dump (${change.toFixed(1)}%)` };
  if (change < -5) return { name: 'priceAction', score: -30, weight: 0.15, reason: `Declining (${change.toFixed(1)}%)` };
  if (change < 5) return { name: 'priceAction', score: 10, weight: 0.15, reason: `Stable (${change.toFixed(1)}%)` };
  if (change < 30) return { name: 'priceAction', score: 70, weight: 0.15, reason: `Good momentum (${change.toFixed(1)}%)` };
  if (change < 80) return { name: 'priceAction', score: 40, weight: 0.15, reason: `Strong pump — be careful (${change.toFixed(1)}%)` };
  return { name: 'priceAction', score: -50, weight: 0.15, reason: `Extreme pump — likely too late (${change.toFixed(1)}%)` };
}

function evaluateMarketCap(pool: EnrichedPool): Signal {
  const mcap = pool.dex?.marketCapUsd ?? pool.dex?.fdvUsd;
  if (!mcap) return { name: 'marketCap', score: 0, weight: 0.15, reason: 'No market cap data' };

  // Sweet spot for sniping: $50K - $2M mcap
  if (mcap < 10000) return { name: 'marketCap', score: -60, weight: 0.15, reason: `Micro cap ($${Math.round(mcap)}) — very risky` };
  if (mcap < 50000) return { name: 'marketCap', score: 20, weight: 0.15, reason: `Small cap ($${Math.round(mcap)}) — early but risky` };
  if (mcap < 500000) return { name: 'marketCap', score: 80, weight: 0.15, reason: `Sweet spot cap ($${Math.round(mcap)})` };
  if (mcap < 2000000) return { name: 'marketCap', score: 60, weight: 0.15, reason: `Mid cap ($${Math.round(mcap)})` };
  if (mcap < 10000000) return { name: 'marketCap', score: 30, weight: 0.15, reason: `Larger cap ($${Math.round(mcap)}) — less upside` };
  return { name: 'marketCap', score: 10, weight: 0.15, reason: `Large cap ($${Math.round(mcap)}) — stable but limited snipe potential` };
}

function evaluateOrganicScore(pool: EnrichedPool): Signal {
  const score = pool.organicScore;
  if (score < 20) return { name: 'organic', score: -50, weight: 0.15, reason: `Low organic score (${score})` };
  if (score < 40) return { name: 'organic', score: 10, weight: 0.15, reason: `Below average organic (${score})` };
  if (score < 60) return { name: 'organic', score: 40, weight: 0.15, reason: `Decent organic score (${score})` };
  if (score < 80) return { name: 'organic', score: 70, weight: 0.15, reason: `Good organic score (${score})` };
  return { name: 'organic', score: 90, weight: 0.15, reason: `Excellent organic score (${score})` };
}

function evaluateAge(pool: EnrichedPool): Signal {
  const age = (pool as any).ageHours;
  if (age === undefined || age === Infinity) return { name: 'age', score: 0, weight: 0.1, reason: 'Unknown age' };

  // New tokens (1-48h) are prime sniping territory
  if (age < 1) return { name: 'age', score: 50, weight: 0.1, reason: `Very fresh (${age.toFixed(1)}h) — high risk/reward` };
  if (age < 6) return { name: 'age', score: 80, weight: 0.1, reason: `Fresh token (${age.toFixed(1)}h) — prime window` };
  if (age < 24) return { name: 'age', score: 60, weight: 0.1, reason: `Young (${age.toFixed(1)}h) — still early` };
  if (age < 72) return { name: 'age', score: 30, weight: 0.1, reason: `Established (${age.toFixed(1)}h)` };
  return { name: 'age', score: -10, weight: 0.1, reason: `Old token (${age.toFixed(0)}h) — less upside` };
}

function evaluate1hMomentum(pool: EnrichedPool): Signal {
  const change = (pool as any).priceChange1hPct ?? pool.dex?.priceChange24hPct;
  if (change === undefined) return { name: 'momentum1h', score: 0, weight: 0.1, reason: 'No 1h data' };

  if (change < -15) return { name: 'momentum1h', score: -70, weight: 0.1, reason: `Dumping hard 1h (${change.toFixed(1)}%)` };
  if (change < -5) return { name: 'momentum1h', score: -30, weight: 0.1, reason: `Declining 1h (${change.toFixed(1)}%)` };
  if (change < 5) return { name: 'momentum1h', score: 20, weight: 0.1, reason: `Stable 1h (${change.toFixed(1)}%)` };
  if (change < 20) return { name: 'momentum1h', score: 70, weight: 0.1, reason: `Good 1h momentum (${change.toFixed(1)}%)` };
  if (change < 50) return { name: 'momentum1h', score: 40, weight: 0.1, reason: `Strong 1h pump (${change.toFixed(1)}%) — watch for pullback` };
  return { name: 'momentum1h', score: -20, weight: 0.1, reason: `Extreme 1h pump (${change.toFixed(1)}%) — likely top` };
}

function evaluateRedFlags(pool: EnrichedPool): Signal {
  const reasons: string[] = [];
  let penalty = 0;

  // No price data at all = suspicious
  if (!pool.dex?.priceUsd) {
    reasons.push('No price data');
    penalty += 30;
  }

  // Extremely low liquidity with high volume = likely manipulation
  const liq = pool.dex?.liquidityUsd ?? 0;
  const vol = pool.dex?.volume24hUsd ?? 0;
  if (liq > 0 && vol > 0 && vol / liq > 20) {
    reasons.push('Volume/liquidity ratio extreme — wash trading');
    penalty += 40;
  }

  if (reasons.length === 0) return { name: 'redFlags', score: 10, weight: 0.1, reason: 'No red flags detected' };
  return { name: 'redFlags', score: -penalty, weight: 0.1, reason: reasons.join('; ') };
}

export async function decideWithClaude(args: {
  openRouterApiKey?: string;
  model?: string;
  candidate: EnrichedPool;
}): Promise<BrainDecision> {
  const { candidate } = args;

  const signals: Signal[] = [
    evaluateLiquidity(candidate),
    evaluateVolume(candidate),
    evaluatePriceAction(candidate),
    evaluateMarketCap(candidate),
    evaluateOrganicScore(candidate),
    evaluateAge(candidate),
    evaluate1hMomentum(candidate),
    evaluateRedFlags(candidate),
  ];

  // Weighted score (-100 to +100)
  const totalWeight = signals.reduce((sum, s) => sum + s.weight, 0);
  const weightedScore = signals.reduce((sum, s) => sum + s.score * s.weight, 0) / totalWeight;

  // Normalize to 0-1 confidence
  const confidence = Math.max(0, Math.min(1, (weightedScore + 100) / 200));

  const reasoning = signals.map(s => `[${s.name}] ${s.reason} (${s.score > 0 ? '+' : ''}${s.score})`).join(' | ');

  logger.debug({
    pool: candidate.poolAddress,
    signals: signals.map(s => ({ name: s.name, score: s.score })),
    weightedScore: weightedScore.toFixed(2),
    confidence: confidence.toFixed(3),
  }, 'Brain analysis');

  // ENTER threshold: confidence > 0.60 (slightly more aggressive to find more gems)
  const action = confidence >= 0.60 ? 'ENTER' : 'SKIP';

  return { action, confidence, reasoning };
}
