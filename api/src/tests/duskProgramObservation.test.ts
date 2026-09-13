import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { Connection, PublicKey } from '@solana/web3.js';
import { loadPinnedProtocol, sha256 } from '../config/duskProtocol';
import { createDuskProgramObserver } from '../services/duskProgramObservation';

type Read = Connection['getMultipleAccountsInfoAndContext'];
type Result = Awaited<ReturnType<Read>>;
type Options = Parameters<Read>[1];
test('program observations enforce the caller source-slot floor, including cached binaries', async () => {
  const sample = fixture();
  await sample.observe(sample.pins);
  sample.setSlot(59);
  await assert.rejects(sample.observe(sample.pins, 60), /regressed/);
  assert.equal((sample.calls.at(-1)!.options as { minContextSlot: number }).minContextSlot, 60);
  sample.setSlot(60);
  const result = await sample.observe(sample.pins, 60);
  assert.ok(result.every(program => program.sourceSlot === 60));
  const count = sample.calls.length;
  for (const floor of [-1, NaN, 1.5, Infinity])
    await assert.rejects(sample.observe(sample.pins, floor), /Invalid bounded/);
  assert.equal(sample.calls.length, count);
});
function fixture() {
  const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
  const protocol = loadPinnedProtocol();
  const bodies = [
    Buffer.from('dusk-binary-fixture'),
    Buffer.from('delegate-binary-fixture'),
  ];
  const pins = [protocol.dusk, protocol.leverageDelegate].map((pin, index) => ({
    ...pin,
    binarySha256: sha256(bodies[index]),
    deployment: {
      ...pin.deployment,
      deploySlot: 10,
      allocatedBinaryBytes: bodies[index].length,
    },
  }));
  const accounts = new Map<string, NonNullable<Result['value'][number]>>();
  for (const [index, pin] of pins.entries()) {
    const program = Buffer.alloc(36);
    program.writeUInt32LE(2);
    new PublicKey(pin.deployment.programData).toBuffer().copy(program, 4);
    const data = Buffer.alloc(45 + bodies[index].length);
    data.writeUInt32LE(3);
    data.writeBigUInt64LE(10n, 4);
    if (pin.deployment.upgradeAuthority) {
      data[12] = 1;
      new PublicKey(pin.deployment.upgradeAuthority).toBuffer().copy(data, 13);
    }
    bodies[index].copy(data, 45);
    accounts.set(pin.programId, {
      data: program,
      owner: loader,
      executable: true,
      lamports: 1,
      rentEpoch: 0,
    });
    accounts.set(pin.deployment.programData, {
      data,
      owner: loader,
      executable: false,
      lamports: 1,
      rentEpoch: 0,
    });
  }
  let slot = 40;
  let transform: (result: Result, options: Options) => Promise<Result> = async (
    result,
  ) => result;
  const calls: { addresses: string[]; options: Options }[] = [];
  const read: Read = async (addresses, options) => {
    calls.push({
      addresses: addresses.map((address) => address.toBase58()),
      options,
    });
    const opts = typeof options === 'object' ? options : undefined;
    const result = {
      context: { slot: opts?.commitment === 'finalized' ? 20 : slot },
      value: addresses.map((address) => {
        const account = accounts.get(address.toBase58());
        if (!account) return null;
        const slice = opts?.dataSlice;
        return {
          ...account,
          data: Buffer.from(
            slice
              ? account.data.subarray(slice.offset, slice.offset + slice.length)
              : account.data,
          ),
        };
      }),
    };
    return transform(result, options);
  };
  return {
    pins,
    accounts,
    calls,
    observe: createDuskProgramObserver({
      getMultipleAccountsInfoAndContext: read,
    }),
    setSlot: (value: number) => {
      slot = value;
    },
    setTransform: (value: typeof transform) => {
      transform = value;
    },
  };
}

test('both executable programs and headers are checked at one bank; finalized hashes cache independently', async () => {
  const f = fixture(),
    first = await f.observe(f.pins);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(
    f.calls[0].addresses,
    f.pins.flatMap((pin) => [pin.programId, pin.deployment.programData]),
  );
  assert.deepEqual(f.calls[0].options, {
    commitment: 'confirmed',
    minContextSlot: 11,
    dataSlice: { offset: 0, length: 45 },
  });
  assert.deepEqual(
    first.map((program) => program.sourceSlot),
    [40, 40],
  );
  assert.deepEqual(
    first.map((program) => program.binarySha256),
    f.pins.map((pin) => pin.binarySha256),
  );
  // Finalized evidence at slot 20 proves the binary from deployment 10; live
  // loader headers still come from the fresher confirmed bank, slot 40.
  for (const call of f.calls.slice(1))
    assert.deepEqual(call.options, {
      commitment: 'finalized',
      minContextSlot: 11,
    });
  f.setSlot(41);
  assert.deepEqual(
    (await f.observe(f.pins)).map((program) => program.sourceSlot),
    [41, 41],
  );
  assert.equal(f.calls.length, 4);
});

test('a cached binary cannot authorize a changed, closed or substituted loader account', async () => {
  for (const role of ['program', 'data'] as const) {
    for (const change of [
      'owner',
      'executable',
      'lamports',
      'pointer-or-slot',
    ]) {
      const f = fixture();
      await f.observe(f.pins);
      const pin = f.pins[1],
        address =
          role === 'program' ? pin.programId : pin.deployment.programData;
      const account = f.accounts.get(address)!;
      if (change === 'owner') account.owner = PublicKey.default;
      if (change === 'executable') account.executable = role === 'data';
      if (change === 'lamports') account.lamports = 0;
      if (change === 'pointer-or-slot') {
        if (role === 'program')
          PublicKey.default.toBuffer().copy(account.data, 4);
        else account.data.writeBigUInt64LE(11n, 4);
      }
      await assert.rejects(f.observe(f.pins), /differs from|Invalid pinned/);
    }
  }
});

test('malformed headers and authority changes fail even after a successful observation', async () => {
  for (const change of ['short', 'tag', 'option', 'authority']) {
    const f = fixture();
    await f.observe(f.pins);
    const account = f.accounts.get(f.pins[0].deployment.programData)!;
    if (change === 'short') account.data = account.data.subarray(0, 44);
    if (change === 'tag') account.data.writeUInt32LE(2);
    if (change === 'option') account.data[12] = 2;
    if (change === 'authority') account.data[13] ^= 1;
    await assert.rejects(f.observe(f.pins), /ProgramData|differs from/);
  }
});

test('failed binary observations do not poison the cache or advance the slot floor', async () => {
  for (const change of [
    'bytes',
    'allocation',
    'header',
    'owner',
    'executable',
    'lamports',
    'slot',
    'incomplete',
  ]) {
    const f = fixture();
    f.setTransform(async (result, options) => {
      if (typeof options === 'object' && options.commitment === 'finalized') {
        const account = result.value[0]!;
        if (change === 'bytes') account.data[45] ^= 1;
        if (change === 'allocation')
          account.data = Buffer.concat([account.data, Buffer.from([0])]);
        if (change === 'header') account.data.writeBigUInt64LE(11n, 4);
        if (change === 'owner') account.owner = PublicKey.default;
        if (change === 'executable') account.executable = true;
        if (change === 'lamports') account.lamports = 0;
        if (change === 'slot') result.context.slot = 10;
        if (change === 'incomplete') result.value = [];
      }
      return result;
    });
    await assert.rejects(f.observe(f.pins), /binary|ProgramData/);
    f.setTransform(async (result) => result);
    f.setSlot(39);
    assert.deepEqual(
      (await f.observe(f.pins)).map((program) => program.sourceSlot),
      [39, 39],
    );
  }
});

test('program bank regression and incomplete responses are rejected', async () => {
  for (const slot of [39, 0, NaN, 40.5]) {
    const f = fixture();
    await f.observe(f.pins);
    f.setSlot(slot);
    await assert.rejects(f.observe(f.pins), /incomplete or regressed/);
  }
  const f = fixture();
  f.setTransform(async (result) => ({
    ...result,
    value: result.value.slice(0, 3),
  }));
  await assert.rejects(f.observe(f.pins), /incomplete or regressed/);
});

test('the cache also binds the expected binary digest and allocation', async () => {
  const f = fixture();
  await f.observe(f.pins);
  await assert.rejects(
    f.observe([{ ...f.pins[0], binarySha256: 'a'.repeat(64) }, f.pins[1]]),
    /binary differs/,
  );
  await assert.rejects(
    f.observe([
      {
        ...f.pins[0],
        deployment: { ...f.pins[0].deployment, allocatedBinaryBytes: 1 },
      },
      f.pins[1],
    ]),
    /changed while hashing/,
  );
});

test('concurrent observations share cold binary requests but each reads fresh loader headers', async () => {
  const f = fixture();
  let release!: () => void,
    started!: () => void,
    fullReads = 0;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    ready = new Promise<void>((resolve) => {
      started = resolve;
    });
  f.setTransform(async (result, options) => {
    if (typeof options === 'object' && options.commitment === 'finalized') {
      fullReads++;
      if (fullReads === 2) started();
      await gate;
    }
    return result;
  });
  const first = f.observe(f.pins);
  await ready;
  const second = f.observe(f.pins);
  await setImmediate();
  release();
  await Promise.all([first, second]);
  assert.equal(fullReads, 2);
  assert.equal(f.calls.filter((call) => call.addresses.length === 4).length, 2);
});
