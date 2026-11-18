import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { loadPinnedProtocol, sha256 } from '../config/duskProtocol';
import { assertRetirementFrozenBank, assertRetirementWalletObservation } from '../services/duskRetirementBank';
import type { FrozenLeverageBank } from '../services/duskLeverageMaximumInput';

function fixture() {
  // Synthetic executable payloads test metadata binding; they are not SBFs or
  // deployment evidence. Actual execution is separately rehearsed on mainnet bytes.
  const payload=Buffer.from([127,69,76,70]),pin=structuredClone(loadPinnedProtocol());
  const bank:FrozenLeverageBank={slot:101,accounts:[]};
  for(const program of [pin.dusk,pin.leverageDelegate]) {
    Object.assign(program,{binarySha256:sha256(payload),deployment:{...program.deployment,allocatedBinaryBytes:4,deploySlot:100}});
    const executable=Buffer.alloc(36);executable.writeUInt32LE(2);new PublicKey(program.deployment.programData).toBuffer().copy(executable,4);
    const data=Buffer.alloc(49);data.writeUInt32LE(3);data.writeBigUInt64LE(100n,4);data[12]=1;
    new PublicKey(program.deployment.upgradeAuthority!).toBuffer().copy(data,13);payload.copy(data,45);
    for(const [key,bytes,exec] of [[program.programId,executable,true],[program.deployment.programData,data,false]] as const)
      bank.accounts.push({address:key,account:{data:bytes.toString('base64'),owner:'BPFLoaderUpgradeab1e11111111111111111111111',
        executable:exec,lamports:100,rentEpoch:'18446744073709551615'}});
  }
  const clock=Buffer.alloc(40);clock.writeBigUInt64LE(101n);
  bank.accounts.push({address:SYSVAR_CLOCK_PUBKEY.toBase58(),account:{data:clock.toString('base64'),owner:'Sysvar1111111111111111111111111111111111111',
    executable:false,lamports:1,rentEpoch:'18446744073709551615'}});
  return {pin,bank};
}

test('both exact program deployments and the bank clock are required',()=>{
  const {pin,bank}=fixture();assert.doesNotThrow(()=>assertRetirementFrozenBank(bank,pin));
  bank.accounts.pop();assert.throws(()=>assertRetirementFrozenBank(bank,pin),/clock/);
});
test('either binary, authority, upgrade slot or program-data pointer change aborts rehearsal',()=>{
  for(const program of ['dusk','leverageDelegate'] as const) for(const offset of [4,13,45]) {
    const {pin,bank}=fixture(),row=bank.accounts.find(row=>row.address===pin[program].deployment.programData)!;
    const bytes=Buffer.from(row.account!.data,'base64');bytes[offset]^=1;row.account!.data=bytes.toString('base64');
    assert.throws(()=>assertRetirementFrozenBank(bank,pin),/pin differs/);
  }
  const {pin,bank}=fixture();bank.accounts[0].account!.data=Buffer.alloc(36).toString('base64');
  assert.throws(()=>assertRetirementFrozenBank(bank,pin),/pin differs/);
});
test('mixed-bank clock, duplicate addresses or wrong loader cannot be treated as a coherent bank',()=>{
  const first=fixture();first.bank.slot++;assert.throws(()=>assertRetirementFrozenBank(first.bank,first.pin),/clock/);
  const second=fixture();second.bank.accounts.push(second.bank.accounts[0]);assert.throws(()=>assertRetirementFrozenBank(second.bank,second.pin),/Invalid retirement bank/);
  const third=fixture();third.bank.accounts[0].account!.owner=PublicKey.default.toBase58();
  assert.throws(()=>assertRetirementFrozenBank(third.bank,third.pin),/ownership/);
});

test('separate wallet SOL observations preserve the economic-bank bound and reject token/program state',()=>{
  const {bank}=fixture(),wallet=PublicKey.default.toBase58();
  const observation:FrozenLeverageBank={slot:bank.slot+1,accounts:[{address:wallet,account:{owner:wallet,data:'',executable:false,lamports:100,rentEpoch:'0'}}]};
  assert.doesNotThrow(()=>assertRetirementWalletObservation(observation,bank,[wallet]));
  for(const changed of [{owner:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'},{data:Buffer.alloc(165).toString('base64')},
    {executable:true},{lamports:Number.MAX_SAFE_INTEGER+1}]){
    const copy=structuredClone(observation);Object.assign(copy.accounts[0].account!,changed);
    assert.throws(()=>assertRetirementWalletObservation(copy,bank,[wallet]),/plain SOL wallet/);
  }
  assert.throws(()=>assertRetirementWalletObservation({...observation,slot:bank.slot-1},bank,[wallet]),/Invalid/);
  assert.throws(()=>assertRetirementWalletObservation(observation,bank,[bank.accounts[0].address]),/crossed/);
  const overlap=structuredClone(bank);overlap.accounts.push(observation.accounts[0]);
  assert.throws(()=>assertRetirementWalletObservation(observation,overlap,[wallet]),/crossed/);
});
