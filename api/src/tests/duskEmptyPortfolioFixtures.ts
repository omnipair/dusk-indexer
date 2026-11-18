import { loadPinnedProtocol,loadCurrentProtocol } from '../config/duskProtocol';
import { duskRawIdl } from '../services/duskMarketSimulation';
import type { EmptyMarketEvidence } from '../services/duskEmptyPortfolio';
import type { PortfolioCaptureSource } from '../services/duskPortfolioSnapshots';
import { portfolioFixture } from './duskPortfolioFixtures';
import { fixtureKey } from './duskYieldCheckpointFixtures';

export function emptyPortfolioFixture():PortfolioCaptureSource{
  const source=portfolioFixture().source,pin=loadPinnedProtocol(),current=loadCurrentProtocol(),slot=source.groups[0].slot;
  const evidence:EmptyMarketEvidence={schemaVersion:'dusk-market-catalog-observation.v1',commitment:'finalized',cluster:pin.cluster,
    genesisHash:pin.genesisHash,programId:pin.dusk.programId,idlHash:pin.dusk.idlCanonicalSha256,protocolRevision:pin.revision,
    slot,blockhash:fixtureKey(233).toBase58(),blockTime:source.groups[0].blockTime,observedAt:source.observedAt,
    marketDiscriminator:[...duskRawIdl().accounts!.find(row=>row.name==='Market')!.discriminator!],markets:[],
    deploymentIdentitySha256:source.deploymentIdentitySha256,deployments:[current.dusk,current.leverageDelegate].map(program=>({
      programId:program.programId,programData:program.deployment.programData,deploySlot:program.deployment.deploySlot,
      authority:program.deployment.upgradeAuthority,binarySha256:program.binarySha256,idlSha256:program.idlCanonicalSha256,
      allocatedBinaryBytes:program.deployment.allocatedBinaryBytes}))};
  return {...source,schemaVersion:'dusk-portfolio-capture.v4',groups:[],emptyCatalog:{observationId:'1',evidence},
    catalog:{basis:'rpc-empty-markets.v1',markets:[],items:[],incomeItems:[],knownOwners:source.catalog.knownOwners,
      throughSlot:slot,sourceFloor:slot,streamTime:source.observedAt}};
}
