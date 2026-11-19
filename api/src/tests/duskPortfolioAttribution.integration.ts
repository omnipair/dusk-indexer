import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import { BN,BorshCoder } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { deriveYieldAccountAddress } from '@omnipair/dusk-sdk';
import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { duskRawIdl } from '../services/duskMarketSimulation';
import { marketLayoutVersion } from '../services/duskProtocolSchema';
import { readPortfolioAttribution } from '../services/duskPortfolioAttribution';
import { projectPortfolioCapture,storePortfolioCapture } from '../services/duskPortfolioSnapshots';
import { incomeAddresses } from '../services/duskPortfolioIncome';
import type { PortfolioIncomeItem } from '../services/duskPortfolioIncome';
import { portfolioFixture } from './duskPortfolioFixtures';
import { encodeFixtureAccount,encodeFixtureType,Q64 } from './duskYieldCheckpointFixtures';
import { streamedEvent,streamedIdentity } from './duskStreamedFixtures';

if(process.env.DUSK_ALLOW_DISPOSABLE_DB_TESTS!=='true'||!process.env.DATABASE_URL)throw new Error('Disposable database opt-in required');
after(()=>pool.end());
test('saved capture income, canonical claims and accrued interest reconcile without current RPC or prices',async()=>{
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await client.query(`INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,streamedIdentity);
    const start=portfolioFixture(),end=portfolioFixture({slot:910_000_011});
    const coder=new BorshCoder(duskRawIdl());
    for(const [fixture,after] of [[start,false],[end,true]] as const){
      const source=fixture.source,group=source.groups[0],market=coder.accounts.decode('Market',Buffer.from(group.marketAccount.data,'base64')) as any;
      market.version=marketLayoutVersion();
      market.debt.base_borrow_index_nad=new BN(after?'1200000000':'1100000000');
      for(const side of ['base','quote']){
        market[`${side}_side`].fees.swap_fee_growth_index_q64=new BN(after&&side==='base'?(400003n*Q64).toString():0);
        market[`${side}_side`].fees.interest_growth_index_q64=new BN(after&&side==='base'?(100002n*Q64).toString():0);
        // This scenario has no hLP earnings. A true zero start anchor must
        // clear those fixture lane indexes as well as the srLP indexes.
        for(const vault of ['base_hlp_vault','quote_hlp_vault'])for(const index of ['swap_fee_growth_index_q64','interest_growth_index_q64'])
          market[vault][`${side}_${index}`]=new BN(0);
      }
      group.marketAccount.data=encodeFixtureAccount('Market',market).toString('base64');
      const preview=coder.types.decode('MarketPreview',Buffer.from(group.preview!,'base64')) as any;
      preview.base.borrow_index_nad=market.debt.base_borrow_index_nad;
      group.preview=encodeFixtureType('MarketPreview',preview).toString('base64');
      const position=group.accounts[0].account!,state=coder.accounts.decode('BorrowPosition',Buffer.from(position.data,'base64')) as any;
      state.fixed_base_principal=new BN(200_000_000);position.data=encodeFixtureAccount('BorrowPosition',state).toString('base64');
      if(after){
        group.blockTime='2026-09-02T00:01:00.000Z';group.observedAt='2026-09-02T00:01:05.000Z';
        source.observedAt=group.observedAt;source.catalog.streamTime=group.blockTime;
        source.schemaVersion='dusk-portfolio-capture.v3';
        const item:PortfolioIncomeItem={address:fixture.tokenAddress,holder:fixture.owner,owner:fixture.owner,market:group.market,
          lpMint:market.srlp_mint.toBase58(),kind:'srlp',baseMint:market.base_side.asset_mint.toBase58(),quoteMint:market.quote_side.asset_mint.toBase58()};
        const addresses=incomeAddresses(item);
        source.catalog.incomeItems=[item];
        const [,bump]=deriveYieldAccountAddress(new PublicKey(item.market),new PublicKey(item.owner),new PublicKey(item.lpMint),new PublicKey(item.baseMint),'srlp',new PublicKey(loadPinnedProtocol().dusk.programId));
        const yieldAccount=encodeFixtureAccount('YieldAccount',{owner:new PublicKey(item.owner),market:new PublicKey(item.market),
          lp_mint:new PublicKey(item.lpMint),asset_mint:new PublicKey(item.baseMint),token_kind:0,recipient:new PublicKey(item.owner),bump,
          swap_fee_checkpoint_q64:new BN((400000n*Q64).toString()),interest_checkpoint_q64:new BN((100000n*Q64).toString())});
        group.incomeEvidence={items:[item],accounts:[
          {address:addresses[1],account:{owner:loadPinnedProtocol().dusk.programId,executable:false,data:yieldAccount.toString('base64')}},
          {address:addresses[2],account:null}]};
      }
    }
    const first=await storePortfolioCapture(client,start.source);await projectPortfolioCapture(client,first);
    const last=await storePortfolioCapture(client,end.source);await projectPortfolioCapture(client,last);
    const market=end.source.groups[0].market,base=end.source.catalog.incomeItems![0].baseMint;
    await streamedEvent(client,'MarketDebtUpdated',{market,owner:start.owner,position:start.position},910_000_002);
    await streamedEvent(client,'YieldClaimed',{market,owner:start.owner,lp_mint:end.source.catalog.incomeItems![0].lpMint,asset_mint:base,
      swap_fee_amount:'40000000',interest_amount:'10000000'},910_000_003);
    await streamedEvent(client,'BorrowInterestPaid',{market,position:start.position,asset_mint:base,interest_paid:'10000000'},910_000_004);
    const result=await readPortfolioAttribution(client,{owner:start.owner,startCaptureId:first,endCaptureId:last});
    assert.equal(result.totals.earnedUsd,'0.12500125');
    assert.equal(result.totals.borrowingCostUsd,'0.075');
    assert.equal(result.totals.changeUsd,'-0.05');
    assert.equal(result.totals.remainingUsd,'-0.10000125');
    assert.equal(result.coverage.paymentKeys.length,2);
    const identity=await readPortfolioAttribution(client,{owner:start.owner,startCaptureId:last,endCaptureId:last});
    assert.equal(identity.totals.earnedUsd,'0');assert.equal(identity.totals.borrowingCostUsd,'0');
    await assert.rejects(()=>readPortfolioAttribution(client,{owner:PublicKey.default.toBase58(),startCaptureId:first,endCaptureId:last}),/unavailable for this owner/);
    await assert.rejects(()=>readPortfolioAttribution(client,{owner:start.owner,startCaptureId:last,endCaptureId:first}),/start follows/);
  }finally{await client.query('ROLLBACK');client.release();}
});
