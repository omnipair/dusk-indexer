import { marketAccountLayout } from '../services/duskProtocolSchema';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BN } from '@coral-xyz/anchor';
import { IdlCoder } from '@coral-xyz/anchor/dist/cjs/coder/borsh/idl';
import { PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { displayFixture, displayKey } from './duskDisplayStateFixtures';
import {
  createLeverageDelegateProgram,
  deriveMarketAddress,
  deriveLeveragePositionAddress,
  deriveLeverageOrderAddress,
} from '../services/virtualBook/native';
import { readDuskOrders } from '../services/duskOrderCapture';
import {
  captureWalletSnapshot,
  walletCaptureDependencies,
} from '../services/duskWalletSnapshot';
import type { AccountInfo } from '@solana/web3.js';
import { hlpCohortAddress } from '../services/duskHlpCohort';

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
  entry.position = f.dusk.get.pda.leveragePosition(marketKey, f.owner, entry.positionId, order)[0];
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
    options: { filters: { memcmp: { bytes: string } }[]; dataSlice?: unknown },
  ) => ({
    context: { slot: 1010 },
    value:
      options.dataSlice ? [{pubkey: marketKey, account: {...marketInfo, data: marketInfo.data.subarray(0,marketAccountLayout().prefixBytes)}}] : options.filters[0].memcmp.bytes ===
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
    lpPerformance: async () => [],
    cashFlows: async () => [],
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
    borrowPositions: async () => ({ positions: [], sourceSlot: 1010 }),
    borrowValuation: walletCaptureDependencies.borrowValuation,
    hlpBalances: async () => ({ balances: [], lpBalances: [], sourceSlot: 1010 }),
    juniorExits: async () => ({ positions: [], sourceSlot: 1010 }),
    hlpPositions: walletCaptureDependencies.hlpPositions,
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

test('an inconsistent RPC Clock retries the complete order batch and never accepts a wrong bank', async () => {
  const f = await fixture();
  const connection = f.dusk.program.provider.connection;
  const original = connection.getMultipleAccountsInfoAndContext;
  let attempts = 0;
  connection.getMultipleAccountsInfoAndContext = (async (keys, options) => {
    const result = await original(keys, options);
    attempts++;
    if (attempts > 2) return result;
    const stale = { ...result.value[0]!, data: Buffer.from(result.value[0]!.data) };
    stale.data.writeBigUInt64LE(1009n);
    return { ...result, value: [stale, ...result.value.slice(1)] };
  }) as typeof connection.getMultipleAccountsInfoAndContext;
  const orders = await readDuskOrders({ dusk: f.dusk, boundary: f.boundary,
    deployment: f.deployment, owner: f.selection.owner, kinds: ['leverageEntryOrder'] });
  assert.equal(orders.entry.length, 1);
  assert.equal(attempts, 3);

  attempts = 0;
  connection.getMultipleAccountsInfoAndContext = (async (keys, options) => {
    const result = await original(keys, options);
    attempts++;
    const stale = { ...result.value[0]!, data: Buffer.from(result.value[0]!.data) };
    stale.data.writeBigUInt64LE(1009n);
    return { ...result, value: [stale, ...result.value.slice(1)] };
  }) as typeof connection.getMultipleAccountsInfoAndContext;
  await assert.rejects(readDuskOrders({ dusk: f.dusk, boundary: f.boundary,
    deployment: f.deployment, owner: f.selection.owner, kinds: ['leverageEntryOrder'] }), /Invalid order Clock/);
  assert.equal(attempts, 3);
});

test('retired hLP orders remain visible and cancellable with a same-bank cohort proof', async () => {
  const f = await fixture();
  const delegate = createLeverageDelegateProgram({ provider: f.dusk.program.provider as Parameters<typeof createLeverageDelegateProgram>[0]['provider'] });
  const market = delegate.coder.accounts.decode('leverageEntryOrder', f.raw.data).market as PublicKey;
  const target = displayKey(84), id = Buffer.alloc(8); id.writeBigUInt64LE(1n);
  const [address,bump] = PublicKey.findProgramAddressSync([Buffer.from('hlp_order'),market.toBuffer(),f.owner.toBuffer(),target.toBuffer(),id],delegate.programId);
  const layout = (name: string, program = delegate) => IdlCoder.typeDefLayout({ typeDef: program.idl.types!.find((type) => type.name === name)!,types: program.idl.types! });
  const order = layout('hlpOrder').decode(Buffer.alloc(32768));
  Object.assign(order,{ market,owner: f.owner,targetHlpMint: target,orderId: new BN(1),kind: 1,status: 0,hlpAmount: new BN(7),bump });
  const orderInfo = { owner: delegate.programId,executable: false,lamports: 1,data: await delegate.coder.accounts.encode('hlpOrder',order) };
  const [cohortAddress,cohortBump] = hlpCohortAddress(market,target,f.dusk.program.programId);
  const cohortLayout = IdlCoder.typeDefLayout({ typeDef: f.dusk.program.idl.types!.find((type) => type.name === 'hlpCohort')!,types: f.dusk.program.idl.types! });
  const cohort = cohortLayout.decode(Buffer.alloc(32768));
  Object.assign(cohort,{ market,mint: target,targetAsset: 0,retired: true,bump: cohortBump });
  const proof = { owner: f.dusk.program.programId,executable: false,lamports: 1,data: await f.dusk.program.coder.accounts.encode('hlpCohort',cohort) };
  f.infos.set(address.toBase58(),orderInfo); f.infos.set(cohortAddress.toBase58(),proof);
  f.dusk.program.provider.connection.getProgramAccounts = (async (_program: PublicKey, options: {dataSlice?: unknown}) => ({ context: { slot: 1010 },value: options.dataSlice
    ? [{pubkey: market,account: {...f.marketInfo,data: f.marketInfo.data.subarray(0,marketAccountLayout().prefixBytes)}}]
    : [{ pubkey: address,account: orderInfo }] })) as unknown as typeof f.dusk.program.provider.connection.getProgramAccounts;
  const capture = () => readDuskOrders({ dusk: f.dusk,boundary: f.boundary,deployment: f.deployment,owner: f.selection.owner,kinds: ['hlpOrder'],previewPayer: f.owner.toBase58() });
  const result = await capture();
  assert.equal(result.hlp.length,1);
  assert.deepEqual(result.hlp[0].retiredHlp,{ targetAsset: 0 });
  assert.equal(result.hlp[0].trigger,null);
  cohort.retired = false; proof.data = await f.dusk.program.coder.accounts.encode('hlpCohort',cohort);
  await assert.rejects(capture(),/retired hLP cohort/);
});

test('order discovery overlaps independent kinds and refreshes every prefetched bank behind the advancing floor',async()=>{
  const f=await fixture(),delegate=createLeverageDelegateProgram({provider:f.dusk.program.provider as any});
  const connection=f.dusk.program.provider.connection,original=connection.getProgramAccounts.bind(connection);
  const names=['leverageOrder','leverageEntryOrder','hlpOrder'] as const,counts=new Map<string,number>(),requests:{name:string;floor:number}[]=[];
  let active=0,peak=0;
  connection.getProgramAccounts=(async(program:PublicKey,config:any)=>{
    if(config.dataSlice)return original(program,config);
    const name=names.find(name=>delegate.coder.accounts.memcmp(name).bytes===config.filters[0].memcmp.bytes)!;
    const count=counts.get(name)??0;counts.set(name,count+1);requests.push({name,floor:config.minContextSlot});
    active++;peak=Math.max(peak,active);await new Promise(resolve=>setImmediate(resolve));active--;
    return {context:{slot:count===0?{leverageOrder:1012,leverageEntryOrder:1010,hlpOrder:1011}[name]:config.minContextSlot+1},value:[]};
  }) as typeof connection.getProgramAccounts;
  const result=await readDuskOrders({dusk:f.dusk,owner:f.selection.owner,deployment:f.deployment,
    boundary:{assertCompatibleForRead:async(_deployment:any,_signal?:AbortSignal,floor=1010)=>({observedSlot:Math.max(1010,floor)})}});
  assert.equal(peak,3);assert.equal(result.slot,1014);
  assert.deepEqual(requests.slice(0,3).map(r=>r.floor),[1010,1010,1010]);
  assert.deepEqual(requests.slice(3),[{name:'leverageEntryOrder',floor:1012},{name:'hlpOrder',floor:1013}]);
});

test('a discovery below its original floor still fails instead of entering the prefetch cache',async()=>{
  const f=await fixture(),connection=f.dusk.program.provider.connection,original=connection.getProgramAccounts.bind(connection);
  connection.getProgramAccounts=(async(program:PublicKey,config:any)=>config.dataSlice?original(program,config):{context:{slot:1009},value:[]}) as typeof connection.getProgramAccounts;
  await assert.rejects(readDuskOrders({dusk:f.dusk,boundary:f.boundary,owner:f.selection.owner,deployment:f.deployment}),/behind confirmed state/);
});

async function exitFixture(debtAssets = [1,1]) {
  const f = await fixture(), delegate = createLeverageDelegateProgram({ provider: f.dusk.program.provider as any });
  const market = deriveMarketAddress(f.market.baseSide.assetMint, f.market.quoteSide.assetMint, f.market.paramsHash)[0];
  const layout = IdlCoder.typeDefLayout({ typeDef: delegate.idl.types!.find(type => type.name === 'leverageOrder')!, types: delegate.idl.types! });
  const orders = await Promise.all(debtAssets.map(async (debtAsset,index) => {
    const id = index + 1, position = { ...f.position, market, debtAsset, positionId:displayKey(100 + index) };
    const [positionKey,positionBump] = deriveLeveragePositionAddress(market,f.owner,position.positionId,position.namespaceAuthority);
    position.bump = positionBump;
    f.infos.set(positionKey.toBase58(),f.encodeAccount('leveragePosition',position));
    const order = layout.decode(Buffer.alloc(16384));
    const [address,bump] = deriveLeverageOrderAddress(positionKey,f.owner,new BN(id),delegate.programId);
    Object.assign(order,{ owner:f.owner,market,position:positionKey,orderId:new BN(id),kind:id % 2 + 1,bump });
    const account = { owner:delegate.programId,executable:false,lamports:1,data:await delegate.coder.accounts.encode('leverageOrder',order) };
    f.infos.set(address.toBase58(),account);
    return { pubkey:address,account };
  }));
  f.dusk.program.provider.connection.getProgramAccounts = (async (_program:PublicKey,config:any) => ({
    context:{slot:1010},value:config.dataSlice ? [{pubkey:market,account:{...f.marketInfo,data:f.marketInfo.data.subarray(0,marketAccountLayout().prefixBytes)}}]
      : config.filters[0].memcmp.bytes === delegate.coder.accounts.memcmp('leverageOrder').bytes ? orders : [],
  })) as unknown as typeof f.dusk.program.provider.connection.getProgramAccounts;
  return { ...f, capture: (exitMark:Parameters<typeof readDuskOrders>[1]) => readDuskOrders({
    dusk:f.dusk,boundary:{assertCompatibleForRead:async(_deployment:any,_signal?:AbortSignal,floor=1010)=>({observedSlot:Math.max(1010,floor)})},deployment:f.deployment,owner:f.selection.owner,kinds:['leverageOrder'],previewPayer:f.owner.toBase58(),
  },exitMark) };
}

test('same-bank TP and SL share one successful exit mark without renewing its age, but each capture reads again',async()=>{
  const f=await exitFixture();let calls=0;
  const dependencies={exitMark:async()=>{calls++;return {slot:1010,observedAt:123,priceNad:42n};}};
  const first=await f.capture(dependencies);
  assert.equal(first.exit.length,2);assert.equal(calls,1);
  assert.deepEqual(first.exit.map(row=>row.exitMark),[{slot:1010,observedAt:123,priceNad:42n},{slot:1010,observedAt:123,priceNad:42n}]);
  assert.notEqual(first.exit[0].exitMark,first.exit[1].exitMark);
  await f.capture(dependencies);assert.equal(calls,2);
});

test('a failed exit mark never suppresses the next order mark or hides either order',async()=>{
  const f=await exitFixture();let calls=0;
  const result=await f.capture({exitMark:async()=>{if(++calls===1)throw Error('temporary RPC failure');return {slot:1010,observedAt:123,priceNad:42n};}});
  assert.equal(calls,2);assert.equal(result.exit.length,2);
  assert.equal(result.exit[0].exitMark,null);assert.equal(result.exit[1].exitMark?.priceNad,42n);
});

test('an intervening newer-bank mark invalidates an older cached exit mark',async()=>{
  const f=await exitFixture([0,1,0]);const reads:number[]=[];
  const result=await f.capture({exitMark:async(_dusk,_market,_native,_asset,_payer,minimumSlot)=>{
    reads.push(minimumSlot);return {slot:reads.length===1?1010:1011,observedAt:123,priceNad:42n};
  }});
  assert.deepEqual(reads,[1010,1010,1011]);assert.equal(result.exit.length,3);
  assert.equal(result.exit[2].exitMark?.slot,1011);assert.equal(result.slot,1011);
});
