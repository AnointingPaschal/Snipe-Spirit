import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  SOLANA_RPC_URL: z.string().default('https://api.mainnet-beta.solana.com'),
  SOLANA_PRIVATE_KEY: z.string().min(1, 'SOLANA_PRIVATE_KEY is required'),

  // OpenRouter is now OPTIONAL — built-in brain works without it
  OPENROUTER_API_KEY: z.string().optional().default(''),
  OPENROUTER_MODEL: z.string().default('anthropic/claude-3.5-sonnet'),

  TRADE_AMOUNT_USD: z.coerce.number().positive().default(1),
  MAX_CONCURRENT_POSITIONS: z.coerce.number().int().positive().default(3),
  MIN_TVL_USD: z.coerce.number().nonnegative().default(5000),
  MIN_VOLUME_24H_USD: z.coerce.number().nonnegative().default(10000),
  SLIPPAGE_BPS: z.coerce.number().int().min(1).max(5000).default(300),
  DRY_RUN: z
    .string()
    .optional()
    .transform((v) => (v ?? 'true').toLowerCase() === 'true'),

  STOP_LOSS_PCT: z.coerce.number().default(-15),
  TAKE_PROFIT_PCT: z.coerce.number().default(25),

  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(15000)
});

export type AppConfig = z.infer<typeof envSchema>;

export const config: AppConfig = envSchema.parse({
  SOLANA_RPC_URL: process.env.SOLANA_RPC_URL,
  SOLANA_PRIVATE_KEY: process.env.SOLANA_PRIVATE_KEY,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  OPENROUTER_MODEL: process.env.OPENROUTER_MODEL,
  TRADE_AMOUNT_USD: process.env.TRADE_AMOUNT_USD,
  MAX_CONCURRENT_POSITIONS: process.env.MAX_CONCURRENT_POSITIONS,
  MIN_TVL_USD: process.env.MIN_TVL_USD,
  MIN_VOLUME_24H_USD: process.env.MIN_VOLUME_24H_USD,
  SLIPPAGE_BPS: process.env.SLIPPAGE_BPS,
  DRY_RUN: process.env.DRY_RUN,
  STOP_LOSS_PCT: process.env.STOP_LOSS_PCT,
  TAKE_PROFIT_PCT: process.env.TAKE_PROFIT_PCT,
  POLL_INTERVAL_MS: process.env.POLL_INTERVAL_MS
});
