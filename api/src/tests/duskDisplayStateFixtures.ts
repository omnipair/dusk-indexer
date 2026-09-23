import { BN, utils } from '@coral-xyz/anchor';
import { IdlCoder } from '@coral-xyz/anchor/dist/cjs/coder/borsh/idl';
import {
  PublicKey,
  Connection,
  AccountInfo,
  SimulateTransactionConfig,
  VersionedTransaction,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, NATIVE_MINT } from '@solana/spl-token';
import { createVirtualBookRuntime } from '../services/virtualBook/native';
import { mintAccount, tokenAccount } from './duskDisplayTokenFixtures';
import type { DuskDeploymentEnvelope } from '../services/duskDeploymentService';
import type { LeveragePosition, Market } from '@omnipair/dusk-sdk';

export const displayKey = (n: number) => new PublicKey(Buffer.alloc(32, n));
export async function displayFixture(
  tokenProgram = TOKEN_PROGRAM_ID,
  native = false,
) {
  const owner = displayKey(61),
    marketAddress = displayKey(62),
    id = displayKey(63);
  const base = displayKey(64),
    quote = native ? NATIVE_MINT : displayKey(65),
    ylp = displayKey(66);
  const accounts = new Map<string, AccountInfo<Buffer>>([
    [base.toBase58(), mintAccount(tokenProgram)],
    [quote.toBase58(), mintAccount(tokenProgram)],
  ]);
  const state = {
    slot: 1010,
    reads: 0,
    changed: false,
    err: null as unknown,
    receiptCount: 1,
    discovered: [] as { pubkey: PublicKey; account: AccountInfo<Buffer> }[],
    simulations: [] as {
      transaction: VersionedTransaction;
      config: SimulateTransactionConfig;
    }[],
  };
  const connection = {
    getAccountInfo: async (key: PublicKey) =>
      accounts.get(key.toBase58()) ?? null,
    getAccountInfoAndContext: async (key: PublicKey) => {
      state.reads++;
      const value = accounts.get(key.toBase58()) ?? null;
      return {
        context: { slot: state.slot },
        value:
          value && state.changed && key.equals(positionAddress)
            ? { ...value, data: Buffer.concat([value.data, Buffer.from([1])]) }
            : value,
      };
    },
    getProgramAccounts: async () => ({
      context: { slot: state.slot },
      value: state.discovered,
    }),
    getMinimumBalanceForRentExemption: async () => 2_039_280,
    simulateTransaction: async (
      transaction: VersionedTransaction,
      config: SimulateTransactionConfig,
    ) => {
      state.simulations.push({ transaction, config });
      const received = tokenAccount(quote, owner, 4_200_001n);
      received.owner = tokenProgram;
      const buffer = Buffer.alloc(16384),
        length = layout('leveragePositionClosed').encode(closeEvent, buffer);
      const data = utils.bytes.bs58.encode(
        Buffer.concat([
          Buffer.from('e445a52e51cb9a1d', 'hex'),
          Buffer.from(
            dusk.program.idl.events!.find(
              (e) => e.name === 'leveragePositionClosed',
            )!.discriminator,
          ),
          buffer.subarray(0, length),
        ]),
      );
      return {
        context: { slot: state.slot },
        value: {
          err: state.err,
          innerInstructions: Array.from({ length: state.receiptCount }, () => ({
            index: 4,
            instructions: [
              { programId: dusk.program.programId, accounts: [], data },
            ],
          })),
          accounts: [
            null,
            serialized(received),
            serialized(accounts.get(marketAddress.toBase58())!),
          ],
        },
      };
    },
  };
  const { dusk } = await createVirtualBookRuntime(
    connection as unknown as Connection,
  );
  const positionAddress = dusk.get.pda.leveragePosition(marketAddress, id)[0];
  const layout = (name: string) =>
    IdlCoder.typeDefLayout({
      typeDef: dusk.program.idl.types!.find((t) => t.name === name)!,
      types: dusk.program.idl.types!,
    });
  const market = layout('market').decode(Buffer.alloc(16384)) as Market;
  Object.assign(market, { version: 1, ylpMint: ylp });
  Object.assign(market.baseSide, { assetMint: base, assetDecimals: 9 });
  Object.assign(market.quoteSide, { assetMint: quote, assetDecimals: 9 });
  const position = layout('leveragePosition').decode(
    Buffer.alloc(16384),
  ) as LeveragePosition;
  Object.assign(position, {
    owner,
    market: marketAddress,
    positionId: id,
    debtAsset: 1,
    debtShares: new BN(10),
    collateralAmount: new BN(100),
    referralPartner: PublicKey.default,
  });
  const encodeAccount = (name: string, value: unknown): AccountInfo<Buffer> => {
    const buffer = Buffer.alloc(16384),
      length = layout(name).encode(value, buffer);
    return {
      owner: dusk.program.programId,
      executable: false,
      lamports: 1e8,
      data: Buffer.concat([
        Buffer.from(
          dusk.program.idl.accounts!.find((a) => a.name === name)!
            .discriminator,
        ),
        buffer.subarray(0, length),
      ]),
    };
  };
  accounts.set(marketAddress.toBase58(), encodeAccount('market', market));
  accounts.set(
    positionAddress.toBase58(),
    encodeAccount('leveragePosition', position),
  );
  state.discovered = [
    {
      pubkey: positionAddress,
      account: accounts.get(positionAddress.toBase58())!,
    },
  ];
  const serialized = (account: AccountInfo<Buffer>) => ({
    ...account,
    owner: account.owner.toBase58(),
    data: [account.data.toString('base64'), 'base64'],
  });
  const closeEvent = layout('leveragePositionClosed').decode(
    Buffer.alloc(16384),
  );
  Object.assign(closeEvent, {
    market: marketAddress,
    position: positionAddress,
    owner,
    debtAssetMint: quote,
    collateralAssetMint: base,
    debtRepaid: new BN(1_000_000),
    collateralSold: position.collateralAmount,
    closeoutValue: new BN(5_200_001),
    residual: new BN(4_200_001),
  });
  Object.assign(closeEvent.swap, {
    assetInSide: 0,
    amountIn: position.collateralAmount,
    amountOut: closeEvent.closeoutValue,
  });
  Object.assign(closeEvent.metadata, {
    market: marketAddress,
    signer: owner,
    slot: new BN(1010),
  });
  const deployment = {
    programId: dusk.program.programId.toBase58(),
    sourceSlot: 1000,
    programUpgradeAuthority: displayKey(80).toBase58(),
    deploymentIdentitySha256: 'a'.repeat(64),
  } as DuskDeploymentEnvelope;
  return {
    dusk,
    state,
    connection,
    owner,
    position,
    positionAddress,
    market,
    marketAddress,
    deployment,
    accounts,
    closeEvent,
    layout,
    encodeAccount,
    selection: { owner: owner.toBase58(), address: positionAddress.toBase58() },
  };
}
