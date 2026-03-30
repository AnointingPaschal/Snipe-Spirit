import { Connection } from '@solana/web3.js';
import pLimit from 'p-limit';
import { config } from './config.js';
import { logger } from './logger.js';
import { discoverPools } from './discovery.js';
import { validatePool } from './validator.js';
import { enrichPool } from './enrichment.js';
import { decideWithClaude } from './brain.js';
import { executeSwap, executeSell, loadKeypairFromEnv, MINTS } from './executor.js';
import type { EnrichedPool, Position, PositionsFile, ValidatedPool } from './types.js';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const POSITIONS_PATH = new URL('../positions.json', import.meta.url).pathname;

async function getSolPrice(): Promise<number> {
  try {
    const res = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112');
    if (!res.ok) throw new Error('Failed to fetch SOL price');
    const json: any = await res.json();
    const pairs: any[] = json?.pairs ?? [];
    // Find SOL/USDC pair with most liquidity
    const usdc = pairs.filter((p: any) => 
      p.chainId === 'solana' && 
      (p.quoteToken?.symbol === 'USDC' || p.quoteToken?.symbol === 'USDT')
    );
    usdc.sort((a: any, b: any) => (b?.liquidity?.usd ?? 0) - (a?.liquidity?.usd ?? 0));
    const price = Number(usdc[0]?.priceUsd);
    if (Number.isFinite(price) && price > 0) return price;
  } catch {}
  // Fallback: use Jupiter quote (SOL → USDC)
  return 130; // safe fallback
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function readPositions(): Promise<PositionsFile> {
  try {
    const raw = await readFile(POSITIONS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.positions)) return { positions: parsed.positions };
  } catch {
    // ignore
  }
  return { positions: [] };
}

async function writePositions(file: PositionsFile) {
  await writeFile(POSITIONS_PATH, JSON.stringify(file, null, 2));
}

function openPositionsCount(file: PositionsFile): number {
  return file.positions.filter((p) => p.status === 'OPEN').length;
}

function pickOutputMint(candidate: EnrichedPool): string {
  if (candidate.tokenMintA === MINTS.SOL) return candidate.tokenMintB;
  return candidate.tokenMintA;
}

function getHeldMints(file: PositionsFile): Set<string> {
  const mints = new Set<string>();
  for (const p of file.positions) {
    if (p.status === 'OPEN') mints.add(p.outputMint);
  }
  return mints;
}

async function checkPositionsAndExit(
  file: PositionsFile,
  connection: Connection,
  signer: import('@solana/web3.js').Keypair
): Promise<boolean> {
  const open = file.positions.filter((p) => p.status === 'OPEN');
  if (!open.length) return false;
  
  let changed = false;
  
  for (const pos of open) {
    if (!pos.entryPriceUsd) continue;
    
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${pos.outputMint}`);
      if (!res.ok) continue;
      const json: any = await res.json();
      const pairs: any[] = Array.isArray(json?.pairs) ? json.pairs : [];
      const sol = pairs.filter((x: any) => x.chainId === 'solana');
      sol.sort((a: any, b: any) => (b?.liquidity?.usd ?? 0) - (a?.liquidity?.usd ?? 0));
      const px = Number(sol?.[0]?.priceUsd);
      if (!Number.isFinite(px)) continue;
      
      const pnlPct = ((px - pos.entryPriceUsd) / pos.entryPriceUsd) * 100;
      logger.info({ positionId: pos.id, entry: pos.entryPriceUsd, now: px, pnlPct: pnlPct.toFixed(2) }, 'PnL update');
      
      // Check stop-loss
      if (pnlPct <= config.STOP_LOSS_PCT) {
        logger.warn({ positionId: pos.id, pnlPct: pnlPct.toFixed(2), threshold: config.STOP_LOSS_PCT }, '🛑 STOP-LOSS triggered — selling');
        try {
          const sell = await executeSell({
            connection,
            signer,
            tokenMint: pos.outputMint,
            slippageBps: config.SLIPPAGE_BPS,
            dryRun: config.DRY_RUN
          });
          pos.status = 'CLOSED';
          pos.notes = `${pos.notes} | STOP-LOSS at ${pnlPct.toFixed(2)}% | sell tx: ${sell.signature} | SOL received: ${Number(sell.outAmount) / 1e9}`;
          changed = true;
          logger.info({ positionId: pos.id, sellSig: sell.signature, solReceived: Number(sell.outAmount) / 1e9 }, '✅ Position closed (stop-loss)');
        } catch (e) {
          logger.error({ err: e, positionId: pos.id }, 'Failed to execute stop-loss sell');
        }
      }
      
      // Check take-profit
      else if (pnlPct >= config.TAKE_PROFIT_PCT) {
        logger.info({ positionId: pos.id, pnlPct: pnlPct.toFixed(2), threshold: config.TAKE_PROFIT_PCT }, '🎯 TAKE-PROFIT triggered — selling');
        try {
          const sell = await executeSell({
            connection,
            signer,
            tokenMint: pos.outputMint,
            slippageBps: config.SLIPPAGE_BPS,
            dryRun: config.DRY_RUN
          });
          pos.status = 'CLOSED';
          pos.notes = `${pos.notes} | TAKE-PROFIT at ${pnlPct.toFixed(2)}% | sell tx: ${sell.signature} | SOL received: ${Number(sell.outAmount) / 1e9}`;
          changed = true;
          logger.info({ positionId: pos.id, sellSig: sell.signature, solReceived: Number(sell.outAmount) / 1e9 }, '✅ Position closed (take-profit)');
        } catch (e) {
          logger.error({ err: e, positionId: pos.id }, 'Failed to execute take-profit sell');
        }
      }
    } catch {
      // ignore
    }
  }
  
  return changed;
}

async function main() {
  const solPrice = await getSolPrice();
  const tradeAmountSol = config.TRADE_AMOUNT_USD / solPrice;

  logger.info({
    rpc: config.SOLANA_RPC_URL,
    tradeAmountUsd: config.TRADE_AMOUNT_USD,
    solPrice,
    tradeAmountSol: tradeAmountSol.toFixed(6),
    dryRun: config.DRY_RUN
  }, 'Starting Meteora sniper');

  const connection = new Connection(config.SOLANA_RPC_URL, 'confirmed');
  const signer = loadKeypairFromEnv(config.SOLANA_PRIVATE_KEY);

  logger.info({ pubkey: signer.publicKey.toBase58() }, 'Wallet loaded');

  const limit = pLimit(4);

  while (true) {
    try {
      const positions = await readPositions();
      const positionsChanged = await checkPositionsAndExit(positions, connection, signer);
      if (positionsChanged) await writePositions(positions);

      if (openPositionsCount(positions) >= config.MAX_CONCURRENT_POSITIONS) {
        logger.info('Max concurrent positions reached; waiting');
        await sleep(config.POLL_INTERVAL_MS);
        continue;
      }

      const discovered = await discoverPools(20);
      logger.info({ count: discovered.length }, 'Discovered pools');

      const validated: ValidatedPool[] = [];
      for (const p of discovered) {
        const v = await validatePool(connection, p, {
          minTvlUsd: config.MIN_TVL_USD,
          minVolume24hUsd: config.MIN_VOLUME_24H_USD
        });
        if (v) validated.push(v);
      }

      logger.info({ count: validated.length }, 'Validated pools');

      const enriched = await Promise.all(
        validated.slice(0, 10).map((p) => limit(() => enrichPool(p)))
      );

      for (const candidate of enriched) {
        if (openPositionsCount(positions) >= config.MAX_CONCURRENT_POSITIONS) break;

        logger.info({ summary: candidate.summary }, 'Candidate');

        let decision;
        try {
          decision = await decideWithClaude({
            openRouterApiKey: config.OPENROUTER_API_KEY,
            model: config.OPENROUTER_MODEL,
            candidate
          });
        } catch (e) {
          logger.warn({ err: e }, 'AI decision failed; skipping candidate');
          continue;
        }

        logger.info({ decision }, 'AI decision');
        if (decision.action !== 'ENTER' || decision.confidence < 0.6) continue;

        const outputMint = pickOutputMint(candidate);
        const heldMints = getHeldMints(positions);

        if (heldMints.has(outputMint)) {
          logger.info({ mint: outputMint, symbol: candidate.symbolA }, 'Skipping — already holding this token');
          continue;
        }

        try {
          const swap = await executeSwap({
            connection,
            signer,
            outputMint,
            amountSol: tradeAmountSol,
            slippageBps: config.SLIPPAGE_BPS,
            dryRun: config.DRY_RUN
          });

          const pos: Position = {
            id: randomUUID(),
            openedAt: Date.now(),
            poolAddress: candidate.poolAddress,
            inputMint: swap.inputMint,
            outputMint: swap.outputMint,
            entrySignature: swap.signature,
            entryPriceUsd: candidate.dex?.priceUsd,
            amountInLamports: swap.inAmountLamports.toString(),
            estimatedOutAmount: swap.outAmount.toString(),
            status: 'OPEN',
            notes: `AI: ${decision.reasoning}`
          };

          positions.positions.push(pos);
          await writePositions(positions);

          logger.info({ position: pos }, 'Position opened');
        } catch (e) {
          logger.error({ err: e }, 'Swap failed');
        }
      }
    } catch (e) {
      logger.error({ err: e }, 'Main loop error');
    }

    await sleep(config.POLL_INTERVAL_MS);
  }
}

main().catch((e) => {
  logger.fatal({ err: e }, 'Fatal error');
  process.exit(1);
});
