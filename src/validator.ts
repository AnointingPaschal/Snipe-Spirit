import { Connection, PublicKey } from '@solana/web3.js';
import type { DiscoveredPool, ValidatedPool } from './types.js';
import { logger } from './logger.js';

export interface ValidateOptions {
  minTvlUsd: number;
  minVolume24hUsd: number;
}

/**
 * On-chain validation:
 * - Check TVL/volume thresholds from discovery data
 * - Verify pool account exists on-chain
 * - No DLMM SDK needed — we use raw RPC + enrichment data
 */
export async function validatePool(
  connection: Connection,
  pool: DiscoveredPool,
  opts: ValidateOptions
): Promise<ValidatedPool | null> {
  // Thresholds first (cheap)
  const tvl = pool.tvlUsd ?? 0;
  const vol = pool.volume24hUsd ?? 0;
  if (tvl < opts.minTvlUsd) return null;
  if (vol < opts.minVolume24hUsd) return null;

  if (!pool.poolAddress) {
    return {
      ...pool,
      validated: true
    };
  }

  try {
    const pubkey = new PublicKey(pool.poolAddress);
    const info = await connection.getAccountInfo(pubkey, { commitment: 'confirmed' });
    if (!info) {
      logger.debug({ poolAddress: pool.poolAddress }, 'Pool account not found on-chain');
      return null;
    }

    // Account exists and has data — valid pool
    logger.debug({
      poolAddress: pool.poolAddress,
      dataLen: info.data.length,
      owner: info.owner.toBase58()
    }, 'Pool validated on-chain');

    return {
      ...pool,
      validated: true
    };
  } catch (e) {
    logger.warn({ err: e, poolAddress: pool.poolAddress }, 'Pool validation failed');
    return null;
  }
}
