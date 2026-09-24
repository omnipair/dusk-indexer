import { PublicKey } from '@solana/web3.js';
import type { Dusk, LeveragePosition } from '@omnipair/dusk-sdk';
import type { DuskDeploymentEnvelope } from './duskDeploymentService';
import { listMarketActivity } from './duskMarketActivity';
import {
  boundedDuskRpcRead,
  deriveLeveragePositionAddress,
} from './virtualBook/native';

export async function captureMarketExposures(
  dusk: Dusk,
  deployment: DuskDeploymentEnvelope,
  signal?: AbortSignal,
) {
  const observedAt = Date.now();
  if (dusk.program.programId.toBase58() !== deployment.programId)
    throw new Error('Exposure SDK deployment mismatch');
  const result = await boundedDuskRpcRead(
    () =>
      dusk.program.provider.connection.getProgramAccounts(
        dusk.program.programId,
        {
          commitment: 'confirmed',
          withContext: true,
          minContextSlot: deployment.sourceSlot,
          filters: [
            { memcmp: dusk.program.coder.accounts.memcmp('leveragePosition') },
          ],
        },
      ),
    signal,
  );
  if (
    !Number.isSafeInteger(result.context.slot) ||
    result.context.slot < deployment.sourceSlot ||
    result.value.length > 10_000
  )
    throw new Error('Incomplete market exposure snapshot');
  const seen = new Set<string>(),
    byMarket = new Map<
      string,
      { baseCollateral: bigint; quoteCollateral: bigint; positions: number }
    >();
  for (const { pubkey, account } of result.value) {
    if (
      seen.has(pubkey.toBase58()) ||
      account.executable ||
      !account.owner.equals(dusk.program.programId)
    )
      throw new Error('Invalid exposure account');
    seen.add(pubkey.toBase58());
    const p = dusk.program.coder.accounts.decode<LeveragePosition>(
      'leveragePosition',
      account.data,
    );
    const [address, bump] = deriveLeveragePositionAddress(
      p.market,
      p.positionId,
    );
    if (
      !address.equals(pubkey) ||
      p.bump !== bump ||
      p.owner.equals(PublicKey.default) ||
      ![0, 1].includes(p.debtAsset)
    )
      throw new Error('Invalid exposure position');
    const amount = BigInt(p.collateralAmount.toString());
    if (amount < 0n) throw new Error('Invalid exposure amount');
    if (!amount) continue;
    const market = p.market.toBase58(),
      row = byMarket.get(market) ?? {
        baseCollateral: 0n,
        quoteCollateral: 0n,
        positions: 0,
      };
    if (p.debtAsset === 1) row.baseCollateral += amount;
    else row.quoteCollateral += amount;
    row.positions++;
    byMarket.set(market, row);
  }
  return {
    sourceSlot: result.context.slot,
    observedAt,
    complete: true,
    markets: [...byMarket]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([market, row]) => ({
        market,
        ...row,
        baseCollateral: row.baseCollateral.toString(),
        quoteCollateral: row.quoteCollateral.toString(),
      })),
  };
}
export async function captureStatisticsSnapshot(
  dusk: Dusk,
  range: '24h' | 'all',
  deployment: DuskDeploymentEnvelope,
  signal?: AbortSignal,
) {
  const now = Date.now(),
    until = new Date(now).toISOString(),
    maxPriceAgeSeconds = 3600;
  let request = {
    ...(range === '24h'
      ? { since: new Date(now - 86_400_000).toISOString() }
      : {}),
    until,
    maxPriceAgeSeconds,
  };
  const [initial, exposures] = await Promise.all([
    listMarketActivity({
      ...request,
      deployment,
      deploymentIdentitySha256: deployment.deploymentIdentitySha256,
    }),
    captureMarketExposures(dusk, deployment, signal),
  ]);
  let activity = initial;
  const scan = initial.coverage.historyScan;
  if (range === '24h' && scan) {
    const through = Date.parse(scan.throughBlockTime),
      end = through - 1,
      start = end - 86_400_000;
    if (
      through <= now &&
      now - through < 120_000 &&
      start > Date.parse(scan.releaseBlockTime)
    ) {
      request = {
        since: new Date(start).toISOString(),
        until: new Date(end).toISOString(),
        maxPriceAgeSeconds,
      };
      activity = await listMarketActivity({
        ...request,
        deployment,
        deploymentIdentitySha256: deployment.deploymentIdentitySha256,
      });
    }
  }
  signal?.throwIfAborted();
  return {
    schemaVersion: 'dusk-statistics.v1',
    range,
    request,
    activity,
    exposures,
    sourceSlot: Math.max(
      exposures.sourceSlot,
      Number(activity.coverage.lastSourceSlot ?? 0),
      Number(activity.coverage.historyScan?.throughSlot ?? 0),
    ),
  };
}
