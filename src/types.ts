export type DecisionAction = 'ENTER' | 'SKIP';

export interface DiscoveredPool {
  source: 'meteora' | 'dexscreener';
  /** DLMM pool address if known */
  poolAddress?: string;
  /** token mint addresses */
  tokenMintA: string;
  tokenMintB: string;
  symbolA?: string;
  symbolB?: string;
  /** Best-effort metrics from discovery source */
  tvlUsd?: number;
  volume24hUsd?: number;
  /** Extra discovery metadata */
  priceUsd?: number;
  marketCapUsd?: number;
  priceChange24hPct?: number;
  priceChange1hPct?: number;
  ageHours?: number;
  pairCreatedAt?: number;
}

export interface ValidatedPool extends DiscoveredPool {
  validated: true;
  /** DLMM bin id / price info if SDK provides */
  activeBinId?: number;
  price?: number;
}

export interface DexScreenerPair {
  chainId: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  baseToken?: { address: string; name?: string; symbol?: string };
  quoteToken?: { address: string; name?: string; symbol?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  fdv?: number;
  marketCap?: number;
  priceChange?: { h24?: number; h6?: number; h1?: number; m5?: number };
  pairCreatedAt?: number | string;
  txns?: unknown;
  info?: unknown;
}

export interface EnrichedPool extends ValidatedPool {
  dex?: {
    url?: string;
    priceUsd?: number;
    liquidityUsd?: number;
    volume24hUsd?: number;
    marketCapUsd?: number;
    fdvUsd?: number;
    priceChange24hPct?: number;
  };
  organicScore: number;
  summary: string;
}

export interface BrainDecision {
  action: DecisionAction;
  confidence: number; // 0..1
  reasoning: string;
}

export interface SwapResult {
  signature: string;
  inputMint: string;
  outputMint: string;
  inAmountLamports: bigint;
  outAmount: bigint;
}

export interface Position {
  id: string;
  openedAt: number;
  poolAddress?: string;
  inputMint: string;
  outputMint: string;
  entrySignature?: string;
  entryPriceUsd?: number;
  amountInLamports: string;
  estimatedOutAmount: string;
  status: 'OPEN' | 'CLOSED';
  notes?: string;
}

export interface PositionsFile {
  positions: Position[];
}
