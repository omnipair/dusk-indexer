#!/usr/bin/env node
/**
 * Builds src/config/cmcUnifiedCryptoassetIds.ts by resolving Solana mints to
 * CoinMarketCap unified cryptoasset ids using the same public endpoint family
 * as coinmarketcap.com (data-api/v3/cryptocurrency/detail?slug=...).
 *
 * Verifies each hit against platforms[].contractAddress on Solana.
 * Wrapped SOL (WSOL) uses numeric id of the Solana asset when the mint is
 * absent from CMC platform rows (same as coinmarketcap.com behaviour).
 *
 * If CMC_PRO_API_KEY is set, merges CoinMarketCap Pro /v1/cryptocurrency/map
 * Solana token_address -> id before slug resolution (same source as the
 * documented CMC Pro /cryptocurrency/map endpoint).
 *
 * Usage:
 *   node scripts/generate-cmc-unified-cryptoasset-map.mjs
 *   node scripts/generate-cmc-unified-cryptoasset-map.mjs http://127.0.0.1:2650
 *   CMC_PRO_API_KEY=... node scripts/generate-cmc-unified-cryptoasset-map.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.join(__dirname, '..');
const OUT_FILE = path.join(API_ROOT, 'src/config/cmcUnifiedCryptoassetIds.ts');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** Manual slug when name-based slug fails (mint -> slug on coinmarketcap.com). */
const SLUG_OVERRIDE_BY_MINT = {
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'usd-coin',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'tether',
  [WSOL_MINT]: 'solana',
  'JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD': 'jupiter-perpetuals-liquidity-provider-token',
  'G7vQWurMkMMm2dU3iZpXYFTHT9Biio4F4gZCrwFpKNwG': 'moonbirds',
  'StargWr5r6r8gZSjmEKGZ1dmvKWkj79r2z1xqjFstar': 'star',
  'kySo1nETpsZE2NWe5vj2C64mPSciH1SppmHb4XieQ7B': 'kyros-restaked-sol',
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn': 'jito-staked-sol',
  'BULKoNSGzxtCqzwTvg5hFJg8fx6dqZRScyXe5LYMfxrn': 'bulk-staked-sol',
  '98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g': 'hyperliquid',
  'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij': 'coinbase-wrapped-btc',
  'AymATz4TCL9sWNEEV9Kvyz45CHVhDZ6kUgjTJPzLpU9P': 'tether-gold',
  'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL': 'jito',
  'sTorERYB6xAZ1SSbwpK3zoK2EEwbBrc7TZAzg1uCGiH': 'staked-ore',
  'oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp': 'ore',
  '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump': 'fartcoin',
  'H74CYmXgMkYHYuSRsZt6RJb4NYp2u72Vw8BS5huApump': 'lmao-2',
  '3dQTr7ror2QPKQ3GbBCokJUmjErGg8kTJzdnYjNfvi3Z': 'swissborg',
  'PRVT6TB7uss3FrUd2D9xs2zqDBsa3GbMJMwCQsgmeta': 'umbra-2',
  'SoLo9oxzLDpcq1dpqAgMwgce5WqkRDtNXK7EPnbmeta': 'solomon-2',
  'METAwkXcqyXKy1AtsSgJ8JiUHwGCafnZL38n3vYmeta': 'metadao',
  'BANKJmvhT8tiJRsBSS1n2HryMBPvT5Ze4HU95DUAmeta': 'avici',
  'LYLikzBQtpa9ZgVrJsqYGQpR3cC1WMJrBHaXGrQmeta': 'loyal-2',
  'omfgRBnxHsNJh6YeGbGAmWenNkenzsXyBXm3WDhmeta': 'omnipair',
};

function slugify(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[''"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function candidateSlugs(name, mint) {
  const out = [];
  const ovr = SLUG_OVERRIDE_BY_MINT[mint];
  if (ovr) out.push(ovr);
  out.push(slugify(name));
  const n = name.replace(/\s+/g, ' ').trim();
  if (n !== name) out.push(slugify(n));
  return [...new Set(out.filter(Boolean))];
}

function hasSolanaMint(platforms, mint) {
  if (!Array.isArray(platforms)) return false;
  return platforms.some(
    (p) =>
      p.contractAddress === mint &&
      String(p.contractPlatform || '')
        .toLowerCase()
        .includes('solana')
  );
}

async function fetchDetailBySlug(slug) {
  const url = `https://api.coinmarketcap.com/data-api/v3/cryptocurrency/detail?slug=${encodeURIComponent(slug)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return null;
  const j = await res.json();
  const data = j.data;
  if (!data || typeof data.id !== 'number') return null;
  return data;
}

/** Full CMC Pro map: Solana mint -> unified id (when platform lists the mint). */
async function fetchProSolanaMintMap(apiKey) {
  const map = new Map();
  let start = 1;
  const limit = 5000;
  for (;;) {
    const url = `https://pro-api.coinmarketcap.com/v1/cryptocurrency/map?listing_status=active&start=${start}&limit=${limit}`;
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'X-CMC_PRO_API_KEY': apiKey,
      },
    });
    const j = await res.json();
    if (!res.ok) {
      throw new Error(j?.status?.error_message || `HTTP ${res.status}`);
    }
    const rows = j.data || [];
    for (const row of rows) {
      const plat = row.platform;
      if (!plat?.token_address) continue;
      if (String(plat.name || '').toLowerCase() !== 'solana') continue;
      map.set(plat.token_address, String(row.id));
    }
    if (rows.length < limit) break;
    start += limit;
    await sleep(350);
  }
  console.error(`[cmc-pro] Solana rows in map: ${map.size}`);
  return map;
}

async function resolveUcid(mint, name) {
  for (const slug of candidateSlugs(name, mint)) {
    try {
      const data = await fetchDetailBySlug(slug);
      await sleep(180);
      if (!data) continue;
      if (hasSolanaMint(data.platforms, mint)) {
        return String(data.id);
      }
      if (mint === WSOL_MINT && slug === 'solana' && data.id) {
        return String(data.id);
      }
    } catch {
      await sleep(200);
    }
  }
  return '';
}

async function main() {
  const base =
    process.argv[2] || process.env.ASSETS_BASE_URL || 'http://127.0.0.1:2650';
  const assetsUrl = `${base.replace(/\/$/, '')}/api/v1/cmc/assets`;
  console.error(`Fetching ${assetsUrl}`);

  const res = await fetch(assetsUrl);
  if (!res.ok) {
    console.error(`Failed to fetch assets: ${res.status}`);
    process.exit(1);
  }
  const assets = await res.json();
  const mints = Object.keys(assets).sort();

  let proMintMap = new Map();
  const cmcKey = process.env.CMC_PRO_API_KEY;
  if (cmcKey) {
    try {
      proMintMap = await fetchProSolanaMintMap(cmcKey);
    } catch (e) {
      console.error('[cmc-pro] map fetch failed, falling back to public slug lookup:', e.message);
    }
  }

  const map = {};
  for (const mint of mints) {
    const name = assets[mint]?.name || '';
    process.stderr.write(`${mint.slice(0, 8)}... ${name} `);
    let id = proMintMap.get(mint);
    if (!id) {
      id = await resolveUcid(mint, name);
    }
    map[mint] = id;
    console.error(id ? `-> ${id}` : '-> (no match)');
  }

  const lines = mints.map(
    (m) => `  '${m}': '${map[m] || ''}',`
  );

  const header = `/**
 * Solana mint address -> CoinMarketCap unified cryptoasset id (string).
 * Generated by scripts/generate-cmc-unified-cryptoasset-map.mjs from live
 * GET /api/v1/cmc/assets + optional CMC Pro map + public CMC detail (slug) API.
 * Re-run the script after new pools/tokens appear (set CMC_PRO_API_KEY for
 * full coverage from pro-api.coinmarketcap.com /v1/cryptocurrency/map).
 */
`;

  const body = `${header}export const CMC_UNIFIED_CRYPTOASSET_ID_BY_MINT: Record<string, string> = {\n${lines.join(
    '\n'
  )}\n};\n`;

  fs.writeFileSync(OUT_FILE, body, 'utf8');
  console.error(`Wrote ${OUT_FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
