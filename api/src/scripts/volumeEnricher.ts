/**
 * Volume Enricher Sidecar
 * 
 * A long-running process that listens for new swap INSERTs via PostgreSQL NOTIFY,
 * fetches USD token prices from Jupiter Price API V3, and UPDATEs the swap with volume_usd.
 * 
 * The GRPC server holds INSERT notifications waiting for this enrichment (configurable
 * timeout via GRPC_DEDUP_TIMEOUT_SECS, default 5s). Once the UPDATE is done, the GRPC
 * emits the enriched swap to clients.
 * 
 * Usage:
 *   npx ts-node api/src/scripts/volumeEnricher.ts
 *   # or in production:
 *   node dist/scripts/volumeEnricher.js
 * 
 * Environment Variables:
 *   DATABASE_URL              - PostgreSQL connection string (required, same as API)
 *   JUPITER_API_URL           - Jupiter API base URL (default: https://api.jup.ag)
 *   JUPITER_API_KEY           - Jupiter API key for higher rate limits (optional)
 *   JUPITER_TIMEOUT_MS        - Jupiter API request timeout in ms (default: 3000)
 *   PRICE_CACHE_TTL_MS        - How long to cache token prices in ms (default: 30000)
 */

import { Pool, Client } from 'pg';
import dotenv from 'dotenv';
import { fetchTokenPrices, PriceResult } from '../services/jupiterPriceService';

dotenv.config();

// --- Pool Info Cache ---

interface PoolInfo {
  token0: string;
  token1: string;
}

const poolInfoCache = new Map<string, PoolInfo>();

// --- DB Pool ---

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  min: 1,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  application_name: 'omnipair_volume_enricher',
});

// --- Pool Info Lookup ---

async function getPoolInfo(pairAddress: string): Promise<PoolInfo | null> {
  const cached = poolInfoCache.get(pairAddress);
  if (cached) return cached;

  try {
    const result = await pool.query(
      'SELECT token0, token1 FROM pools WHERE pair_address = $1',
      [pairAddress]
    );

    if (result.rows.length === 0) {
      console.warn(`No pool found for pair ${pairAddress}`);
      return null;
    }

    const row = result.rows[0];
    const info: PoolInfo = {
      token0: row.token0,
      token1: row.token1,
    };

    poolInfoCache.set(pairAddress, info);
    return info;
  } catch (error: any) {
    console.error(`Error fetching pool info for ${pairAddress}:`, error.message);
    return null;
  }
}

// --- Volume Calculation ---

interface EnrichmentResult {
  volumeUsd: number;
  lpFeeUsd: number;
  protocolFeeUsd: number;
}

async function computeSwapUsdValues(
  pairAddress: string,
  isToken0In: boolean,
  amountIn: string,
  amountOut: string,
  lpFee: string,
  protocolFee: string
): Promise<EnrichmentResult> {
  const poolInfo = await getPoolInfo(pairAddress);
  if (!poolInfo) return { volumeUsd: 0, lpFeeUsd: 0, protocolFeeUsd: 0 };

  const tokenInMint = isToken0In ? poolInfo.token0 : poolInfo.token1;
  const tokenOutMint = isToken0In ? poolInfo.token1 : poolInfo.token0;

  const prices = await fetchTokenPrices([tokenInMint, tokenOutMint]);

  // lp_fee and protocol_fee are denominated in the input token
  const tokenInPrice = prices.get(tokenInMint);
  if (tokenInPrice) {
    const decimals = Math.pow(10, tokenInPrice.decimals);
    const price = tokenInPrice.price;
    return {
      volumeUsd: parseFloat(amountIn) / decimals * price,
      lpFeeUsd: parseFloat(lpFee) / decimals * price,
      protocolFeeUsd: parseFloat(protocolFee) / decimals * price,
    };
  }

  // Fallback: use output token price for volume only; derive fee USD via ratio
  const tokenOutPrice = prices.get(tokenOutMint);
  if (tokenOutPrice) {
    const volumeUsd = parseFloat(amountOut) / Math.pow(10, tokenOutPrice.decimals) * tokenOutPrice.price;
    const totalFeeRaw = parseFloat(lpFee) + parseFloat(protocolFee);
    if (totalFeeRaw > 0 && parseFloat(amountIn) > 0) {
      const feeToVolumeRatio = totalFeeRaw / parseFloat(amountIn);
      const totalFeeUsd = volumeUsd * feeToVolumeRatio;
      const lpShare = parseFloat(lpFee) / totalFeeRaw;
      return {
        volumeUsd,
        lpFeeUsd: totalFeeUsd * lpShare,
        protocolFeeUsd: totalFeeUsd * (1 - lpShare),
      };
    }
    return { volumeUsd, lpFeeUsd: 0, protocolFeeUsd: 0 };
  }

  console.warn(`No USD price available for either token in pair ${pairAddress}`);
  return { volumeUsd: 0, lpFeeUsd: 0, protocolFeeUsd: 0 };
}

// --- Swap Notification Handler ---

interface SwapNotification {
  op: string;
  id: string;
  pair: string;
  is_token0_in: boolean;
  amount_in: string;
  amount_out: string;
  tx_sig: string;
  lp_fee: string;
  protocol_fee: string;
  volume_usd: string;
}

async function handleSwapNotification(payload: string): Promise<void> {
  let notification: SwapNotification;
  try {
    notification = JSON.parse(payload);
  } catch (error) {
    console.error('Failed to parse swap notification:', error);
    return;
  }

  // Only process INSERT notifications (UPDATE means it's already enriched)
  if (notification.op !== 'INSERT') {
    return;
  }

  // Skip if volume_usd is already set (shouldn't happen on INSERT but just in case)
  if (notification.volume_usd && notification.volume_usd !== '' && notification.volume_usd !== '0') {
    return;
  }

  const txSig = notification.tx_sig;
  const pairAddress = notification.pair;

  try {
    const result = await computeSwapUsdValues(
      pairAddress,
      notification.is_token0_in,
      notification.amount_in,
      notification.amount_out,
      notification.lp_fee || '0',
      notification.protocol_fee || '0'
    );

    await pool.query(
      'UPDATE swaps SET volume_usd = $1, lp_fee_usd = $2, protocol_fee_usd = $3 WHERE tx_sig = $4',
      [result.volumeUsd, result.lpFeeUsd, result.protocolFeeUsd, txSig]
    );

    console.log(
      `Enriched swap - Pair: ${pairAddress}, TxSig: ${txSig}, VolumeUSD: $${result.volumeUsd.toFixed(2)}, LpFeeUSD: $${result.lpFeeUsd.toFixed(4)}, ProtocolFeeUSD: $${result.protocolFeeUsd.toFixed(4)}`
    );
  } catch (error: any) {
    console.error(`Error enriching swap ${txSig}:`, error.message);
  }
}

// --- Main ---

async function main(): Promise<void> {
  console.log('=== Omnipair Volume Enricher ===');
  console.log('Connecting to PostgreSQL...');

  // Test connection
  await pool.query('SELECT 1');
  console.log('Database connection established');

  // Use a separate client for LISTEN (pg LISTEN requires a dedicated connection)
  const listenClient = new Client({
    connectionString: process.env.DATABASE_URL,
    application_name: 'omnipair_volume_enricher_listener',
  });

  await listenClient.connect();
  console.log('LISTEN client connected');

  await listenClient.query('LISTEN swap_updates');
  console.log('Listening on channel: swap_updates');
  console.log('Waiting for swap events...\n');

  listenClient.on('notification', async (msg) => {
    if (msg.channel === 'swap_updates' && msg.payload) {
      await handleSwapNotification(msg.payload);
    }
  });

  listenClient.on('error', (error) => {
    console.error('LISTEN client error:', error);
    process.exit(1);
  });

  // Keep the process alive
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await listenClient.end();
    await pool.end();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\nShutting down...');
    await listenClient.end();
    await pool.end();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
