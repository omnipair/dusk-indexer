import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BN, BorshCoder, Idl } from '@coral-xyz/anchor';
import { convertIdlToCamelCase } from '@coral-xyz/anchor/dist/cjs/idl';
import { IdlCoder } from '@coral-xyz/anchor/dist/cjs/coder/borsh/idl';
import { PublicKey } from '@solana/web3.js';
import { canonicalJson, loadPinnedProtocol, sha256 } from '../config/duskProtocol';
import { marketLayoutVersion } from '../services/duskProtocolSchema';
import { curveReserve, projectBorrowController } from '../services/duskBorrowController';
import { payableInterest, projectLiveYield } from '../services/duskYieldAccounting';

const root = resolve(__dirname, '../../../protocol/candidates/next-2026-11-15-accrued-interest');
const candidate = JSON.parse(readFileSync(resolve(root, 'candidate.json'), 'utf8'));
const idl = JSON.parse(readFileSync(resolve(root, 'idl/dusk.json'), 'utf8')) as Idl;
const key = (byte: number) => new PublicKey(Buffer.alloc(32, byte));
const Q = 1n << 64n;
const big = (value: bigint | number) => new BN(value.toString());

test('the accrued-interest candidate is layout 19 without income books, epochs or interest funding', () => {
  assert.equal(candidate.schemaVersion, 'dusk-protocol-candidate.v1');
  assert.equal(candidate.status, 'undeployed');
  assert.equal(candidate.marketLayoutVersion, 19);
  for (const program of candidate.programs) {
    const bytes = readFileSync(resolve(root, program.idl.path));
    assert.equal(sha256(bytes), program.idl.sha256);
    assert.equal(sha256(canonicalJson(JSON.parse(bytes.toString()))), program.idl.canonicalSha256);
    assert.equal(JSON.parse(bytes.toString()).address, program.programId);
  }
  assert.equal(marketLayoutVersion(idl), 19);
  const names = (rows: { name: string }[] | undefined) => new Set((rows ?? []).map((row) => row.name));
  assert.equal(names(idl.accounts).has('IncomeEpoch'), false);
  for (const removed of ['fund_interest', 'checkpoint_income', 'roll_income_epoch'])
    assert.equal(names(idl.instructions).has(removed), false, removed);
  for (const removed of ['PublicInterestFunded', 'HlpInterestAllocated'])
    assert.equal(names(idl.events).has(removed), false, removed);
  assert.equal(names(idl.errors).has('InterestDeficit'), true);
  assert.equal(names(idl.errors).has('IncomeEpochNeedsRollover'), false);
});

test('the candidate does not replace the active pin', () => {
  const active = loadPinnedProtocol();
  assert.notEqual(active.revision, candidate.revision);
  assert.notEqual(active.dusk.idlCanonicalSha256, candidate.programs[0].idl.canonicalSha256);
});

test('a layout-19 market and yield account feed the yield, payable and controller projections', () => {
  const camel = convertIdlToCamelCase(idl),coder = new BorshCoder(camel).accounts;
  // Anchor's account encoder allocates 1,000 bytes; Market is larger.
  const encode = (name: string, value: unknown) => {
    const definition = camel.types!.find((type) => type.name === name)!;
    const body = Buffer.alloc(coder.size(name)),length = IdlCoder.typeDefLayout({ typeDef: definition,types: camel.types! }).encode(value,body);
    return Buffer.concat([Buffer.from(camel.accounts!.find((account) => account.name === name)!.discriminator),body.subarray(0,length)]);
  };
  const blank = (name: string) => {
    const bytes = Buffer.alloc(coder.size(name));
    bytes.set(camel.accounts!.find((account) => account.name === name)!.discriminator);
    return coder.decode(name, bytes);
  };
  const market = blank('market');
  Object.assign(market, { version: 19, srlpMint: key(1) });
  market.amm.priceEmaNad = big(1_000_000_000);
  market.tranches.juniorReserveShares = big(25);
  Object.assign(market.baseSide, { assetMint: key(2), hlpMint: key(3), assetDecimals: 6 });
  Object.assign(market.quoteSide, { assetMint: key(4), hlpMint: key(5), assetDecimals: 6 });
  for (const side of [market.baseSide, market.quoteSide]) {
    side.shares.srlpSupply = big(100);
    side.reserves.liveReserve = big(100_000000);
    side.reserves.cashReserve = big(3);
  }
  Object.assign(market.baseSide.fees, { interestGrowthIndexQ64: big(2n * Q) });
  Object.assign(market.baseSide.fees.ledger, { credited: big(9_000000), protocolUnpaid: big(1_000000),
    fundingRecognized: big(4_000000), operatorClaimable: big(2_000000) });
  Object.assign(market.baseHlpVault, { hlpSupply: big(10), baseInterestGrowthIndexQ64: big(2n * Q), heldBaseInterest: big(5) });
  const bytes = encode('market', market);
  assert.equal(bytes.length, 4_478);
  const decoded = coder.decode('market', bytes);
  assert.equal(decoded.version, 19);
  assert.equal(decoded.baseHlpVault.heldBaseInterest.toString(), '5');
  assert.equal(decoded.baseSide.interestVault, undefined);
  assert.equal(decoded.income, undefined);
  assert.equal(curveReserve(decoded.baseSide), 94_000000n);
  assert.equal(curveReserve(decoded.quoteSide), 100_000000n);
  assert.equal(projectBorrowController(decoded, 7)!.fundedJuniorValueNad, String((194n * 1_000_000_000n) / 4n));

  const holder = blank('yieldAccount');
  assert.equal(holder.income, undefined);
  Object.assign(holder, { owner: key(9), market: key(8), lpMint: key(1), assetMint: key(2), tokenKind: 0, recipient: key(9),
    interestCheckpointQ64: big(Q), accruedInterestAmount: big(1) });
  const account = coder.decode('yieldAccount', encode('yieldAccount', holder));
  const amounts = projectLiveYield(decoded, account, 3n);
  assert.equal(amounts.interestAmount, 4n);
  // Three atoms of reserve cash pay three; one stays claimable.
  assert.equal(payableInterest(decoded, amounts.side, amounts.interestAmount), 3n);
  // An hLP holder earns from the vault index; interest the vault holds is not theirs.
  const hlp = coder.decode('yieldAccount', encode('yieldAccount', { ...account, lpMint: key(3), tokenKind: 1 }));
  assert.equal(projectLiveYield(decoded, hlp, 3n).interestAmount, 4n);
});

