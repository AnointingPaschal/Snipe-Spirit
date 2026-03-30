import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { fetch } from 'undici';
import type { SwapResult } from './types.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

export function loadKeypairFromEnv(secret: string): Keypair {
  // Accept base58 or JSON array
  const trimmed = secret.trim();
  if (trimmed.startsWith('[')) {
    const arr = JSON.parse(trimmed);
    if (!Array.isArray(arr)) throw new Error('Invalid SOLANA_PRIVATE_KEY JSON');
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  const bytes = bs58.decode(trimmed);
  return Keypair.fromSecretKey(bytes);
}

export async function jupiterQuote(args: {
  inputMint: string;
  outputMint: string;
  amountLamports: bigint;
  slippageBps: number;
}): Promise<any> {
  const url = new URL('https://lite-api.jup.ag/swap/v1/quote');
  url.searchParams.set('inputMint', args.inputMint);
  url.searchParams.set('outputMint', args.outputMint);
  url.searchParams.set('amount', args.amountLamports.toString());
  url.searchParams.set('slippageBps', String(args.slippageBps));

  const res = await fetch(url.toString(), { headers: { accept: 'application/json' } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Jupiter quote error ${res.status}: ${text}`);
  }
  return res.json();
}

export async function jupiterSwapTx(args: {
  userPublicKey: string;
  quoteResponse: any;
}): Promise<{ swapTransaction: string }> {
  const res = await fetch('https://lite-api.jup.ag/swap/v1/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      userPublicKey: args.userPublicKey,
      quoteResponse: args.quoteResponse,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto'
    })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Jupiter swap error ${res.status}: ${text}`);
  }
  const json: any = await res.json();
  if (!json?.swapTransaction || typeof json.swapTransaction !== 'string') {
    throw new Error('Jupiter swap: invalid response');
  }
  return { swapTransaction: json.swapTransaction };
}

export async function executeSwap(args: {
  connection: Connection;
  signer: Keypair;
  outputMint: string;
  amountSol: number;
  slippageBps: number;
  dryRun: boolean;
}): Promise<SwapResult> {
  const inAmountLamports = BigInt(Math.floor(args.amountSol * 1e9));
  const inputMint = SOL_MINT;

  // In dry run mode, skip Jupiter entirely — just log the intent
  if (args.dryRun) {
    return {
      signature: 'DRY_RUN',
      inputMint,
      outputMint: args.outputMint,
      inAmountLamports,
      outAmount: BigInt(0)
    };
  }

  const quote = await jupiterQuote({
    inputMint,
    outputMint: args.outputMint,
    amountLamports: inAmountLamports,
    slippageBps: args.slippageBps
  });

  // Jupiter v6 returns the quote object directly (not wrapped in data[])
  if (!quote || !quote.outAmount) throw new Error('Jupiter returned no valid quote');

  const outAmount = BigInt(quote.outAmount);

  const swap = await jupiterSwapTx({
    userPublicKey: args.signer.publicKey.toBase58(),
    quoteResponse: quote
  });

  const txBuf = Buffer.from(swap.swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([args.signer]);

  const sig = await args.connection.sendTransaction(tx, { maxRetries: 3 });
  await args.connection.confirmTransaction(sig, 'confirmed');

  return {
    signature: sig,
    inputMint,
    outputMint: args.outputMint,
    inAmountLamports,
    outAmount
  };
}

/**
 * Sell a token back to SOL via Jupiter
 */
export async function executeSell(args: {
  connection: Connection;
  signer: Keypair;
  tokenMint: string;
  slippageBps: number;
  dryRun: boolean;
}): Promise<SwapResult> {
  // First, get the token balance
  const tokenAccounts = await args.connection.getParsedTokenAccountsByOwner(
    args.signer.publicKey,
    { mint: new PublicKey(args.tokenMint) }
  );

  const account = tokenAccounts.value[0];
  if (!account) throw new Error('No token account found for this mint');

  const balance = account.account.data.parsed?.info?.tokenAmount;
  const rawAmount = balance?.amount;
  if (!rawAmount || rawAmount === '0') throw new Error('Zero token balance');

  const amountLamports = BigInt(rawAmount);

  if (args.dryRun) {
    return {
      signature: 'DRY_RUN_SELL',
      inputMint: args.tokenMint,
      outputMint: SOL_MINT,
      inAmountLamports: amountLamports,
      outAmount: BigInt(0)
    };
  }

  // Quote: token → SOL
  const quote = await jupiterQuote({
    inputMint: args.tokenMint,
    outputMint: SOL_MINT,
    amountLamports,
    slippageBps: args.slippageBps
  });

  if (!quote || !quote.outAmount) throw new Error('Jupiter returned no valid sell quote');

  const outAmount = BigInt(quote.outAmount);

  const swap = await jupiterSwapTx({
    userPublicKey: args.signer.publicKey.toBase58(),
    quoteResponse: quote
  });

  const txBuf = Buffer.from(swap.swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([args.signer]);

  const sig = await args.connection.sendTransaction(tx, { maxRetries: 3 });
  await args.connection.confirmTransaction(sig, 'confirmed');

  return {
    signature: sig,
    inputMint: args.tokenMint,
    outputMint: SOL_MINT,
    inAmountLamports: amountLamports,
    outAmount
  };
}

export const MINTS = {
  SOL: SOL_MINT
};
