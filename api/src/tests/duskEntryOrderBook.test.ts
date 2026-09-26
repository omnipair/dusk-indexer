import test from 'node:test';
import assert from 'node:assert/strict';
import { BN } from '@coral-xyz/anchor';
import { IdlCoder } from '@coral-xyz/anchor/dist/cjs/coder/borsh/idl';
import { PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import type { AccountInfo } from '@solana/web3.js';
import { createLeverageDelegateProgram } from '../services/virtualBook/native';
import { captureMarketEntryOrders } from '../services/duskEntryOrderBook';
import { displayFixture, displayKey } from './duskDisplayStateFixtures';

async function fixture() {
  const f = await displayFixture(),
    delegate = createLeverageDelegateProgram({
      provider: f.dusk.program.provider as Parameters<typeof createLeverageDelegateProgram>[0]['provider'],
    });
  const market = f.marketAddress,
    base = f.market.baseSide.assetMint,
    quote = f.market.quoteSide.assetMint;
  const layout = IdlCoder.typeDefLayout({
    typeDef: delegate.idl.types!.find((t) => t.name === 'leverageEntryOrder')!,
    types: delegate.idl.types!,
  });
  const infos = new Map<string, AccountInfo<Buffer> | null>();
  const state = { slot: 1500, now: 1_790_000_000n, requests: [] as { keys: string[]; minContextSlot?: number }[] };
  async function entry(orderId: number, owner: PublicKey, changes: Record<string, unknown> = {}) {
    const account = layout.decode(Buffer.alloc(16384));
    const id = Buffer.alloc(8);
    id.writeBigUInt64LE(BigInt(orderId));
    const [address, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from('leverage_entry_order'), market.toBuffer(), owner.toBuffer(), id],
      delegate.programId,
    );
    Object.assign(account, {
      owner, market, positionId: displayKey(100 + orderId), debtMint: quote, collateralMint: base, orderId: new BN(orderId),
      debtAsset: 1, marginAmount: new BN(2_000_000), multiplierBps: new BN(30_000), limitPriceNad: new BN(1_250_000_000),
      expiryUnixTimestamp: new BN((state.now + 60n).toString()), bump, ...changes,
    });
    account.position = f.dusk.get.pda.leveragePosition(market, account.positionId)[0];
    infos.set(address.toBase58(), {
      data: await delegate.coder.accounts.encode('leverageEntryOrder', account),
      owner: delegate.programId,
      executable: false,
      lamports: 1,
    });
    return address.toBase58();
  }
  f.dusk.program.provider.connection.getMultipleAccountsInfoAndContext = async (keys, config) => {
    state.requests.push({ keys: keys.map((key) => key.toBase58()), minContextSlot: (config as { minContextSlot?: number }).minContextSlot });
    const clock = Buffer.alloc(40);
    clock.writeBigUInt64LE(BigInt(state.slot));
    clock.writeBigInt64LE(state.now, 32);
    return {
      context: { slot: state.slot },
      value: keys.map((key) =>
        key.equals(SYSVAR_CLOCK_PUBKEY)
          ? { data: clock, owner: new PublicKey('Sysvar1111111111111111111111111111111111111'), executable: false, lamports: 1 }
          : (infos.get(key.toBase58()) ?? null),
      ),
    };
  };
  const selection = { address: market.toBase58(), baseMint: base.toBase58(), quoteMint: quote.toBase58() };
  return { ...f, delegate, infos, state, entry, selection };
}

test('book orders keep live, unexpired orders at or after the book bank and drop closed ones', async () => {
  const f = await fixture();
  const live = await f.entry(1, displayKey(81));
  const sell = await f.entry(2, displayKey(82), { debtAsset: 0, debtMint: f.market.baseSide.assetMint, collateralMint: f.market.quoteSide.assetMint });
  const expired = await f.entry(3, displayKey(83), { expiryUnixTimestamp: new BN((f.state.now - 1n).toString()) });
  const closed = displayKey(84).toBase58();
  const result = await captureMarketEntryOrders(f.dusk, f.selection, 1490, undefined, async (market) => {
    assert.equal(market, f.selection.address);
    return [live, sell, expired, closed];
  });
  assert.equal(result.sourceSlot, 1500);
  assert.equal(result.unixTimestamp, '1790000000');
  assert.deepEqual(result.orders.map((row) => row.address).sort(), [live, sell].sort());
  assert.deepEqual(result.orders.find((row) => row.address === live), {
    address: live, owner: displayKey(81).toBase58(), debtAsset: 1, marginAmount: '2000000', multiplierBps: '30000',
    limitPriceNad: '1250000000', expiryUnixTimestamp: '1790000060',
  });
  assert.equal(f.state.requests[0].minContextSlot, 1490);
  assert.equal(f.state.requests[0].keys.at(-1), SYSVAR_CLOCK_PUBKEY.toBase58());
});

test('an empty book is still dated by its Clock, and a foreign or regressed order read fails', async () => {
  const f = await fixture();
  const empty = await captureMarketEntryOrders(f.dusk, f.selection, 1490, undefined, async () => []);
  assert.deepEqual(empty, { sourceSlot: 1500, unixTimestamp: '1790000000', orders: [] });
  assert.deepEqual(f.state.requests.at(-1)!.keys, [SYSVAR_CLOCK_PUBKEY.toBase58()]);
  const foreign = await f.entry(4, displayKey(85), { collateralMint: displayKey(86) });
  await assert.rejects(captureMarketEntryOrders(f.dusk, f.selection, 1490, undefined, async () => [foreign]), /another market or token pair/);
  await assert.rejects(captureMarketEntryOrders(f.dusk, f.selection, 1501, undefined, async () => []), /behind the book/);
});
