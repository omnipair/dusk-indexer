import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { observeMarketInstruction } from '../services/duskMarketCrank';
import { fixtureKey } from './duskYieldCheckpointFixtures';

test('observe_market names the market, its yLP mint, both hLP yLP vaults and the event authority',() => {
  const program = new PublicKey(loadPinnedProtocol().dusk.programId);
  const [market,ylp,baseHlp,quoteHlp] = [1,2,3,4].map((byte) => fixtureKey(byte));
  const instruction = observeMarketInstruction({ market: market.toBase58(),ylpMint: ylp.toBase58(),
    baseHlpMint: baseHlp.toBase58(),quoteHlpMint: quoteHlp.toBase58(),observedAt: null });
  const vault = (hlp: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('hlp_ylp_vault'),market.toBuffer(),hlp.toBuffer(),ylp.toBuffer()],program)[0];
  const [authority] = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')],program);
  assert.ok(instruction.programId.equals(program));
  assert.deepEqual([...instruction.data],[165,112,165,82,197,36,150,191]);
  assert.deepEqual(instruction.keys.map((key) => [key.pubkey.toBase58(),key.isSigner,key.isWritable]),[
    [market.toBase58(),false,true],[ylp.toBase58(),false,false],[vault(baseHlp).toBase58(),false,false],
    [vault(quoteHlp).toBase58(),false,false],[authority.toBase58(),false,false],[program.toBase58(),false,false]]);
});
