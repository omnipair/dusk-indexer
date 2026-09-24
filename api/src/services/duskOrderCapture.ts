// Backend display capture; ported from the reviewed webapp adapter.
import {
  createLeverageDelegateProgram,
  deriveLeverageOrderAddress,
  deriveLeveragePositionAddress,
  deriveMarketAddress,
} from './virtualBook/native';
import { PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';

import { previewDuskEntryOrder } from './duskEntryOrderPreview';
import { minimumDuskReadSlot } from './virtualBook/native';
import { previewDuskHlpOrderTrigger } from './duskOrderTrigger';
import { boundedDuskRpcRead } from './virtualBook/native';

import type { DuskDeploymentEnvelope } from './duskDeploymentService';
import type { DuskReadBoundary } from './virtualBook/native';
import type {
  Dusk,
  LeverageDelegateProgram,
  LeveragePosition,
  Market,
} from '@omnipair/dusk-sdk';

type Name = 'leverageOrder' | 'leverageEntryOrder' | 'hlpOrder';
type Account<N extends Name> = Awaited<
  ReturnType<LeverageDelegateProgram['account'][N]['all']>
>[number]['account'];
export type DuskOrderRow<N extends Name> = {
  address: string;
  raw: { account: Buffer; market: Buffer; position: Buffer | null };
  account: Account<N>;
  market: Market;
  position: LeveragePosition | null;
  unixTimestamp: bigint;
  slot: number;
  trigger?: Awaited<ReturnType<typeof previewDuskHlpOrderTrigger>>['value'];
  entryMark?: Awaited<ReturnType<typeof previewDuskEntryOrder>>;
};
export interface DuskOrderSnapshot {
  owner: string;
  deployment: DuskDeploymentEnvelope;
  observedAt: number;
  slot: number;
  exit: DuskOrderRow<'leverageOrder'>[];
  entry: DuskOrderRow<'leverageEntryOrder'>[];
  hlp: DuskOrderRow<'hlpOrder'>[];
}

/** Validate the pinned delegate PDA even if RPC ignored its owner/discriminator filters. */
export function assertDuskOrderIdentity<N extends Name>(
  name: N,
  address: PublicKey,
  account: Account<N>,
  owner: string,
  program: PublicKey,
) {
  if (account.owner.toBase58() !== owner)
    throw new Error('Order belongs to another wallet');
  const id = Buffer.alloc(8);
  id.writeBigUInt64LE(BigInt(account.orderId.toString()));
  const seeds =
    name === 'leverageEntryOrder'
      ? [
          Buffer.from('leverage_entry_order'),
          account.market.toBuffer(),
          account.owner.toBuffer(),
          id,
        ]
      : name === 'hlpOrder'
        ? [
            Buffer.from('hlp_order'),
            account.market.toBuffer(),
            account.owner.toBuffer(),
            (account as Account<'hlpOrder'>).targetHlpMint.toBuffer(),
            id,
          ]
        : null;
  const [expected, bump] = seeds
    ? PublicKey.findProgramAddressSync(seeds, program)
    : deriveLeverageOrderAddress(
        (account as Account<'leverageOrder'>).position,
        account.owner,
        account.orderId.toString(),
        program,
      );
  if (!address.equals(expected) || account.bump !== bump)
    throw new Error('Invalid order address or bump');
  if (name === 'leverageEntryOrder') {
    const entry = account as Account<'leverageEntryOrder'>;
    if (
      ![0, 1].includes(entry.debtAsset) ||
      !entry.position.equals(
        deriveLeveragePositionAddress(entry.market, entry.positionId)[0],
      )
    )
      throw new Error('Invalid entry position identity');
  } else if (![1, 2].includes((account as Account<'hlpOrder'>).kind))
    throw new Error('Unknown order kind');
  if (
    name === 'hlpOrder' &&
    ![0, 1, 2].includes((account as Account<'hlpOrder'>).status)
  )
    throw new Error('Unknown hLP order status');
}

/** Discover first, then re-read each order with its native market, position and Clock in one bank. */
export async function readDuskOrders(options: {
  dusk: Dusk;
  boundary: Pick<DuskReadBoundary, 'assertCompatibleForRead'>;
  deployment: DuskDeploymentEnvelope;
  owner: string;
  previewPayer?: string;
  kinds?: readonly Name[];
  signal?: AbortSignal;
}): Promise<DuskOrderSnapshot> {
  const observedAt = Date.now();
  const { dusk, boundary, deployment, owner, signal } = options;
  const delegate = createLeverageDelegateProgram({
    provider: dusk.program.provider as Parameters<
      typeof createLeverageDelegateProgram
    >[0]['provider'],
  });
  if (
    dusk.program.programId.toBase58() !== deployment.programId ||
    delegate.programId.toBase58() !== deployment.leverageDelegateProgramId
  )
    throw new Error('Order SDK deployment mismatch');
  const connection = dusk.program.provider.connection;
  const before = await boundary.assertCompatibleForRead(deployment, signal);
  let floor = Math.max(before.observedSlot, minimumDuskReadSlot(deployment));
  const readKind = async <N extends Name>(
    name: N,
  ): Promise<DuskOrderRow<N>[]> => {
    if (options.kinds && !options.kinds.includes(name)) return [];
    const discovery = await boundedDuskRpcRead(
      () =>
        connection.getProgramAccounts(delegate.programId, {
          commitment: 'confirmed',
          withContext: true,
          minContextSlot: floor,
          filters: [
            { memcmp: delegate.coder.accounts.memcmp(name) },
            { memcmp: { offset: 8, bytes: owner } },
          ],
        }),
      signal,
    );
    if (
      !Number.isSafeInteger(discovery.context.slot) ||
      discovery.context.slot < floor ||
      discovery.value.length > 500
    )
      throw new Error('Order discovery is behind confirmed state');
    floor = discovery.context.slot;
    const rows: DuskOrderRow<N>[] = [];
    const seen = new Set<string>();
    const discovered = discovery.value.map(({ pubkey, account }) => {
      if (
        seen.has(pubkey.toBase58()) ||
        account.executable ||
        !account.owner.equals(delegate.programId)
      )
        throw new Error('Invalid discovered order account');
      seen.add(pubkey.toBase58());
      const raw = delegate.coder.accounts.decode<Account<N>>(
        name,
        account.data,
      );
      assertDuskOrderIdentity(name, pubkey, raw, owner, delegate.programId);
      return { pubkey, raw };
    });
    // Twenty orders keep each request below Solana's 100-account limit.
    for (let start = 0; start < discovered.length; start += 20) {
      const batch = discovered.slice(start, start + 20);
      const keys = new Map<string, PublicKey>([
        [SYSVAR_CLOCK_PUBKEY.toBase58(), SYSVAR_CLOCK_PUBKEY],
      ]);
      for (const { pubkey, raw } of batch) {
        for (const key of [
          pubkey,
          raw.market,
          ...(name === 'leverageOrder'
            ? [(raw as Account<'leverageOrder'>).position]
            : []),
        ])
          keys.set(key.toBase58(), key);
      }
      const addresses = [...keys.values()];
      const response = await boundedDuskRpcRead(
        () =>
          connection.getMultipleAccountsInfoAndContext(addresses, {
            commitment: 'confirmed',
            minContextSlot: floor,
          }),
        signal,
      );
      const slot = response.context.slot;
      if (
        !Number.isSafeInteger(slot) ||
        slot < floor ||
        response.value.length !== addresses.length
      )
        throw new Error('Order detail is behind confirmed state');
      floor = slot;
      const infos = new Map(
        addresses.map((key, index) => [key.toBase58(), response.value[index]]),
      );
      const clock = infos.get(SYSVAR_CLOCK_PUBKEY.toBase58());
      if (
        !clock ||
        clock.executable ||
        clock.owner.toBase58() !==
          'Sysvar1111111111111111111111111111111111111' ||
        clock.data.length !== 40 ||
        clock.data.readBigUInt64LE(0) !== BigInt(slot)
      )
        throw new Error('Invalid order Clock');
      const unixTimestamp = clock.data.readBigInt64LE(32);
      if (unixTimestamp <= 0n) throw new Error('Invalid order time');
      for (const { pubkey, raw } of batch) {
        const info = infos.get(pubkey.toBase58());
        if (!info) continue; // Cancelled/executed between discovery and detail.
        if (info.executable || !info.owner.equals(delegate.programId))
          throw new Error('Invalid order owner');
        const account = delegate.coder.accounts.decode<Account<N>>(
          name,
          info.data,
        );
        assertDuskOrderIdentity(
          name,
          pubkey,
          account,
          owner,
          delegate.programId,
        );
        if (!account.market.equals(raw.market))
          throw new Error('Order market changed');
        const marketInfo = infos.get(account.market.toBase58());
        if (
          !marketInfo ||
          marketInfo.executable ||
          !marketInfo.owner.equals(dusk.program.programId)
        )
          throw new Error('Order market is unavailable');
        const market = dusk.program.coder.accounts.decode<Market>(
          'market',
          marketInfo.data,
        );
        const [marketKey, marketBump] = deriveMarketAddress(
          market.baseSide.assetMint,
          market.quoteSide.assetMint,
          market.paramsHash,
        );
        if (
          market.version !== 1 ||
          !marketKey.equals(account.market) ||
          market.bump !== marketBump
        )
          throw new Error('Invalid order market identity');
        let position: LeveragePosition | null = null;
        let positionBytes: Buffer | null = null;
        if (name === 'leverageOrder') {
          const exit = account as Account<'leverageOrder'>;
          if (!exit.position.equals((raw as Account<'leverageOrder'>).position))
            throw new Error('Order position changed');
          const positionInfo = infos.get(exit.position.toBase58());
          if (positionInfo) {
            if (
              positionInfo.executable ||
              !positionInfo.owner.equals(dusk.program.programId)
            )
              throw new Error('Invalid order position owner');
            positionBytes = positionInfo.data;
            position = dusk.program.coder.accounts.decode<LeveragePosition>(
              'leveragePosition',
              positionInfo.data,
            );
            const [positionKey, bump] = deriveLeveragePositionAddress(
              position.market,
              position.positionId,
            );
            if (
              !positionKey.equals(exit.position) ||
              position.bump !== bump ||
              position.owner.toBase58() !== owner ||
              !position.market.equals(account.market) ||
              ![0, 1].includes(position.debtAsset)
            )
              throw new Error('Invalid order position identity');
          }
        }
        rows.push({
          address: pubkey.toBase58(),
          raw: {
            account: info.data,
            market: marketInfo.data,
            position: positionBytes,
          },
          account,
          market,
          position,
          unixTimestamp,
          slot,
        });
      }
    }
    return rows;
  };
  const exit = await readKind('leverageOrder'),
    entry = await readKind('leverageEntryOrder'),
    hlp = await readKind('hlpOrder');
  if (options.previewPayer)
    for (const row of entry) {
      // A failed price read must not remove the owner's escrowed order.
      row.entryMark = await previewDuskEntryOrder(
        dusk,
        row,
        options.previewPayer,
        floor,
        signal,
      ).catch(() => null);
      if (row.entryMark) floor = Math.max(floor, row.entryMark.slot);
    }
  if (options.previewPayer)
    for (const row of hlp) {
      if (row.account.status !== 0) continue;
      const targetAsset = row.market.baseSide.hlpMint.equals(
        row.account.targetHlpMint,
      )
        ? 0
        : row.market.quoteSide.hlpMint.equals(row.account.targetHlpMint)
          ? 1
          : -1;
      if (targetAsset < 0) throw new Error('Unknown hLP order vault');
      const trigger = await previewDuskHlpOrderTrigger(
        dusk,
        row.account.market,
        targetAsset,
        row.account.hlpAmount,
        options.previewPayer,
        floor,
        undefined,
        signal,
      ).catch(() => null);
      // An unexecutable trigger must not hide escrowed orders or wallet positions.
      if (trigger) {
        floor = Math.max(floor, trigger.slot);
        row.trigger = trigger.value;
      }
    }
  const after = await boundary.assertCompatibleForRead(deployment, signal);
  if (after.observedSlot < floor || signal?.aborted)
    throw new Error('Order read was invalidated');
  return {
    owner,
    deployment,
    observedAt,
    slot: floor,
    exit,
    entry,
    hlp,
  };
}
