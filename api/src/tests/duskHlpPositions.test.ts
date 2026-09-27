import test from 'node:test';
import assert from 'node:assert/strict';
import { BN } from '@coral-xyz/anchor';
import type { Dusk } from '@omnipair/dusk-sdk';
import { captureHlpPositions } from '../services/duskHlpPositions';
import type { DuskOrderRow } from '../services/duskOrderCapture';
import { displayKey } from './duskDisplayStateFixtures';

const market = displayKey(40),
  baseHlp = displayKey(41),
  quoteHlp = displayKey(42),
  payer = displayKey(80).toBase58();
const order = (target: typeof baseHlp, amount: number, kind: number, status = 0) =>
  ({
    account: { market, targetHlpMint: target, hlpAmount: new BN(amount), kind, status },
    market: { baseSide: { hlpMint: baseHlp }, quoteSide: { hlpMint: quoteHlp } },
  }) as unknown as DuskOrderRow<'hlpOrder'>;

test('hLP positions add open stop escrows to wallet shares and quote the total once per vault', async () => {
  const quotes: [number, string, number][] = [];
  const preview = (async (_dusk: Dusk, _market: unknown, target: number, amount: { toString(): string }, _payer: string, floor: number) => {
    quotes.push([target, amount.toString(), floor]);
    return target === 0
      ? { slot: floor + 3, value: null }
      : { slot: floor + 2, value: { principalNavPerTokenNad: new BN(1_020_000_000), fundingAprEmaNad: new BN(0) } };
  }) as unknown as Parameters<typeof captureHlpPositions>[6];
  const positions = await captureHlpPositions(
    {} as Dusk,
    [{ market: market.toBase58(), side: 'quote', hlpMint: quoteHlp.toBase58(), amount: '100' }],
    [
      order(quoteHlp, 40, 1),
      order(quoteHlp, 10, 2),
      // Retained after execution or cancellation: it no longer escrows shares.
      order(quoteHlp, 500, 1, 2),
      order(baseHlp, 5, 2),
    ],
    payer,
    700,
    undefined,
    preview,
  );
  assert.deepEqual(positions, [
    { market: market.toBase58(), side: 'base', hlpMint: baseHlp.toBase58(), walletBalance: '0', protectedBalance: '5',
      hasStopLoss: false, hasStopRate: true, principalNavPerTokenNad: null, sourceSlot: 703 },
    { market: market.toBase58(), side: 'quote', hlpMint: quoteHlp.toBase58(), walletBalance: '100', protectedBalance: '50',
      hasStopLoss: true, hasStopRate: true, principalNavPerTokenNad: '1020000000', sourceSlot: 702 },
  ]);
  assert.deepEqual(quotes, [[0, '5', 700], [1, '150', 700]]);
});

test('without a preview payer the withdrawal price is unknown, and a foreign vault is refused', async () => {
  const [position] = await captureHlpPositions(
    {} as Dusk,
    [{ market: market.toBase58(), side: 'base', hlpMint: baseHlp.toBase58(), amount: '3' }],
    [],
    undefined,
    700,
  );
  assert.equal(position.principalNavPerTokenNad, null);
  assert.equal(position.sourceSlot, 700);
  await assert.rejects(captureHlpPositions({} as Dusk, [], [order(displayKey(43), 1, 1)], payer, 700), /Unknown hLP order vault/);
});
