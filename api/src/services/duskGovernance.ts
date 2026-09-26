import { PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import type { AccountInfo } from '@solana/web3.js';
import type { Dusk, Market, ParameterProposal } from '@omnipair/dusk-sdk';
import type { DuskDeploymentEnvelope } from './duskDeploymentService';
import { displayPublicKey } from './duskOwnerAccounts';
import { boundedDuskRpcRead } from './virtualBook/native';

const SYSVAR_OWNER = 'Sysvar1111111111111111111111111111111111111';
/** Proposals across every market in one discovery bank. */
export const GOVERNANCE_PROPOSAL_LIMIT = 500;
/** getMultipleAccounts takes 100 keys: the market, its yLP mint, both hLP yLP
 * vaults and the Clock leave room for 95 proposals in one bank. */
export const GOVERNANCE_MARKET_PROPOSAL_LIMIT = 95;
const MARKET_READ_CONCURRENCY = 3;

export interface GovernanceSelection {
  market: string | null;
}

/** Account bytes exactly as the RPC returned them; decoding and identity
 * checks belong to the consumer's pinned IDL. */
export interface GovernanceRawAccount {
  address: string;
  owner: string;
  data: string;
}

export interface GovernanceMarketGroup {
  address: string;
  slot: number;
  market: GovernanceRawAccount;
  ylpMint: GovernanceRawAccount;
  hlpYlpVaults: [GovernanceRawAccount | null, GovernanceRawAccount | null];
  clock: GovernanceRawAccount;
  proposals: GovernanceRawAccount[];
}

export function governanceSelection(market: unknown): GovernanceSelection {
  return { market: market === undefined ? null : displayPublicKey(market) };
}

/** Locale-independent: base58 addresses sort by UTF-16 code unit. */
function compareAddresses(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function rawAccount(
  address: PublicKey,
  account: AccountInfo<Buffer>,
): GovernanceRawAccount {
  return {
    address: address.toBase58(),
    owner: account.owner.toBase58(),
    data: account.data.toString('base64'),
  };
}

/** Results keep input order; a failure stops workers from starting new reads. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await run(items[index]);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

/** Complete confirmed governance snapshot. Discovery finds every proposal in one
 * bank; each market group re-reads its market, yLP mint, hLP yLP vaults, Clock
 * and proposals together in one later bank, so a consumer can compute tallies
 * without mixing banks. Raw bytes preserve the pinned SDK's lossless types. */
export async function captureGovernanceProposals(
  dusk: Dusk,
  selection: GovernanceSelection,
  deployment: DuskDeploymentEnvelope,
  signal?: AbortSignal,
) {
  const observedAt = Date.now();
  const programId = dusk.program.programId;
  if (programId.toBase58() !== deployment.programId)
    throw new Error('Governance SDK deployment mismatch');
  const connection = dusk.program.provider.connection;
  const coder = dusk.program.coder.accounts;
  const read = <T>(operation: () => Promise<T>) =>
    boundedDuskRpcRead(operation, signal);
  const programAccount = (
    account: AccountInfo<Buffer> | null | undefined,
  ): account is AccountInfo<Buffer> =>
    !!account && !account.executable && account.owner.equals(programId);
  const proposalAccount = (
    account: AccountInfo<Buffer> | null | undefined,
  ): account is AccountInfo<Buffer> =>
    programAccount(account) &&
    account.data.length >= 40 &&
    account.data.length <= 8192;

  const discovery = await read(() =>
    connection.getProgramAccounts(programId, {
      commitment: 'confirmed',
      withContext: true,
      minContextSlot: deployment.sourceSlot,
      filters: [
        { memcmp: coder.memcmp('parameterProposal') },
        ...(selection.market
          ? [{ memcmp: { offset: 8, bytes: selection.market } }]
          : []),
      ],
    }),
  );
  const discoverySlot = discovery.context.slot;
  if (
    !Number.isSafeInteger(discoverySlot) ||
    discoverySlot < deployment.sourceSlot ||
    discovery.value.length > GOVERNANCE_PROPOSAL_LIMIT
  )
    throw new Error(
      'Governance proposal snapshot is stale or exceeds its complete-snapshot limit',
    );
  const seen = new Set<string>();
  const byMarket = new Map<string, PublicKey[]>();
  for (const { pubkey, account } of discovery.value) {
    const address = pubkey.toBase58();
    if (seen.has(address) || !proposalAccount(account))
      throw new Error('Invalid governance proposal snapshot');
    seen.add(address);
    const market = coder
      .decode<ParameterProposal>('parameterProposal', account.data)
      .market.toBase58();
    if (selection.market !== null && market !== selection.market)
      throw new Error('Governance proposal snapshot crossed market scope');
    const proposals = byMarket.get(market);
    if (proposals) proposals.push(pubkey);
    else byMarket.set(market, [pubkey]);
  }
  const groups = [...byMarket]
    .map(([address, proposals]) => ({
      address,
      proposals: proposals.sort((a, b) =>
        compareAddresses(a.toBase58(), b.toBase58()),
      ),
    }))
    .sort((a, b) => compareAddresses(a.address, b.address));
  for (const group of groups)
    if (group.proposals.length > GOVERNANCE_MARKET_PROPOSAL_LIMIT)
      throw new Error(
        `Governance market ${group.address} has ${group.proposals.length} proposals, above the complete-snapshot limit of ${GOVERNANCE_MARKET_PROPOSAL_LIMIT} per market`,
      );
  signal?.throwIfAborted();

  const captureMarket = async (group: {
    address: string;
    proposals: PublicKey[];
  }): Promise<GovernanceMarketGroup> => {
    const marketKey = new PublicKey(group.address);
    const initial = await read(() =>
      connection.getAccountInfoAndContext(marketKey, {
        commitment: 'confirmed',
        minContextSlot: discoverySlot,
      }),
    );
    const initialSlot = initial.context.slot;
    if (!Number.isSafeInteger(initialSlot) || initialSlot < discoverySlot)
      throw new Error('Governance market read is behind proposal discovery');
    if (!programAccount(initial.value))
      throw new Error('Governance market unavailable');
    const market = coder.decode<Market>('market', initial.value.data);
    const ylpMint = market.ylpMint;
    const vaults = [
      market.baseHlpVault.ylpVault,
      market.quoteHlpVault.ylpVault,
    ] as const;
    const keys = [
      marketKey,
      ylpMint,
      ...vaults,
      SYSVAR_CLOCK_PUBKEY,
      ...group.proposals,
    ];
    if (new Set(keys.map((key) => key.toBase58())).size !== keys.length)
      throw new Error('Duplicate governance source accounts');
    signal?.throwIfAborted();
    const response = await read(() =>
      connection.getMultipleAccountsInfoAndContext(keys, {
        commitment: 'confirmed',
        minContextSlot: initialSlot,
      }),
    );
    const slot = response.context.slot;
    if (
      !Number.isSafeInteger(slot) ||
      slot < initialSlot ||
      response.value.length !== keys.length
    )
      throw new Error('Governance market snapshot is behind confirmed state');
    const [marketInfo, mintInfo, baseVault, quoteVault, clock, ...proposals] =
      response.value;
    if (!programAccount(marketInfo))
      throw new Error('Governance market unavailable');
    const current = coder.decode<Market>('market', marketInfo.data);
    // The source keys came from the earlier bank's market.
    if (
      !current.ylpMint.equals(ylpMint) ||
      !current.baseHlpVault.ylpVault.equals(vaults[0]) ||
      !current.quoteHlpVault.ylpVault.equals(vaults[1])
    )
      throw new Error('Governance market identity changed during capture');
    if (!mintInfo || mintInfo.executable)
      throw new Error('Governance yLP mint unavailable');
    if (
      !clock ||
      clock.executable ||
      clock.owner.toBase58() !== SYSVAR_OWNER ||
      clock.data.length !== 40 ||
      clock.data.readBigUInt64LE(0) !== BigInt(slot)
    )
      throw new Error('Invalid governance Clock');
    return {
      address: group.address,
      slot,
      market: rawAccount(marketKey, marketInfo),
      ylpMint: rawAccount(ylpMint, mintInfo),
      hlpYlpVaults: [
        baseVault ? rawAccount(vaults[0], baseVault) : null,
        quoteVault ? rawAccount(vaults[1], quoteVault) : null,
      ],
      clock: rawAccount(SYSVAR_CLOCK_PUBKEY, clock),
      proposals: proposals.map((info, index) => {
        if (
          !proposalAccount(info) ||
          coder
            .decode<ParameterProposal>('parameterProposal', info.data)
            .market.toBase58() !== group.address
        )
          throw new Error('Governance proposal changed during capture');
        return rawAccount(group.proposals[index], info);
      }),
    };
  };
  const markets = await mapWithConcurrency(
    groups,
    MARKET_READ_CONCURRENCY,
    captureMarket,
  );
  signal?.throwIfAborted();
  return {
    schemaVersion: 'dusk-governance-proposals.v1' as const,
    market: selection.market,
    complete: true as const,
    sourceSlot: Math.max(discoverySlot, ...markets.map(({ slot }) => slot)),
    observedAt,
    expiresAt: observedAt + 15_000,
    markets,
  };
}
