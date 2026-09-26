import test from 'node:test';
import assert from 'node:assert/strict';
import { BN } from '@coral-xyz/anchor';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import type { AccountInfo } from '@solana/web3.js';
import type { Request, Response } from 'express';
import type { Market } from '@omnipair/dusk-sdk';
import router from '../routes/v1/duskRoutes';
import {
  captureGovernanceProposals,
  GOVERNANCE_MARKET_PROPOSAL_LIMIT,
  governanceSelection,
} from '../services/duskGovernance';
import { displayStateDependencies } from '../services/duskDisplayState';
import { displayFixture, displayKey } from './duskDisplayStateFixtures';
import { mintAccount, tokenAccount } from './duskDisplayTokenFixtures';
import type { DuskDeploymentEnvelope } from '../services/duskDeploymentService';

const SYSVAR = new PublicKey('Sysvar1111111111111111111111111111111111111');
interface Call {
  method: string;
  keys?: string[];
  config: any;
}

async function governanceFixture() {
  const f = await displayFixture();
  const accounts = new Map<string, AccountInfo<Buffer>>();
  const state = {
    discoverySlot: 1010,
    marketSlot: 1012,
    groupSlots: new Map<string, number>(),
    clockSlot: undefined as number | undefined,
    clockOwner: SYSVAR,
    clockLength: 40,
    // Accounts that differ in the later same-bank group read.
    groupOverrides: new Map<string, AccountInfo<Buffer> | null>(),
    discovered: [] as { pubkey: PublicKey; account: AccountInfo<Buffer> }[],
    calls: [] as Call[],
    inFlight: 0,
    maxInFlight: 0,
  };
  const set = (key: PublicKey, account: AccountInfo<Buffer>) => {
    accounts.set(key.toBase58(), account);
    return account;
  };
  const encodeMarket = (
    ylpMint: PublicKey,
    baseVault: PublicKey,
    quoteVault: PublicKey,
  ) => {
    const market = f.layout('market').decode(Buffer.alloc(16384)) as Market;
    Object.assign(market, { version: 1, ylpMint });
    market.baseHlpVault.ylpVault = baseVault;
    market.quoteHlpVault.ylpVault = quoteVault;
    return f.encodeAccount('market', market);
  };
  const addMarket = (
    address: PublicKey,
    n: number,
    options: { quoteVault?: boolean } = {},
  ) => {
    const ylpMint = displayKey(n),
      baseVault = displayKey(n + 1),
      quoteVault = displayKey(n + 2);
    set(address, encodeMarket(ylpMint, baseVault, quoteVault));
    set(ylpMint, mintAccount(TOKEN_2022_PROGRAM_ID));
    for (const vault of options.quoteVault === false
      ? [baseVault]
      : [baseVault, quoteVault]) {
      const account = tokenAccount(ylpMint, address, 5n);
      account.owner = TOKEN_2022_PROGRAM_ID;
      set(vault, account);
    }
    return { address, ylpMint, baseVault, quoteVault };
  };
  const encodeProposal = (market: PublicKey) => {
    const value = f
      .layout('parameterProposal')
      .decode(Buffer.alloc(16384)) as Record<string, unknown>;
    Object.assign(value, {
      market,
      proposer: displayKey(99),
      nonce: new BN(7),
    });
    return f.encodeAccount('parameterProposal', value);
  };
  const addProposal = (address: PublicKey, market: PublicKey) => {
    const account = set(address, encodeProposal(market));
    state.discovered.push({ pubkey: address, account });
    return account;
  };
  const clock = (slot: number): AccountInfo<Buffer> => {
    const data = Buffer.alloc(state.clockLength);
    data.writeBigUInt64LE(BigInt(slot));
    data.writeBigInt64LE(1_700_000_000n, 32);
    return { data, owner: state.clockOwner, executable: false, lamports: 1 };
  };
  const track = async <T>(call: Call, result: () => T) => {
    state.calls.push(call);
    state.maxInFlight = Math.max(state.maxInFlight, ++state.inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    state.inFlight--;
    return result();
  };
  Object.assign(f.dusk.program.provider.connection, {
    getProgramAccounts: (_program: PublicKey, config: unknown) =>
      track({ method: 'getProgramAccounts', config }, () => ({
        context: { slot: state.discoverySlot },
        value: state.discovered,
      })),
    getAccountInfoAndContext: (key: PublicKey, config: unknown) =>
      track(
        { method: 'getAccountInfoAndContext', keys: [key.toBase58()], config },
        () => ({
          context: { slot: state.marketSlot },
          value: accounts.get(key.toBase58()) ?? null,
        }),
      ),
    getMultipleAccountsInfoAndContext: (keys: PublicKey[], config: unknown) =>
      track(
        {
          method: 'getMultipleAccountsInfoAndContext',
          keys: keys.map((key) => key.toBase58()),
          config,
        },
        () => {
          const slot = state.groupSlots.get(keys[0].toBase58()) ?? 1015;
          return {
            context: { slot },
            value: keys.map((key) => {
              const address = key.toBase58();
              if (key.equals(SYSVAR_CLOCK_PUBKEY))
                return clock(state.clockSlot ?? slot);
              if (state.groupOverrides.has(address))
                return state.groupOverrides.get(address)!;
              return accounts.get(address) ?? null;
            }),
          };
        },
      ),
  });
  return {
    ...f,
    accounts,
    state,
    addMarket,
    addProposal,
    encodeMarket,
    encodeProposal,
  };
}

/** One market with two proposals, discovered out of address order. */
async function singleMarketFixture() {
  const g = await governanceFixture();
  const a = g.addMarket(displayKey(120), 121, { quoteVault: false });
  const proposals = [displayKey(140), displayKey(141)].sort((x, y) =>
    x.toBase58() < y.toBase58() ? -1 : 1,
  );
  for (const proposal of [...proposals].reverse())
    g.addProposal(proposal, a.address);
  return { ...g, a, proposals };
}

const capture = (
  g: Awaited<ReturnType<typeof governanceFixture>>,
  market: string | null = null,
  deployment: DuskDeploymentEnvelope = g.deployment,
  signal?: AbortSignal,
) => captureGovernanceProposals(g.dusk, { market }, deployment, signal);

test('governance selection accepts one canonical market and rejects malformed or repeated filters', () => {
  const market = displayKey(120).toBase58();
  assert.deepEqual(governanceSelection(undefined), { market: null });
  assert.deepEqual(governanceSelection(market), { market });
  for (const value of [
    '',
    'not-a-market',
    market.slice(0, 20),
    `${market}1`,
    `0${market.slice(1)}`,
    ` ${market}`,
    [market],
    [market, market],
    { market },
    1,
    null,
  ])
    assert.throws(
      () => governanceSelection(value),
      (error: { status?: number }) => error.status === 400,
    );
});

test('governance capture groups same-bank market evidence with raw proposal bytes', async () => {
  const g = await singleMarketFixture();
  const b = g.addMarket(displayKey(130), 131);
  // Interleave another market between the first market's proposals.
  const other = displayKey(150);
  const [last] = g.state.discovered.splice(1, 1);
  g.addProposal(other, b.address);
  g.state.discovered.push(last);
  g.state.groupSlots.set(g.a.address.toBase58(), 1015);
  g.state.groupSlots.set(b.address.toBase58(), 1018);
  const before = Date.now();
  const result = await capture(g);
  const after = Date.now();

  assert.equal(result.schemaVersion, 'dusk-governance-proposals.v1');
  assert.equal(result.market, null);
  assert.equal(result.complete, true);
  assert.equal(result.sourceSlot, 1018);
  assert.ok(result.observedAt >= before && result.observedAt <= after);
  assert.equal(result.expiresAt, result.observedAt + 15_000);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.deepEqual(
    result.markets.map(({ address }) => address),
    [g.a.address.toBase58(), b.address.toBase58()].sort(),
  );

  const program = g.dusk.program.programId.toBase58();
  const bytes = (key: PublicKey) => g.accounts.get(key.toBase58())!.data;
  const expectRaw = (
    raw: { address: string; owner: string; data: string } | null,
    key: PublicKey,
    owner: string,
  ) => {
    assert.ok(raw);
    assert.equal(raw.address, key.toBase58());
    assert.equal(raw.owner, owner);
    assert.ok(Buffer.from(raw.data, 'base64').equals(bytes(key)));
    assert.equal(Buffer.from(raw.data, 'base64').toString('base64'), raw.data);
  };
  const group = result.markets.find(
    ({ address }) => address === g.a.address.toBase58(),
  )!;
  assert.equal(group.slot, 1015);
  expectRaw(group.market, g.a.address, program);
  expectRaw(group.ylpMint, g.a.ylpMint, TOKEN_2022_PROGRAM_ID.toBase58());
  expectRaw(
    group.hlpYlpVaults[0],
    g.a.baseVault,
    TOKEN_2022_PROGRAM_ID.toBase58(),
  );
  assert.equal(group.hlpYlpVaults[1], null);
  assert.deepEqual(
    group.proposals.map(({ address }) => address),
    g.proposals.map((key) => key.toBase58()),
  );
  for (const [index, proposal] of group.proposals.entries())
    expectRaw(proposal, g.proposals[index], program);
  assert.equal(group.clock.address, SYSVAR_CLOCK_PUBKEY.toBase58());
  assert.equal(group.clock.owner, SYSVAR.toBase58());
  const clock = Buffer.from(group.clock.data, 'base64');
  assert.equal(clock.length, 40);
  assert.equal(clock.readBigUInt64LE(0), 1015n);

  const second = result.markets.find(
    ({ address }) => address === b.address.toBase58(),
  )!;
  assert.equal(second.slot, 1018);
  expectRaw(
    second.hlpYlpVaults[1],
    b.quoteVault,
    TOKEN_2022_PROGRAM_ID.toBase58(),
  );
  assert.deepEqual(
    second.proposals.map(({ address }) => address),
    [other.toBase58()],
  );
  assert.equal(
    Buffer.from(second.clock.data, 'base64').readBigUInt64LE(0),
    1018n,
  );

  // Discovery is complete for the deployment; each group reads one later bank.
  assert.deepEqual(g.state.calls[0], {
    method: 'getProgramAccounts',
    config: {
      commitment: 'confirmed',
      withContext: true,
      minContextSlot: 1000,
      filters: [
        { memcmp: g.dusk.program.coder.accounts.memcmp('parameterProposal') },
      ],
    },
  });
  const call = (method: string, market: PublicKey) =>
    g.state.calls.filter(
      (entry) =>
        entry.method === method && entry.keys?.[0] === market.toBase58(),
    );
  assert.deepEqual(call('getAccountInfoAndContext', g.a.address), [
    {
      method: 'getAccountInfoAndContext',
      keys: [g.a.address.toBase58()],
      config: { commitment: 'confirmed', minContextSlot: 1010 },
    },
  ]);
  assert.deepEqual(call('getMultipleAccountsInfoAndContext', g.a.address), [
    {
      method: 'getMultipleAccountsInfoAndContext',
      keys: [
        g.a.address,
        g.a.ylpMint,
        g.a.baseVault,
        g.a.quoteVault,
        SYSVAR_CLOCK_PUBKEY,
        ...g.proposals,
      ].map((key) => key.toBase58()),
      config: { commitment: 'confirmed', minContextSlot: 1012 },
    },
  ]);
  assert.equal(g.state.calls.length, 5);
});

test('a market-scoped capture filters discovery and rejects a proposal for another market', async () => {
  const g = await singleMarketFixture();
  const market = g.a.address.toBase58();
  const result = await capture(g, market);
  assert.equal(result.market, market);
  assert.deepEqual(
    result.markets.map(({ address }) => address),
    [market],
  );
  assert.deepEqual(g.state.calls[0].config.filters[1], {
    memcmp: { offset: 8, bytes: market },
  });
  const b = g.addMarket(displayKey(130), 131);
  g.addProposal(displayKey(150), b.address);
  await assert.rejects(capture(g, market), /crossed market scope/);
});

test('a Clock from a different bank than the group read is rejected', async () => {
  const g = await singleMarketFixture();
  g.state.clockSlot = 1014;
  await assert.rejects(capture(g), /Invalid governance Clock/);
});

test('discovery below the deployment source slot is rejected', async () => {
  const g = await singleMarketFixture();
  g.state.discoverySlot = 999;
  await assert.rejects(capture(g), /stale/);
  assert.equal(g.state.calls.length, 1);
});

test('no proposals is a complete empty snapshot at the discovery slot', async () => {
  const g = await governanceFixture();
  g.addMarket(displayKey(120), 121);
  for (const market of [null, displayKey(120).toBase58()]) {
    g.state.calls = [];
    const result = await capture(g, market);
    assert.deepEqual(result.markets, []);
    assert.equal(result.market, market);
    assert.equal(result.complete, true);
    assert.equal(result.sourceSlot, 1010);
    assert.equal(result.expiresAt, result.observedAt + 15_000);
    assert.equal(g.state.calls.length, 1);
  }
});

test('market groups are read at most three at a time and returned in address order', async () => {
  const g = await governanceFixture();
  const markets = [200, 190, 180, 170, 160].map((n) =>
    g.addMarket(displayKey(n), n + 1),
  );
  markets.forEach(({ address }, index) =>
    g.addProposal(displayKey(10 + index), address),
  );
  const result = await capture(g);
  assert.deepEqual(
    result.markets.map(({ address }) => address),
    markets.map(({ address }) => address.toBase58()).sort(),
  );
  assert.ok(result.markets.every(({ proposals }) => proposals.length === 1));
  assert.equal(g.state.maxInFlight, 3);
});

test('governance capture rejects incomplete, foreign, stale or inconsistent evidence', async () => {
  type Fixture = Awaited<ReturnType<typeof singleMarketFixture>>;
  const replaceDiscovered = (
    g: Fixture,
    change: Partial<AccountInfo<Buffer>>,
  ) => {
    const [row] = g.state.discovered;
    g.state.discovered[0] = { ...row, account: { ...row.account, ...change } };
  };
  const cases: [string, (g: Fixture) => unknown, RegExp][] = [
    [
      'program',
      (g) => ({ ...g.deployment, programId: displayKey(98).toBase58() }),
      /deployment mismatch/,
    ],
    [
      'unsafe-slot',
      (g) => {
        g.state.discoverySlot = 2 ** 53;
      },
      /stale/,
    ],
    [
      'oversized',
      (g) => {
        g.state.discovered = Array(501).fill(g.state.discovered[0]);
      },
      /complete-snapshot limit/,
    ],
    [
      'duplicate',
      (g) => {
        g.state.discovered.push(g.state.discovered[0]);
      },
      /Invalid governance proposal snapshot/,
    ],
    [
      'foreign-owner',
      (g) => replaceDiscovered(g, { owner: displayKey(98) }),
      /Invalid governance proposal snapshot/,
    ],
    [
      'executable',
      (g) => replaceDiscovered(g, { executable: true }),
      /Invalid governance proposal snapshot/,
    ],
    [
      'short',
      (g) =>
        replaceDiscovered(g, {
          data: g.state.discovered[0].account.data.subarray(0, 39),
        }),
      /Invalid governance proposal snapshot/,
    ],
    [
      'long',
      (g) =>
        replaceDiscovered(g, {
          data: Buffer.concat([
            g.state.discovered[0].account.data,
            Buffer.alloc(8192),
          ]),
        }),
      /Invalid governance proposal snapshot/,
    ],
    [
      'market-missing',
      (g) => g.accounts.delete(g.a.address.toBase58()),
      /Governance market unavailable/,
    ],
    [
      'market-foreign',
      (g) => {
        const market = g.accounts.get(g.a.address.toBase58())!;
        g.accounts.set(g.a.address.toBase58(), {
          ...market,
          owner: displayKey(98),
        });
      },
      /Governance market unavailable/,
    ],
    [
      'market-behind-discovery',
      (g) => {
        g.state.marketSlot = 1009;
      },
      /behind proposal discovery/,
    ],
    [
      'group-behind-market',
      (g) => g.state.groupSlots.set(g.a.address.toBase58(), 1011),
      /behind confirmed state/,
    ],
    [
      'clock-owner',
      (g) => {
        g.state.clockOwner = displayKey(98);
      },
      /Invalid governance Clock/,
    ],
    [
      'clock-length',
      (g) => {
        g.state.clockLength = 48;
      },
      /Invalid governance Clock/,
    ],
    [
      'mint-missing',
      (g) => g.accounts.delete(g.a.ylpMint.toBase58()),
      /yLP mint unavailable/,
    ],
    [
      'proposal-closed',
      (g) => g.state.groupOverrides.set(g.proposals[0].toBase58(), null),
      /proposal changed during capture/,
    ],
    [
      'proposal-moved',
      (g) =>
        g.state.groupOverrides.set(
          g.proposals[1].toBase58(),
          g.encodeProposal(displayKey(130)),
        ),
      /proposal changed during capture/,
    ],
    [
      'market-identity',
      (g) =>
        g.state.groupOverrides.set(
          g.a.address.toBase58(),
          g.encodeMarket(displayKey(98), g.a.baseVault, g.a.quoteVault),
        ),
      /identity changed/,
    ],
    [
      'duplicate-keys',
      (g) =>
        g.accounts.set(
          g.a.address.toBase58(),
          g.encodeMarket(g.a.ylpMint, g.a.baseVault, g.a.baseVault),
        ),
      /Duplicate governance source accounts/,
    ],
  ];
  for (const [name, mutate, pattern] of cases) {
    const g = await singleMarketFixture();
    const deployment = mutate(g);
    await assert.rejects(
      capture(
        g,
        null,
        name === 'program' ? (deployment as DuskDeploymentEnvelope) : undefined,
      ),
      pattern,
      name,
    );
  }
  const aborted = await singleMarketFixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    capture(aborted, null, aborted.deployment, controller.signal),
  );
  assert.equal(aborted.state.calls.length, 0);
});

test('more proposals than one group read can hold is a complete-snapshot error', async () => {
  const g = await governanceFixture();
  const a = g.addMarket(displayKey(120), 121);
  for (let i = 0; i <= GOVERNANCE_MARKET_PROPOSAL_LIMIT; i++)
    g.addProposal(PublicKey.unique(), a.address);
  await assert.rejects(
    capture(g),
    new RegExp(
      `has ${GOVERNANCE_MARKET_PROPOSAL_LIMIT + 1} proposals, above the complete-snapshot limit of ${GOVERNANCE_MARKET_PROPOSAL_LIMIT} per market`,
    ),
  );
  assert.equal(g.state.calls.length, 1);
  g.state.discovered.pop();
  const result = await capture(g);
  assert.equal(
    result.markets[0].proposals.length,
    GOVERNANCE_MARKET_PROPOSAL_LIMIT,
  );
});

test('governance route keys shared snapshots by selection and rejects malformed filters', async (context) => {
  const identity = 'a'.repeat(64);
  const deployment = {
    deploymentIdentitySha256: identity,
    sourceSlot: 1100,
  } as DuskDeploymentEnvelope;
  const data = {
    schemaVersion: 'dusk-governance-proposals.v1',
    market: null,
    complete: true,
    sourceSlot: 1050,
    observedAt: Date.now() - 1000,
    expiresAt: Date.now() + 14_000,
    markets: [],
  };
  const keys: string[] = [];
  context.mock.method(displayStateDependencies, 'envelope', async () => deployment);
  context.mock.method(
    displayStateDependencies,
    'shared',
    async (options: { key: string }) => {
      keys.push(options.key);
      return { success: true, deployment, data };
    },
  );
  const layer = router.stack.find(
    (entry: any) => entry.route?.path === '/governance/proposals',
  );
  assert.ok(layer?.route, 'governance route is registered');
  const handle = layer.route.stack[0].handle;
  const invoke = (query: Record<string, unknown>) => {
    const headers: Record<string, string> = {};
    return new Promise<{ body: any; headers: Record<string, string> }>(
      (resolve, reject) => {
        handle(
          { query } as unknown as Request,
          {
            setHeader: (name: string, value: string) => {
              headers[name] = value;
            },
            json: (body: unknown) => resolve({ body, headers }),
          } as unknown as Response,
          reject,
        );
      },
    );
  };
  const market = displayKey(120).toBase58();
  const all = await invoke({});
  assert.equal(all.headers['Cache-Control'], 'no-store');
  assert.equal(all.body.success, true);
  assert.equal(all.body.data, data);
  assert.equal(all.body.deployment, deployment);
  await invoke({ market });
  assert.deepEqual(keys, [
    `display.v1:${identity}:governance:proposals:all`,
    `display.v1:${identity}:governance:proposals:${market}`,
  ]);
  for (const value of [[market, market], [market], 'bad', '', { market }])
    await assert.rejects(
      invoke({ market: value }),
      (error: { status?: number }) => error.status === 400,
    );
  assert.equal(keys.length, 2);
});
