import { BorshCoder } from '@coral-xyz/anchor';
import { canonicalJson, loadPinnedProtocol, sha256 } from '../config/duskProtocol';
import { BirdeyeHistoricalPricePoint } from './birdeyePriceService';
import { duskRawIdl } from './duskMarketSimulation';
import { PortfolioCaptureSource, projectPortfolioSource } from './duskPortfolioSnapshots';
import { portfolioDisplayPrices, totalPortfolioComponents, valuePortfolioBalances } from './duskPortfolioMath';
import { positiveDecimal } from './duskPriceMath';

export const PORTFOLIO_REPAIR_POLICY = 'birdeye-minute.v1';
export const HISTORICAL_PRICE_MATURITY_MS = 120_000;
export const HISTORICAL_PRICE_WINDOW_MS = 6*60*60*1000;
export const historicalIdentity = () => {
  const pin = loadPinnedProtocol();
  return [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision];
};
export interface HistoricalPoint {
  pointId: string; mint: string; sourceTime: string; fetchedAt: string; priceUsd: string;
  evidence: { provider: 'birdeye'; endpoint: '/defi/history_price'; resolution: '1m'; amountMode: 'raw';
    mint: string; from: string; until: string; unixTime: number; priceUsd: string };
  contentHash: string;
}
/** Preserve the provider JSON number as a decimal; accounting remains integer based. */
function decimal(value: number) {
  if (!Number.isFinite(value) || value<=0) throw new Error('Invalid historical USD price');
  const [digits,exponent = '0'] = String(value).toLowerCase().split('e'),[whole,fraction = ''] = digits.split('.');
  const at = whole.length+Number(exponent),all = whole+fraction;
  return positiveDecimal(at<=0 ? `0.${'0'.repeat(-at)}${all}`
    : at>=all.length ? all+'0'.repeat(at-all.length) : `${all.slice(0,at)}.${all.slice(at)}`);
}
export function historicalPointHash(evidence: HistoricalPoint['evidence']) {
  return sha256(canonicalJson([historicalIdentity(),evidence]));
}
export function normalizeHistoricalPoints(mint: string,from: Date,until: Date,fetchedAt: Date,points: BirdeyeHistoricalPricePoint[]): HistoricalPoint[] {
  const start = from.getTime(),end = until.getTime(),fetched = fetchedAt.getTime();
  if (![start,end,fetched].every(Number.isFinite) || start>end || end-start>HISTORICAL_PRICE_WINDOW_MS
    || end>fetched-HISTORICAL_PRICE_MATURITY_MS || points.length>1000) throw new Error('Invalid bounded historical price window');
  const byTime = new Map<number,HistoricalPoint>();
  for (const point of points) {
    const time = point.timestamp.getTime();
    if (point.mint !== mint || point.provider !== 'birdeye' || !Number.isSafeInteger(time) || time%60_000 !== 0
      || time<start || time>end || time>fetched-HISTORICAL_PRICE_MATURITY_MS) throw new Error('Historical provider returned a different mint or time window');
    const priceUsd = decimal(point.priceUsd);
    const evidence: HistoricalPoint['evidence'] = { provider: 'birdeye',endpoint: '/defi/history_price',resolution: '1m',amountMode: 'raw',
      mint,from: from.toISOString(),until: until.toISOString(),unixTime: time/1000,priceUsd };
    if (byTime.has(time) && byTime.get(time)!.priceUsd !== priceUsd) throw new Error('Conflicting historical provider prices');
    byTime.set(time,{ pointId: '0',mint,sourceTime: point.timestamp.toISOString(),fetchedAt: fetchedAt.toISOString(),priceUsd,
      evidence,contentHash: historicalPointHash(evidence) });
  }
  return [...byTime.values()].sort((a,b) => a.sourceTime.localeCompare(b.sourceTime));
}
export function validateHistoricalPoint(point: HistoricalPoint) {
  const evidence = point.evidence,sourceTime = Date.parse(point.sourceTime),fetchedAt = Date.parse(point.fetchedAt);
  if (!/^\d+$/.test(point.pointId) || !Number.isFinite(sourceTime) || sourceTime%60_000 !== 0
    || !Number.isFinite(fetchedAt) || fetchedAt-sourceTime<HISTORICAL_PRICE_MATURITY_MS
    || evidence.provider !== 'birdeye' || evidence.endpoint !== '/defi/history_price'
    || evidence.resolution !== '1m' || evidence.amountMode !== 'raw' || evidence.mint !== point.mint
    || evidence.unixTime*1000 !== sourceTime || evidence.priceUsd !== point.priceUsd
    || !Number.isFinite(Date.parse(evidence.from)) || !Number.isFinite(Date.parse(evidence.until))
    || Date.parse(evidence.from)>sourceTime || Date.parse(evidence.until)<sourceTime
    || Date.parse(evidence.until)-Date.parse(evidence.from)>HISTORICAL_PRICE_WINDOW_MS
    || Date.parse(evidence.until)>fetchedAt-HISTORICAL_PRICE_MATURITY_MS
    || historicalPointHash(evidence) !== point.contentHash) throw new Error('FINALIZED_INVARIANT: historical price evidence/hash mismatch');
  positiveDecimal(point.priceUsd);
  return point;
}
export function historicalPriceAt(points: HistoricalPoint[],mint: string,at: string) {
  const target = Date.parse(at);
  if (!Number.isFinite(target)) throw new Error('Invalid historical valuation time');
  return points.filter(point => point.mint === mint && Date.parse(point.sourceTime)<=target
    && target-Date.parse(point.sourceTime)<60_000).sort((a,b) => b.sourceTime.localeCompare(a.sourceTime))[0];
}

/** Revalue only missing USD legs. Account bytes, quantities, debts and policy
 * prices come from the original capture; late prices have separate provenance. */
export function reconstructPortfolioPrices(source: PortfolioCaptureSource,points: HistoricalPoint[]) {
  points.forEach(validateHistoricalPoint);
  const pin = loadPinnedProtocol(),original = projectPortfolioSource(source),coder = new BorshCoder(duskRawIdl());
  const pricesByGroup = source.groups.map(group => ({ group,prices: portfolioDisplayPrices({ pin,marketAddress: group.market,
    market: coder.accounts.decode('Market',Buffer.from(group.marketAccount.data,'base64')),
    preview: group.preview === null ? null : coder.types.decode('MarketPreview',Buffer.from(group.preview,'base64')),
    slot: group.slot,blockTime: group.blockTime,references: source.references,displayPriceObservations: group.displayPriceObservations,
    deploymentIdentitySha256: group.deploymentIdentitySha256 }) }));
  return original.owners.map(owner => {
    const priceEvidence: { component: string; mint: string; pointId: string; sourceTime: string; fetchedAt: string; contentHash: string }[] = [];
    const components = owner.components.map(component => {
      if (component.valuation.netUsd !== null || !component.issues.includes('missing-price-reference')
        || component.issues.includes('market-preview-unavailable')) return component;
      const context = pricesByGroup.find(({group}) => group.market === component.market && group.slot.toString() === component.sourceSlot
        && group.accounts.some(entry => entry.address === component.address));
      if (!context?.prices) return component;
      const extra = component.valuation.missingMints.flatMap(mint => {
        const point = historicalPriceAt(points,mint,component.sourceTime),balance = component.balances.find(balance => balance.mint === mint);
        if (!point || !balance) return [];
        priceEvidence.push({ component: component.address,mint,pointId: point.pointId,sourceTime: point.sourceTime,
          fetchedAt: point.fetchedAt,contentHash: point.contentHash });
        return [{ mint,decimals: balance.decimals,priceUsd: point.priceUsd,quality: 'historical-provider' }];
      });
      const valuation = valuePortfolioBalances(component.balances,[...context.prices,...extra]);
      return { ...component,valuation,issues: valuation.missingMints.length ? component.issues
        : component.issues.filter(issue => issue !== 'missing-price-reference') };
    });
    return { owner: owner.owner,components,valuations: totalPortfolioComponents(components),priceEvidence };
  });
}
