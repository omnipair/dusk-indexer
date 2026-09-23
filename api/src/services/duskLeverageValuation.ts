import {
  createInitializeAccount3Instruction,
  getAccountLenForMint,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  unpackAccount,
  unpackMint,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import type { AccountInfo } from '@solana/web3.js';
import type { Dusk, LeveragePosition, Market } from '@omnipair/dusk-sdk';
import type { DuskDeploymentEnvelope } from './duskDeploymentService';
import { displayPublicKey } from './duskOwnerAccounts';
import { readDuskLeverageCloseReceipt } from './duskLeverageCloseReceipt';
import { boundedDuskRpcRead } from './virtualBook/native';

export interface LeverageValuationSelection {
  owner: string;
  address: string;
}
export function leverageValuationSelection(
  owner: unknown,
  address: unknown,
): LeverageValuationSelection {
  return { owner: displayPublicKey(owner), address: displayPublicKey(address) };
}

/** Backend-only, unsigned full-close simulation. The fresh recipient measures
 * the owner's exact receipt after accrued debt, curve execution and token fees.
 * No spot-price PnL approximation or transaction submission is used. */
export async function captureLeverageValuation(
  dusk: Dusk,
  selection: LeverageValuationSelection,
  deployment: DuskDeploymentEnvelope,
  signal?: AbortSignal,
) {
  const observedAt = Date.now();
  const rpc = dusk.program.provider.connection;
  const read = <T>(operation: () => Promise<T>) =>
    boundedDuskRpcRead(operation, signal);
  if (dusk.program.programId.toBase58() !== deployment.programId)
    throw new Error('Valuation SDK deployment mismatch');
  const address = new PublicKey(selection.address);
  const initial = await read(() =>
    rpc.getAccountInfoAndContext(address, {
      commitment: 'confirmed',
      minContextSlot: deployment.sourceSlot,
    }),
  );
  const assertProgramAccount = (
    account: AccountInfo<Buffer> | null,
  ): AccountInfo<Buffer> => {
    if (
      !account ||
      account.executable ||
      !account.owner.equals(dusk.program.programId)
    )
      throw new Error('Valuation program account unavailable');
    return account;
  };
  if (
    !Number.isSafeInteger(initial.context.slot) ||
    initial.context.slot < deployment.sourceSlot
  )
    throw new Error('Regressed valuation position slot');
  const positionBytes = assertProgramAccount(initial.value).data;
  const position = dusk.program.coder.accounts.decode<LeveragePosition>(
    'leveragePosition',
    positionBytes,
  );
  if (
    position.owner.toBase58() !== selection.owner ||
    ![0, 1].includes(position.debtAsset) ||
    !address.equals(
      dusk.get.pda.leveragePosition(position.market, position.positionId)[0],
    ) ||
    position.collateralAmount.isZero() ||
    position.debtShares.isZero()
  )
    throw new Error('Valuation position identity changed or is closed');
  const marketRead = await read(() =>
    rpc.getAccountInfoAndContext(position.market, {
      commitment: 'confirmed',
      minContextSlot: initial.context.slot,
    }),
  );
  if (
    !Number.isSafeInteger(marketRead.context.slot) ||
    marketRead.context.slot < initial.context.slot
  )
    throw new Error('Regressed valuation market slot');
  const market = dusk.program.coder.accounts.decode<Market>(
    'market',
    assertProgramAccount(marketRead.value).data,
  );
  if (market.version !== 1) throw new Error('Unsupported valuation market');
  const debtSide = position.debtAsset === 0 ? 'baseSide' : 'quoteSide';
  const collateralSide = position.debtAsset === 0 ? 'quoteSide' : 'baseSide';
  const mintAddress = market[debtSide].assetMint;
  const mintRead = await read(() =>
    rpc.getAccountInfoAndContext(mintAddress, {
      commitment: 'confirmed',
      minContextSlot: marketRead.context.slot,
    }),
  );
  const mintInfo = mintRead.value;
  if (
    !Number.isSafeInteger(mintRead.context.slot) ||
    mintRead.context.slot < marketRead.context.slot ||
    !mintInfo ||
    mintInfo.executable ||
    (!mintInfo.owner.equals(TOKEN_PROGRAM_ID) &&
      !mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID))
  )
    throw new Error('Valuation debt mint unavailable');
  const mint = unpackMint(mintAddress, mintInfo, mintInfo.owner);
  if (!mint.isInitialized || mint.decimals !== market[debtSide].assetDecimals)
    throw new Error('Valuation token precision changed');
  const payerAddress =
    process.env.DUSK_PREVIEW_PAYER?.trim() ||
    deployment.programUpgradeAuthority;
  if (!payerAddress)
    throw new Error('A read-only preview payer must be configured');
  const payer = new PublicKey(payerAddress),
    recipient = Keypair.generate().publicKey;
  const space = getAccountLenForMint(mint);
  const rent = await read(() =>
    rpc.getMinimumBalanceForRentExemption(space, 'confirmed'),
  );
  const close = await read(() =>
    dusk.write.closeLeverageInstruction({
      owner: position.owner,
      positionOwner: position.owner,
      market: position.market,
      positionId: position.positionId,
      leveragePosition: address,
      debtAsset: position.debtAsset === 0 ? 'base' : 'quote',
      debtMint: mintAddress,
      collateralMint: market[collateralSide].assetMint,
      ownerDebtAccount: recipient,
      referralPartner: position.referralPartner.equals(PublicKey.default)
        ? undefined
        : position.referralPartner,
      minAmountOut: 0n,
    }),
  );
  const transaction = new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer,
      recentBlockhash: PublicKey.default.toBase58(),
      instructions: [
        ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        SystemProgram.createAccount({
          fromPubkey: payer,
          newAccountPubkey: recipient,
          lamports: rent,
          space,
          programId: mintInfo.owner,
        }),
        createInitializeAccount3Instruction(
          recipient,
          mintAddress,
          position.owner,
          mintInfo.owner,
        ),
        close,
      ],
    }).compileToV0Message(),
  );
  const result = await read(() =>
    rpc.simulateTransaction(transaction, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
      minContextSlot: mintRead.context.slot,
      innerInstructions: true,
      accounts: {
        encoding: 'base64',
        addresses: [
          selection.address,
          recipient.toBase58(),
          position.market.toBase58(),
        ],
      },
    }),
  );
  const slot = result.context.slot;
  if (
    !Number.isSafeInteger(slot) ||
    slot < mintRead.context.slot ||
    result.value.err ||
    result.value.accounts?.length !== 3
  )
    throw new Error('Leverage close valuation cannot execute');
  const accountAt = (index: number): AccountInfo<Buffer> | null => {
    const value = result.value.accounts![index];
    if (!value) return null;
    if (
      value.executable ||
      value.data.length !== 2 ||
      value.data[1] !== 'base64' ||
      Buffer.from(value.data[0], 'base64').toString('base64') !== value.data[0]
    )
      throw new Error('Invalid valuation simulation account');
    return {
      owner: new PublicKey(value.owner),
      data: Buffer.from(value.data[0], 'base64'),
      executable: false,
      lamports: value.lamports,
    };
  };
  const remaining = accountAt(0);
  if (remaining && remaining.lamports > 0)
    throw new Error('Valuation simulation did not close the position');
  const received = accountAt(1);
  if (!received || !received.owner.equals(mintInfo.owner))
    throw new Error('Valuation receipt missing');
  const token = unpackAccount(recipient, received, mintInfo.owner);
  if (
    !token.isInitialized ||
    token.isFrozen ||
    !token.owner.equals(position.owner) ||
    !token.mint.equals(mintAddress)
  )
    throw new Error('Valuation receipt token identity changed');
  const afterMarket = dusk.program.coder.accounts.decode<Market>(
    'market',
    assertProgramAccount(accountAt(2)).data,
  );
  if (
    afterMarket.version !== 1 ||
    !afterMarket.ylpMint.equals(market.ylpMint) ||
    !afterMarket.baseSide.assetMint.equals(market.baseSide.assetMint) ||
    !afterMarket.quoteSide.assetMint.equals(market.quoteSide.assetMint) ||
    afterMarket.baseSide.assetDecimals !== market.baseSide.assetDecimals ||
    afterMarket.quoteSide.assetDecimals !== market.quoteSide.assetDecimals
  )
    throw new Error('Valuation market identity changed');
  const receipt = readDuskLeverageCloseReceipt(
    result.value,
    dusk,
    address,
    position,
    afterMarket,
    slot,
    token.amount,
  );
  // Changes to margin, shares or collateral during capture invalidate the result.
  const unchanged = await read(() =>
    rpc.getAccountInfoAndContext(address, {
      commitment: 'confirmed',
      minContextSlot: slot,
    }),
  );
  if (
    !Number.isSafeInteger(unchanged.context.slot) ||
    unchanged.context.slot < slot ||
    !assertProgramAccount(unchanged.value).data.equals(positionBytes)
  )
    throw new Error('Leverage position changed during valuation');
  signal?.throwIfAborted();
  return {
    schemaVersion: 'dusk-leverage-valuation.v1' as const,
    sourceSlot: slot,
    verificationSlot: unchanged.context.slot,
    observedAt,
    expiresAt: observedAt + 15_000,
    netOutputRaw: token.amount.toString(),
    grossCloseoutRaw: receipt.grossCloseoutRaw.toString(),
    triggerCloseoutPriceNad:
      receipt.triggerCloseoutPriceNad?.toString() ?? null,
    collateralDecimals: receipt.collateralDecimals,
    debtDecimals: mint.decimals,
    debtMint: mintAddress.toBase58(),
    position: {
      ...selection,
      market: position.market.toBase58(),
      positionId: position.positionId.toBase58(),
      debtAsset: position.debtAsset,
      collateralRaw: position.collateralAmount.toString(),
      marginRaw: position.marginAmount.toString(),
      notionalRaw: position.openNotional.toString(),
      debtShares: position.debtShares.toString(),
      debtPrincipal: position.debtPrincipal.toString(),
    },
  };
}
