import test from 'node:test';
import assert from 'node:assert/strict';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import {
  captureLeverageValuation,
  leverageValuationSelection,
} from '../services/duskLeverageValuation';
import {
  captureOwnerAccounts,
  ownerAccountsSelection,
  ownerAccountNames,
} from '../services/duskOwnerAccounts';
import {
  currentDisplayState,
  displayStateDependencies,
} from '../services/duskDisplayState';
import { displayFixture, displayKey } from './duskDisplayStateFixtures';
import type { DuskDeploymentEnvelope } from '../services/duskDeploymentService';

test('wallet discovery captures complete pinned account bytes for all supported kinds', async () => {
  const f = await displayFixture();
  for (const kind of Object.keys(
    ownerAccountNames,
  ) as (keyof typeof ownerAccountNames)[]) {
    const name = ownerAccountNames[kind],
      value = f.layout(name).decode(Buffer.alloc(16384));
    Object.assign(
      value,
      kind === 'referral-accrual'
        ? { referralPartner: f.owner }
        : { owner: f.owner },
    );
    const raw = f.encodeAccount(name, value);
    f.state.discovered = [{ pubkey: f.positionAddress, account: raw }];
    const result = await captureOwnerAccounts(
      f.dusk,
      { owner: f.selection.owner, kind },
      f.deployment,
    );
    assert.equal(result.complete, true);
    assert.equal(result.sourceSlot, 1010);
    assert.equal(result.expiresAt - result.observedAt, 15_000);
    assert.equal(result.accounts[0].data, raw.data.toString('base64'));
  }
  f.state.discovered = [];
  assert.deepEqual(
    (
      await captureOwnerAccounts(
        f.dusk,
        { owner: f.selection.owner, kind: 'leverage' },
        f.deployment,
      )
    ).accounts,
    [],
  );
});

test('wallet discovery rejects wrong owner, program, incomplete bounds and regressed banks', async () => {
  for (const failure of [
    'owner',
    'program',
    'duplicate',
    'oversized',
    'slot',
  ]) {
    const f = await displayFixture(),
      selection = { owner: f.selection.owner, kind: 'leverage' as const };
    if (failure === 'owner') selection.owner = displayKey(99).toBase58();
    if (failure === 'program')
      f.state.discovered[0].account.owner = displayKey(99);
    if (failure === 'duplicate') f.state.discovered.push(f.state.discovered[0]);
    if (failure === 'oversized')
      f.state.discovered = Array(501).fill(f.state.discovered[0]);
    if (failure === 'slot') f.state.slot = 999;
    await assert.rejects(captureOwnerAccounts(f.dusk, selection, f.deployment));
  }
  for (const kind of ['__proto__', 'constructor', 'all', [], null])
    assert.throws(() => ownerAccountsSelection(displayKey(1).toBase58(), kind));
  assert.throws(() =>
    leverageValuationSelection('bad-wallet', displayKey(2).toBase58()),
  );
});

for (const [program, native] of [
  [TOKEN_PROGRAM_ID, false],
  [TOKEN_2022_PROGRAM_ID, false],
  [TOKEN_PROGRAM_ID, true],
] as const)
  test(`close valuation preserves exact receipts for ${program.toBase58()}, native=${native}`, async () => {
    const f = await displayFixture(program, native);
    const value = await captureLeverageValuation(
      f.dusk,
      f.selection,
      f.deployment,
    );
    assert.equal(value.netOutputRaw, '4200001');
    assert.equal(value.grossCloseoutRaw, '5200001');
    assert.equal(value.position.address, f.selection.address);
    assert.equal(value.sourceSlot, 1010);
    const { transaction, config } = f.state.simulations[0];
    assert.equal(config.sigVerify, false);
    assert.equal(config.replaceRecentBlockhash, true);
    assert.ok(
      transaction.signatures.every((signature) =>
        signature.every((byte) => byte === 0),
      ),
    );
  });

test('close valuation rejects changed ownership, failed execution and invalid receipts', async () => {
  for (const failure of [
    'owner',
    'slot',
    'failed',
    'receipt',
    'duplicate',
    'event-owner',
    'event-amount',
    'concurrent',
  ]) {
    const f = await displayFixture();
    if (failure === 'owner') f.selection.owner = displayKey(99).toBase58();
    if (failure === 'slot') f.state.slot = 999;
    if (failure === 'failed') f.state.err = { InstructionError: [4, 'failed'] };
    if (failure === 'receipt') f.state.receiptCount = 0;
    if (failure === 'duplicate') f.state.receiptCount = 2;
    if (failure === 'event-owner') f.closeEvent.owner = displayKey(99);
    if (failure === 'event-amount')
      f.closeEvent.residual = f.closeEvent.closeoutValue;
    if (failure === 'concurrent') {
      const simulate = f.connection.simulateTransaction;
      f.connection.simulateTransaction = async (tx, config) => {
        const result = await simulate(tx, config);
        f.state.changed = true;
        return result;
      };
    }
    await assert.rejects(
      captureLeverageValuation(f.dusk, f.selection, f.deployment),
      Error,
      failure,
    );
  }
});

test('shared delivery checks deployment and expiry without renewing cached evidence', async () => {
  const deployment = {
    deploymentIdentitySha256: 'a'.repeat(64),
    sourceSlot: 110,
  } as DuskDeploymentEnvelope;
  const data = {
    sourceSlot: 100,
    verificationSlot: 105,
    observedAt: Date.now() - 1000,
    expiresAt: Date.now() + 14_000,
  };
  const stored = { success: true as const, data, deployment };
  let calls = 0,
    upgraded = false;
  const deps = {
    envelope: async () => ({
      ...deployment,
      deploymentIdentitySha256:
        upgraded && ++calls > 1
          ? 'b'.repeat(64)
          : deployment.deploymentIdentitySha256,
    }),
    shared: async () => stored,
  } as unknown as typeof displayStateDependencies;
  const capture = async () => {
    throw new Error('Cache hit must not compute');
  };
  assert.equal((await currentDisplayState('test', capture, deps)).data, data);
  upgraded = true;
  await assert.rejects(
    currentDisplayState('test', capture, deps),
    /deployment changed/,
  );
  upgraded = false;
  data.expiresAt = Date.now();
  await assert.rejects(currentDisplayState('test', capture, deps), /expired/);
});
