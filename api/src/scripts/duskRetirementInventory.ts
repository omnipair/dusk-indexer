/** READ ONLY: no key loading, transaction building, simulation or submission. */
import { BorshCoder, Idl, BN } from '@coral-xyz/anchor';
import { PublicKey, AccountInfo } from '@solana/web3.js';
import { unpackAccount, unpackMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { loadProtocolAt, canonicalJson, sha256 } from '../config/duskProtocol';
import { LEGACY_RETIREMENT, RetirementAccount, RetirementReceipt,
  retirementInventorySummary, retirementObservationHash } from '../services/duskRetirementInventory';

interface RpcAccount { pubkey: string; account: { data: [string,string]; owner: string;
  executable: boolean; lamports: number; rentEpoch: number } }
interface Bank { context: { slot: number }; value: RpcAccount[] }

function plain(value: any): any {
  if (BN.isBN(value)) return value.toString(10);
  if (value instanceof PublicKey) return value.toBase58();
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,plain(v)]));
  return value;
}
function accountInfo(raw: RpcAccount['account']): AccountInfo<Buffer> {
  if (raw.data[1] !== 'base64') throw new Error('Unexpected RPC account encoding');
  return { ...raw, owner: new PublicKey(raw.owner), data: Buffer.from(raw.data[0],'base64') };
}

async function main() {
  const captureStartedAt = new Date().toISOString();
  if (process.argv.length !== 3) throw new Error('Usage: node dist/scripts/duskRetirementInventory.js NEW_OUTPUT_JSON');
  const output = resolve(process.argv[2]);
  const root = resolve(__dirname,'../../../protocol');
  const pin = loadProtocolAt(root);
  if (pin.cluster !== 'mainnet-beta' || pin.revision !== LEGACY_RETIREMENT.revision
    || pin.dusk.programId !== LEGACY_RETIREMENT.program || pin.leverageDelegate.programId !== LEGACY_RETIREMENT.delegate)
    throw new Error('Inventory tool only supports the explicitly pinned legacy mainnet release');
  const rpcUrl = process.env.DUSK_RPC_URL || 'https://api.mainnet-beta.solana.com';
  // Explicit read-only method allowlist; never expose a credential-bearing URL.
  const allowed = new Set(['getGenesisHash','getProgramAccounts','getMultipleAccounts','getTokenAccountsByOwner']);
  async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
    if (!allowed.has(method)) throw new Error('RPC method is not read-only inventory');
    for (let attempt=0;attempt<4;attempt++) {
      const response = await fetch(rpcUrl,{ method:'POST',signal:AbortSignal.timeout(30_000),
        headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}) });
      if (response.status === 429 && attempt < 3) {
        await new Promise(done => setTimeout(done,1000*(attempt+1))); continue;
      }
      if (!response.ok) throw new Error(`Read-only RPC ${method} HTTP ${response.status}`);
      const body = await response.json() as { result: T; error?: { code: number } };
      if (body.error) throw new Error(`Read-only RPC ${method} failed (${body.error.code})`);
      return body.result;
    }
    throw new Error('Read-only RPC rate limit');
  }
  if (await rpc<string>('getGenesisHash') !== pin.genesisHash) throw new Error('RPC genesis differs from mainnet pin');
  const apiResponse = await fetch(`https://api.dusk.omnipair.fi/api/dusk/v1/markets/state/${LEGACY_RETIREMENT.market}`,{
    signal:AbortSignal.timeout(30_000),headers:{Origin:'https://beta.omnipair.fi','User-Agent':'Mozilla/5.0'} });
  if (!apiResponse.ok) throw new Error(`Indexer inventory HTTP ${apiResponse.status}`);
  const indexer = await apiResponse.json() as any;
  if (!indexer.success || indexer.data?.marketAddress !== LEGACY_RETIREMENT.market || indexer.data.version !== 17
    || indexer.deployment?.genesisHash !== pin.genesisHash || indexer.deployment.programId !== pin.dusk.programId
    || indexer.deployment.leverageDelegateProgramId !== pin.leverageDelegate.programId
    || indexer.deployment.idlSha256 !== pin.dusk.idlCanonicalSha256
    || indexer.deployment.leverageDelegateIdlSha256 !== pin.leverageDelegate.idlCanonicalSha256)
    throw new Error('Indexer response differs from the legacy protocol identity');
  if (!Number.isSafeInteger(indexer.deployment.sourceSlot) || indexer.deployment.sourceSlot <= 0)
    throw new Error('Invalid indexer source slot');
  // The indexer is confirmed; its slot may be ahead of the finalized bank.
  // Never pretend both observations share one atomic snapshot.
  let floor = Math.max(pin.dusk.deployment.deploySlot,pin.leverageDelegate.deployment.deploySlot);
  const observations: { method: string; selection: string; slot: number; sha256: string }[] = [];
  function observe(method: string,selection: string,bank: Bank) {
    if (!Number.isSafeInteger(bank.context.slot) || bank.context.slot < floor || bank.value.length > 1000)
      throw new Error('Invalid, stale or oversized inventory response');
    floor = bank.context.slot;
    bank.value.sort((a,b) => a.pubkey.localeCompare(b.pubkey));
    if (new Set(bank.value.map(row => row.pubkey)).size !== bank.value.length) throw new Error('Duplicate RPC account');
    observations.push({method,selection,slot:floor,sha256:retirementObservationHash(bank.value)});
    return bank;
  }
  async function programAccounts(program: string, filters: unknown[] = []) {
    return observe('getProgramAccounts',program+canonicalJson(filters),await rpc<Bank>('getProgramAccounts',[
      program,{ commitment:'finalized',withContext:true,encoding:'base64',minContextSlot:floor,filters } ]));
  }
  const deploymentKeys = [pin.dusk,pin.leverageDelegate].flatMap(program => [program.programId,program.deployment.programData]);
  const deploymentBank = await rpc<{context:{slot:number};value:(RpcAccount['account']|null)[]}>('getMultipleAccounts',[
    deploymentKeys,{commitment:'finalized',encoding:'base64',minContextSlot:floor}]);
  if (!Number.isSafeInteger(deploymentBank.context.slot) || deploymentBank.context.slot < floor || deploymentBank.value.length !== 4)
    throw new Error('Invalid deployment bank');
  floor = deploymentBank.context.slot;
  for (let i=0;i<2;i++) {
    const pinProgram = [pin.dusk,pin.leverageDelegate][i];
    const program = deploymentBank.value[2*i], data = deploymentBank.value[2*i+1];
    const loader = 'BPFLoaderUpgradeab1e11111111111111111111111';
    if (!program || !data || program.owner !== loader || data.owner !== loader || !program.executable || data.executable)
      throw new Error('Invalid deployed program accounts');
    const programBytes = accountInfo(program).data, dataBytes = accountInfo(data).data;
    if (programBytes.length !== 36 || programBytes.readUInt32LE(0) !== 2
      || new PublicKey(programBytes.subarray(4,36)).toBase58() !== pinProgram.deployment.programData
      || dataBytes.length !== pinProgram.deployment.allocatedBinaryBytes+45 || dataBytes.readUInt32LE(0) !== 3
      || dataBytes.readBigUInt64LE(4) !== BigInt(pinProgram.deployment.deploySlot)
      || dataBytes[12] !== 1 || new PublicKey(dataBytes.subarray(13,45)).toBase58() !== pinProgram.deployment.upgradeAuthority
      || sha256(dataBytes.subarray(45)) !== pinProgram.binarySha256)
      throw new Error('Deployed program bytes, slot or authority differ from legacy pin');
  }
  const programs = [];
  const decoded: RetirementAccount[] = [];
  const ancillary: { address: string; program: string; data: string; kind?: string }[] = [];
  for (const [p,file] of [[pin.dusk,'dusk.json'],[pin.leverageDelegate,'leverage_delegate.json']] as const) {
    const idl = JSON.parse(readFileSync(resolve(root,'idl',file),'utf8')) as Idl;
    const coder = new BorshCoder(idl);
    const bank = await programAccounts(p.programId);
    for (const row of bank.value) {
      if (row.account.owner !== p.programId || row.account.executable) throw new Error('Invalid program account ownership');
      const data = accountInfo(row.account).data;
      const type = idl.accounts?.find(type => data.subarray(0,8).equals(Buffer.from(type.discriminator)));
      if (!type) ancillary.push({address:row.pubkey,program:p.programId,data:row.account.data[0]});
      else decoded.push({address:row.pubkey,kind:type.name,state:plain(coder.accounts.decode(type.name,data))});
    }
    programs.push({program:p.programId,...bank});
  }
  const market = decoded.find(account => account.kind === 'Market' && account.address === LEGACY_RETIREMENT.market)?.state;
  if (!market || market.version !== 17) throw new Error('Legacy market missing or changed layout');
  if (market.base_side.asset_mint !== indexer.data.baseMint || market.quote_side.asset_mint !== indexer.data.quoteMint)
    throw new Error('Indexer token pair differs from finalized market');
  const receiptMints = [...new Set<string>([market.srlp_mint,market.junior_mint,market.base_side.hlp_mint,market.quote_side.hlp_mint,
    ...decoded.filter(account => /^(HlpCohort|JuniorCohort)$/.test(account.kind)).map(account => account.state.mint)])].sort();
  if (receiptMints.length > 32) throw new Error('Retirement scope exceeds one-off mint bound');
  const idlAccounts = new Set<string>();
  for (const program of [pin.dusk.programId,pin.leverageDelegate.programId]) {
    const key = new PublicKey(program);
    const base = PublicKey.findProgramAddressSync([],key)[0];
    idlAccounts.add((await PublicKey.createWithSeed(base,'anchor:idl',key)).toBase58());
  }
  const hooks = new Set(receiptMints.map(mint => PublicKey.findProgramAddressSync([
    Buffer.from('extra-account-metas'),new PublicKey(mint).toBuffer()],new PublicKey(pin.dusk.programId))[0].toBase58()));
  for (const account of ancillary) account.kind = idlAccounts.has(account.address) ? 'Anchor IDL'
    : account.program === pin.dusk.programId && hooks.has(account.address) ? 'LP transfer-hook validation' : 'unclassified';
  const allMints = [...receiptMints,market.base_side.asset_mint,market.quote_side.asset_mint];
  const mintBank = await rpc<{context:{slot:number};value:(RpcAccount['account']|null)[]}>('getMultipleAccounts',[
    allMints,{commitment:'finalized',encoding:'base64',minContextSlot:floor}]);
  if (!Number.isSafeInteger(mintBank.context.slot) || mintBank.context.slot < floor || mintBank.value.length !== allMints.length)
    throw new Error('Invalid receipt mint bank');
  floor = mintBank.context.slot;
  const receipts: RetirementReceipt[] = [];
  const tokenBanks: { program: string; mint: string; bank: Bank }[] = [];
  for (let i=0;i<receiptMints.length;i++) {
    const mint = receiptMints[i], raw = mintBank.value[i];
    if (!raw || ![TOKEN_PROGRAM_ID.toBase58(),TOKEN_2022_PROGRAM_ID.toBase58()].includes(raw.owner)) throw new Error('Invalid receipt mint owner');
    const info = unpackMint(new PublicKey(mint),accountInfo(raw),new PublicKey(raw.owner));
    const bank = await programAccounts(raw.owner,[{memcmp:{offset:0,bytes:mint}}]);
    const accounts = bank.value.map(row => {
      if (row.account.executable || row.account.owner !== raw.owner) throw new Error('Invalid receipt token program');
      const token = unpackAccount(new PublicKey(row.pubkey),accountInfo(row.account),new PublicKey(raw.owner));
      if (!token.mint.equals(new PublicKey(mint))) throw new Error('Receipt token mint differs');
      return {address:row.pubkey,owner:token.owner.toBase58(),amount:token.amount.toString(),frozen:token.isFrozen};
    });
    receipts.push({mint,supply:info.supply.toString(),accounts});
    tokenBanks.push({program:raw.owner,mint,bank});
  }
  const custody = [];
  const custodyAuthorities = [LEGACY_RETIREMENT.market,...decoded.filter(account => /Order$/.test(account.kind)).map(account => account.address)];
  for (const authority of custodyAuthorities) for (const program of [TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID]) {
    const bank = observe('getTokenAccountsByOwner',authority+program.toBase58(),await rpc<Bank>('getTokenAccountsByOwner',[
      authority,{programId:program.toBase58()},{commitment:'finalized',encoding:'base64',minContextSlot:floor}]));
    const balances = bank.value.map(row => {
      if (row.account.owner !== program.toBase58() || row.account.executable) throw new Error('Invalid custody token program');
      const token = unpackAccount(new PublicKey(row.pubkey),accountInfo(row.account),program);
      if (token.owner.toBase58() !== authority) throw new Error('Custody token account crossed authority');
      return {address:row.pubkey,mint:token.mint.toBase58(),amount:token.amount.toString(),frozen:token.isFrozen};
    });
    custody.push({authority,program:program.toBase58(),balances,bank});
  }
  const summary = retirementInventorySummary(decoded,receipts);
  if (ancillary.some(account => account.kind === 'unclassified')) summary.blockers.push('unclassified-program-owned-accounts');
  // Retain every unknown byte for review. These include IDLs and transfer-hook
  // validation accounts; unknown bytes never silently count as paid/empty.
  const inventory = { schemaVersion:'dusk-legacy-retirement-inventory.v1',captureStartedAt,observedAt:new Date().toISOString(),
    readOnly:true,atomicSnapshot:false,commitment:'finalized',
    identity:{cluster:pin.cluster,genesisHash:pin.genesisHash,revision:pin.revision,
      dusk:pin.dusk,delegate:pin.leverageDelegate},
    slotRange:{from:Math.min(deploymentBank.context.slot,...observations.map(row => row.slot)),through:floor},observations,
    indexer,summary,decoded,ancillary,programs,deploymentBank,mints:{addresses:allMints,...mintBank},tokenBanks,custody };
  const encoded = JSON.stringify({ ...inventory,contentSha256:retirementObservationHash(inventory) },null,2)+'\n';
  // Refuse overwriting evidence. A fresh capture gets a new explicit path.
  writeFileSync(output,encoded,{flag:'wx',mode:0o600});
  console.log(JSON.stringify({output,contentSha256:sha256(canonicalJson(inventory)),
    owners:summary.owners,leverage:summary.openLeveragePositions,borrow:summary.openBorrowPositions,
    receiptHolders:summary.receiptHolders.length,settlementReady:false},null,2));
}

if (require.main === module) main().catch(() => {
  // RPC libraries can embed credential-bearing URLs in errors. Keep them out
  // of CLI output; incomplete captures never produce a successful artifact.
  console.error('Retirement inventory failed; no payout or transaction was attempted. Check RPC availability and pinned legacy identity.');
  process.exitCode = 1;
});
