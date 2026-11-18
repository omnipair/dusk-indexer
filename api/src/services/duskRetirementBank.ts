/** Preserve RPC rentEpoch's u64 sentinel before JSON number rounding. Account
 * balances and slots must still fit safe integers before entering LiteSVM. */
export function parseRetirementRpcJson(text: string): unknown {
  return JSON.parse(text,(key: string,value: unknown,context?: { source: string }) => {
    if (key !== 'rentEpoch') return value;
    if (!context?.source || !/^(0|[1-9][0-9]*)$/.test(context.source)
      || BigInt(context.source) > (1n<<64n)-1n) throw new Error('Invalid lossless bank rent epoch');
    return context.source;
  });
}
import { PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { sha256, type DuskPinnedProtocol } from '../config/duskProtocol';
import type { FrozenLeverageBank } from './duskLeverageMaximumInput';

/** Separate finalized plain-wallet SOL observations pay VM fees/rent only.
 * Every protocol account, token balance and executable remains in the single
 * economic bank. This is never an atomic cross-observation claim. */
export function assertRetirementWalletObservation(observation:FrozenLeverageBank,bank:FrozenLeverageBank,wallets:readonly string[]):void {
  if(!Number.isSafeInteger(observation.slot)||observation.slot<bank.slot||wallets.length>17
    ||new Set(wallets).size!==wallets.length||observation.accounts.length!==wallets.length
    ||new Set(observation.accounts.map(row=>row.address)).size!==wallets.length)
    throw new Error('Invalid retirement wallet observation');
  const economic=new Set(bank.accounts.map(row=>row.address));
  for(const row of observation.accounts){
    if(!wallets.includes(row.address)||economic.has(row.address))throw new Error('Wallet observation crossed economic bank');
    const account=row.account;
    if(account&&(account.owner!=='11111111111111111111111111111111'||account.executable
      ||Buffer.from(account.data,'base64').length!==0||!Number.isSafeInteger(account.lamports)||account.lamports<0
      ||!/^(0|[1-9][0-9]*)$/.test(account.rentEpoch)||BigInt(account.rentEpoch)>=(1n<<64n)))
      throw new Error('Supplemental observation is not a plain SOL wallet');
  }
}


/** Refuse an authority change or either changed executable even if the IDLs
 * remain compatible. All deployment metadata comes from this same bank. */
export function assertRetirementFrozenBank(bank: FrozenLeverageBank,pin: DuskPinnedProtocol): void {
  if (!Number.isSafeInteger(bank.slot) || bank.slot<=0 || bank.accounts.length>100
    || new Set(bank.accounts.map(row=>row.address)).size!==bank.accounts.length) throw new Error('Invalid retirement bank');
  const rows=new Map(bank.accounts.map(row=>[row.address,row.account]));
  const clock=rows.get(SYSVAR_CLOCK_PUBKEY.toBase58());
  const clockBytes=clock && Buffer.from(clock.data,'base64');
  if (!clock || clock.owner!=='Sysvar1111111111111111111111111111111111111' || clockBytes!.length!==40
    || clockBytes!.readBigUInt64LE(0)!==BigInt(bank.slot)) throw new Error('Retirement bank clock differs');
  for (const expected of [pin.dusk,pin.leverageDelegate]) {
    const program=rows.get(expected.programId),data=rows.get(expected.deployment.programData);
    const loader='BPFLoaderUpgradeab1e11111111111111111111111';
    if(!program || !data || program.owner!==loader || data.owner!==loader || !program.executable || data.executable)
      throw new Error('Invalid retirement executable ownership');
    const programBytes=Buffer.from(program.data,'base64'),dataBytes=Buffer.from(data.data,'base64');
    if(programBytes.length!==36 || programBytes.readUInt32LE(0)!==2
      || new PublicKey(programBytes.subarray(4,36)).toBase58()!==expected.deployment.programData
      || dataBytes.length!==expected.deployment.allocatedBinaryBytes+45 || dataBytes.readUInt32LE(0)!==3
      || dataBytes.readBigUInt64LE(4)!==BigInt(expected.deployment.deploySlot)
      || dataBytes.readBigUInt64LE(4)>BigInt(bank.slot)
      || dataBytes[12]!==1 || new PublicKey(dataBytes.subarray(13,45)).toBase58()!==expected.deployment.upgradeAuthority
      || sha256(dataBytes.subarray(45))!==expected.binarySha256) throw new Error('Retirement executable pin differs');
  }
}
