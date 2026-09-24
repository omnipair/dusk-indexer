import test from 'node:test';
import assert from 'node:assert/strict';
import { BN } from '@coral-xyz/anchor';
import { IdlCoder } from '@coral-xyz/anchor/dist/cjs/coder/borsh/idl';
import { PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { displayFixture, displayKey } from './duskDisplayStateFixtures';
import {
  createLeverageDelegateProgram,
  deriveMarketAddress,
} from '../services/virtualBook/native';
import { readDuskOrders } from '../services/duskOrderCapture';
import {
  captureWalletSnapshot,
  walletCaptureDependencies,
} from '../services/duskWalletSnapshot';
import type { AccountInfo } from '@solana/web3.js';

async function fixture() {
  const f = await displayFixture(),
    delegate = createLeverageDelegateProgram({
      provider: f.dusk.program.provider as Parameters<
        typeof createLeverageDelegateProgram
      >[0]['provider'],
    });
  const market = f.market;
  const [marketKey, bump] = deriveMarketAddress(
    market.baseSide.assetMint,
    market.quoteSide.assetMint,
    market.paramsHash,
  );
  market.bump = bump;
  const layout = IdlCoder.typeDefLayout({
    typeDef: delegate.idl.types!.find((t) => t.name === 'leverageEntryOrder')!,
    types: delegate.idl.types!,
  });
  const entry = layout.decode(Buffer.alloc(16384));
  Object.assign(entry, {
    owner: f.owner,
    market: marketKey,
    positionId: displayKey(98),
    debtAsset: 1,
    orderId: new BN(1),
  });
  entry.position = f.dusk.get.pda.leveragePosition(
    marketKey,
    entry.positionId,
  )[0];
  const id = Buffer.alloc(8);
  id.writeBigUInt64LE(1n);
  const [order, orderBump] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('leverage_entry_order'),
      marketKey.toBuffer(),
      f.owner.toBuffer(),
      id,
    ],
    delegate.programId,
  );
  entry.bump = orderBump;
  const raw: AccountInfo<Buffer> = {
    data: await delegate.coder.accounts.encode('leverageEntryOrder', entry),
    owner: delegate.programId,
    executable: false,
    lamports: 1,
  };
  const marketInfo = f.encodeAccount('market', market),
    clock = Buffer.alloc(40);
  clock.writeBigUInt64LE(1010n);
  clock.writeBigInt64LE(1_000_000n, 32);
  const infos = new Map<string, AccountInfo<Buffer>>([
    [order.toBase58(), raw],
    [marketKey.toBase58(), marketInfo],
    [
      SYSVAR_CLOCK_PUBKEY.toBase58(),
      {
        data: clock,
        owner: new PublicKey('Sysvar1111111111111111111111111111111111111'),
        executable: false,
        lamports: 1,
      },
    ],
  ]);
  f.dusk.program.provider.connection.getProgramAccounts = (async (
    _program: PublicKey,
    options: { filters: { memcmp: { bytes: string } }[] },
  ) => ({
    context: { slot: 1010 },
    value:
      options.filters[0].memcmp.bytes ===
      delegate.coder.accounts.memcmp('leverageEntryOrder').bytes
        ? [{ pubkey: order, account: raw }]
        : [],
  })) as unknown as typeof f.dusk.program.provider.connection.getProgramAccounts;
  f.dusk.program.provider.connection.getMultipleAccountsInfoAndContext = async (
    keys,
  ) => ({
    context: { slot: 1010 },
    value: keys.map((k) => infos.get(k.toBase58()) ?? null),
  });
  const boundary = {
    assertCompatibleForRead: async () => ({ observedSlot: 1010 }),
  };
  const deployment = {
    ...f.deployment,
    leverageDelegateProgramId: delegate.programId.toBase58(),
  };
  const deps: typeof walletCaptureDependencies = {
    oracle: async () => [],
    accounts: async () => ({
      schemaVersion: 'dusk-owner-accounts.v1',
      owner: f.selection.owner,
      kind: 'leverage',
      complete: true,
      sourceSlot: 1010,
      observedAt: Date.now(),
      expiresAt: Date.now() + 15000,
      accounts: [],
    }),
    valuation: walletCaptureDependencies.valuation,
    orders: (options) =>
      readDuskOrders({ ...options, previewPayer: undefined }),
  };
  return { ...f, deployment, boundary, deps, raw, marketInfo, order, infos };
}

test('wallet stream preserves nonempty orders and full market bytes beyond Anchor encode buffer size', async () => {
  const f = await fixture();
  assert.ok(f.marketInfo.data.length > 1000);
  const result = await captureWalletSnapshot(
    f.dusk,
    f.boundary,
    f.selection.owner,
    f.deployment,
    undefined,
    f.deps,
  );
  assert.equal(result.orders.entry.length, 1);
  assert.equal(result.orders.entry[0].account, f.raw.data.toString('base64'));
  assert.equal(
    result.orders.entry[0].market,
    f.marketInfo.data.toString('base64'),
  );
  assert.equal(result.orders.entry[0].position, null);
});

test('backend order capture rejects a wrong owner and missing market evidence', async () => {
  const f = await fixture();
  await assert.rejects(
    readDuskOrders({
      dusk: f.dusk,
      boundary: f.boundary,
      deployment: f.deployment,
      owner: displayKey(99).toBase58(),
    }),
    /another wallet/,
  );
  for (const [key, account] of f.infos)
    if (account === f.marketInfo) f.infos.delete(key);
  await assert.rejects(
    readDuskOrders({
      dusk: f.dusk,
      boundary: f.boundary,
      deployment: f.deployment,
      owner: f.selection.owner,
    }),
    /market is unavailable/,
  );
});
