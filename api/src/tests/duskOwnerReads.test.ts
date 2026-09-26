import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCOUNT_SIZE,
  AccountType,
  ExtensionType,
  MintLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TRANSFER_FEE_CONFIG_SIZE,
  TransferFeeConfigLayout,
} from '@solana/spl-token';
import { PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import type { AccountInfo } from '@solana/web3.js';
import { captureOwnerGovernance, ownerGovernanceDependencies } from '../services/duskOwnerGovernance';
import { captureReferralPartner, referralPartnerAddress, referralPartnerDependencies } from '../services/duskReferralPartner';
import { deriveYieldAccountAddress } from '../services/virtualBook/native';
import { displayFixture, displayKey } from './duskDisplayStateFixtures';
import type { DuskDeploymentEnvelope } from '../services/duskDeploymentService';

const CLOCK_OWNER = new PublicKey('Sysvar1111111111111111111111111111111111111');
const deployment = { sourceSlot: 3000, programUpgradeAuthority: displayKey(80).toBase58() } as DuskDeploymentEnvelope;

async function chain(accounts: Map<string, AccountInfo<Buffer> | null>, slot = 3005, epoch = 9n) {
  const f = await displayFixture();
  const requests: { keys: string[]; minContextSlot?: number }[] = [];
  f.dusk.program.provider.connection.getMultipleAccountsInfoAndContext = async (keys, config) => {
    requests.push({ keys: keys.map(String), minContextSlot: (config as { minContextSlot?: number }).minContextSlot });
    const clock = Buffer.alloc(40);
    clock.writeBigUInt64LE(BigInt(slot));
    clock.writeBigUInt64LE(epoch, 16);
    return {
      context: { slot },
      value: keys.map((key) =>
        key.equals(SYSVAR_CLOCK_PUBKEY)
          ? { owner: CLOCK_OWNER, executable: false, lamports: 1, data: clock }
          : (accounts.get(key.toBase58()) ?? null),
      ),
    };
  };
  return { ...f, requests };
}

test('owner governance reports streamed supports and, for one market, its yLP yield accounts', async () => {
  const owner = displayKey(61).toBase58(),
    market = displayKey(62).toBase58();
  const mints = { ylpMint: displayKey(66).toBase58(), baseMint: displayKey(64).toBase58(), quoteMint: displayKey(65).toBase58() };
  const accounts = new Map<string, AccountInfo<Buffer> | null>();
  const f = await chain(accounts);
  const [baseYield, quoteYield] = [mints.baseMint, mints.quoteMint].map((asset) =>
    deriveYieldAccountAddress(new PublicKey(market), new PublicKey(owner), new PublicKey(mints.ylpMint), new PublicKey(asset), 'ylp', f.dusk.program.programId)[0].toBase58());
  // A yield account created at the old, shorter layout must be grown first.
  accounts.set(baseYield, { owner: f.dusk.program.programId, executable: false, lamports: 1, data: Buffer.alloc(234) });
  const supports = [{ proposal: displayKey(70).toBase58(), market, lockedAmount: '25' }];
  const deps: typeof ownerGovernanceDependencies = {
    supports: async (selectedOwner, selectedMarket) => {
      assert.equal(selectedOwner, owner);
      assert.equal(selectedMarket, market);
      return { supports, sourceSlot: 3001 };
    },
    marketMints: async () => mints,
  };
  const result = await captureOwnerGovernance(f.dusk, { owner, market }, deployment, undefined, deps);
  assert.equal(result.schemaVersion, 'dusk-owner-governance.v1');
  assert.deepEqual(result.supports, supports);
  assert.deepEqual(result.yieldAccounts, [
    { assetMint: mints.baseMint, address: baseYield, initialized: true, needsGrowth: true },
    { assetMint: mints.quoteMint, address: quoteYield, initialized: false, needsGrowth: false },
  ]);
  assert.equal(result.sourceSlot, 3005);
  assert.equal(f.requests[0].minContextSlot, 3001);
  const everywhere = await captureOwnerGovernance(f.dusk, { owner, market: null }, deployment, undefined,
    { ...deps, supports: async () => ({ supports: [], sourceSlot: 3001 }) });
  assert.equal(everywhere.yieldAccounts, null);
  assert.equal(everywhere.sourceSlot, 3001);
  await assert.rejects(captureOwnerGovernance(f.dusk, { owner, market }, deployment, undefined, { ...deps, marketMints: async () => null }),
    /Unknown governance market/);
});

function mint(program: PublicKey, fee = false): AccountInfo<Buffer> {
  const data = Buffer.alloc(fee ? ACCOUNT_SIZE + 5 + TRANSFER_FEE_CONFIG_SIZE : MintLayout.span);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 1n, decimals: 6, isInitialized: true,
    freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data);
  if (fee) {
    data[ACCOUNT_SIZE] = AccountType.Mint;
    data.writeUInt16LE(ExtensionType.TransferFeeConfig, ACCOUNT_SIZE + 1);
    data.writeUInt16LE(TRANSFER_FEE_CONFIG_SIZE, ACCOUNT_SIZE + 3);
    const schedule = { epoch: 0n, maximumFee: 50n, transferFeeBasisPoints: 100 };
    TransferFeeConfigLayout.encode({ transferFeeConfigAuthority: PublicKey.default, withdrawWithheldAuthority: PublicKey.default,
      withheldAmount: 0n, olderTransferFee: schedule, newerTransferFee: schedule }, data.subarray(ACCOUNT_SIZE + 5));
  }
  return { owner: program, executable: false, lamports: 1, data };
}

test('a referral partner nets each streamed accrual of the transfer fee in force now', async () => {
  const authority = displayKey(61).toBase58(),
    market = displayKey(62).toBase58(),
    base = displayKey(64).toBase58(),
    quote = displayKey(65).toBase58();
  const partner = referralPartnerAddress(authority);
  const accounts = new Map<string, AccountInfo<Buffer> | null>();
  const f = await chain(accounts);
  const program = f.dusk.program.programId;
  const [baseAccrual] = PublicKey.findProgramAddressSync([Buffer.from('referral_accrual'), partner.toBuffer(), new PublicKey(market).toBuffer(),
    new PublicKey(base).toBuffer()], program);
  accounts.set(baseAccrual.toBase58(), { owner: program, executable: false, lamports: 1, data: Buffer.alloc(80) });
  accounts.set(base, mint(TOKEN_2022_PROGRAM_ID, true));
  accounts.set(quote, mint(TOKEN_PROGRAM_ID));
  const terms = { authority, recipient: displayKey(69).toBase58(), interestShareBps: 1500, active: true };
  const deps: typeof referralPartnerDependencies = {
    state: async () => ({ partner: terms, markets: [{ market, baseMint: base, quoteMint: quote }],
      accruals: new Map([[baseAccrual.toBase58(), 1000n]]), sourceSlot: 3002 }),
  };
  const result = await captureReferralPartner(f.dusk, authority, deployment, undefined, deps);
  assert.equal(result.schemaVersion, 'dusk-referral-partner.v1');
  assert.equal(result.address, partner.toBase58());
  assert.deepEqual(result.partner, terms);
  assert.equal(result.streams.length, 2);
  assert.deepEqual(result.streams[0], {
    address: baseAccrual.toBase58(), market, assetMint: base, assetDecimals: 6, tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(),
    interestVault: PublicKey.findProgramAddressSync([Buffer.from('market_interest'), new PublicKey(market).toBuffer(),
      new PublicKey(base).toBuffer()], program)[0].toBase58(),
    initialized: true, amount: '1000', recipientCredit: '990',
  });
  assert.equal(result.streams[1].initialized, false);
  assert.equal(result.streams[1].recipientCredit, '0');
  assert.equal(result.sourceSlot, 3005);
  // An accrual the stream reports must exist on chain.
  accounts.delete(baseAccrual.toBase58());
  await assert.rejects(captureReferralPartner(f.dusk, authority, deployment, undefined, deps), /missing its account/);
  // Without a configured partner nothing is read from the chain.
  const requests = f.requests.length;
  const empty = await captureReferralPartner(f.dusk, authority, deployment, undefined,
    { state: async () => ({ partner: null, markets: [], accruals: new Map(), sourceSlot: 3002 }) });
  assert.deepEqual([empty.partner, empty.streams, empty.sourceSlot], [null, [], 3002]);
  assert.equal(f.requests.length, requests);
});
