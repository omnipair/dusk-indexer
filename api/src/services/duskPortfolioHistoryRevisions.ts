/** Verified historical identities for stored portfolio reads only.
 * Captures, replay, quotes and signing continue to use the active pin.
 */
import { existsSync,readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalJson,loadPinnedProtocol,loadProtocolAt,sha256 } from '../config/duskProtocol';
import type { DuskPinnedProtocol } from '../config/duskProtocol';

export const portfolioRevisionIdentity=(pin:DuskPinnedProtocol)=>[
  pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision,
];

export function checkedPortfolioHistoryRevisions(active:DuskPinnedProtocol,revisions:readonly DuskPinnedProtocol[]) {
  if(!revisions.length||revisions.length>17)throw new Error('Invalid bounded portfolio history revisions');
  const unique=new Map<string,DuskPinnedProtocol>();
  for(const pin of revisions){
    if(pin.cluster!==active.cluster||pin.genesisHash!==active.genesisHash||pin.dusk.programId!==active.dusk.programId
      ||pin.leverageDelegate.programId!==active.leverageDelegate.programId)
      throw new Error('Archived portfolio network or program differs');
    const key=canonicalJson(portfolioRevisionIdentity(pin)),previous=unique.get(key);
    if(key===canonicalJson(portfolioRevisionIdentity(active))&&canonicalJson(pin)!==canonicalJson(active))
      throw new Error('Conflicting active portfolio history pin');
    if(previous&&canonicalJson(previous)!==canonicalJson(pin))throw new Error('Conflicting portfolio history pins');
    unique.set(key,pin);
  }
  if(!unique.has(canonicalJson(portfolioRevisionIdentity(active))))throw new Error('Portfolio history omitted the active identity');
  return [...unique.values()];
}

/** Only explicitly registered, byte-verified archives are eligible. Directory
 * names and network/program identifiers are never accepted from an HTTP query. */
export function readPortfolioHistoryRevisions(root:string,active:DuskPinnedProtocol):readonly DuskPinnedProtocol[] {
  const path=resolve(root,'history-revisions.json');
  if(!existsSync(path))return [active];
  const registry=JSON.parse(readFileSync(path,'utf8')) as {schemaVersion?:unknown;releases?:unknown};
  if(registry.schemaVersion!=='dusk-history-revisions.v1'||!Array.isArray(registry.releases)||registry.releases.length>16)
    throw new Error('Invalid portfolio history revision registry');
  const pins:DuskPinnedProtocol[]=[active];
  for(const entry of registry.releases){
    if(!entry||typeof entry!=='object'||typeof entry.revision!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(entry.revision)
      ||typeof entry.lockSha256!=='string'||!/^[0-9a-f]{64}$/.test(entry.lockSha256))
      throw new Error('Invalid archived portfolio release reference');
    const archive=resolve(root,'archive',entry.revision),bytes=readFileSync(resolve(archive,'protocol.lock.json'));
    if(sha256(bytes)!==entry.lockSha256)throw new Error('Archived portfolio lock hash differs');
    const pin=loadProtocolAt(archive);
    if(pin.revision!==entry.revision)throw new Error('Archived portfolio revision differs');
    pins.push(pin);
  }
  return checkedPortfolioHistoryRevisions(active,pins);
}

let cached:{key:string;pins:readonly DuskPinnedProtocol[]}|undefined;
export function portfolioHistoryRevisions():readonly DuskPinnedProtocol[] {
  const root=process.env.DUSK_PROTOCOL_DIR?.trim()||resolve(__dirname,'../../../protocol');
  const active=loadPinnedProtocol(),path=resolve(root,'history-revisions.json');
  const key=canonicalJson([resolve(root),active,existsSync(path)?sha256(readFileSync(path)):null]);
  if(cached?.key!==key)cached={key,pins:readPortfolioHistoryRevisions(root,active)};
  return cached.pins;
}
