import { utils } from '@coral-xyz/anchor';

import type { Dusk, LeveragePosition, Market } from '@omnipair/dusk-sdk';
import type { PublicKey, SimulatedTransactionResponse } from '@solana/web3.js';

type Amount = { toString(): string };
interface CloseEvent {
  market: PublicKey;
  position: PublicKey;
  owner: PublicKey;
  debtAssetMint: PublicKey;
  collateralAssetMint: PublicKey;
  debtRepaid: Amount;
  collateralSold: Amount;
  closeoutValue: Amount;
  residual: Amount;
  swap: { assetInSide: number; amountIn: Amount; amountOut: Amount };
  metadata: { market: PublicKey; signer: PublicKey; slot: Amount };
}

/** A full-close receipt supplies gross execution value, separately from the owner's net receipt. */
export function readDuskLeverageCloseReceipt(
  result: SimulatedTransactionResponse,
  dusk: Dusk,
  positionAddress: PublicKey,
  position: LeveragePosition,
  market: Market,
  slot: number,
  netOutputRaw: bigint,
) {
  const tag = Buffer.from('e445a52e51cb9a1d', 'hex');
  const events: CloseEvent[] = [];
  for (const group of result.innerInstructions ?? []) {
    for (const instruction of group.instructions) {
      if (
        !instruction.programId.equals(dusk.program.programId) ||
        !('data' in instruction)
      )
        continue;
      const bytes = Buffer.from(utils.bytes.bs58.decode(instruction.data));
      if (!bytes.subarray(0, 8).equals(tag)) continue;
      const event = dusk.program.coder.events.decode(
        bytes.subarray(8).toString('base64'),
      );
      if (event?.name === 'leveragePositionClosed')
        events.push(event.data as CloseEvent);
    }
  }
  if (result.err || events.length !== 1)
    throw new Error('The program did not return one leverage close receipt');
  const event = events[0];
  const debt = position.debtAsset === 0 ? market.baseSide : market.quoteSide;
  const collateral =
    position.debtAsset === 0 ? market.quoteSide : market.baseSide;
  const grossCloseoutRaw = BigInt(event.closeoutValue.toString());
  const sold = BigInt(event.collateralSold.toString());
  const input = BigInt(event.swap.amountIn.toString());
  const repaid = BigInt(event.debtRepaid.toString());
  if (
    !event.market.equals(position.market) ||
    !event.metadata.market.equals(position.market) ||
    !event.position.equals(positionAddress) ||
    !event.owner.equals(position.owner) ||
    !event.metadata.signer.equals(position.owner) ||
    !event.debtAssetMint.equals(debt.assetMint) ||
    !event.collateralAssetMint.equals(collateral.assetMint) ||
    BigInt(event.metadata.slot.toString()) !== BigInt(slot) ||
    sold !== BigInt(position.collateralAmount.toString()) ||
    sold <= 0n ||
    input <= 0n ||
    input > sold ||
    event.swap.assetInSide !== (position.debtAsset === 0 ? 1 : 0) ||
    grossCloseoutRaw <= 0n ||
    grossCloseoutRaw !== BigInt(event.swap.amountOut.toString()) ||
    repaid < 0n ||
    repaid > grossCloseoutRaw ||
    netOutputRaw !== BigInt(event.residual.toString()) ||
    netOutputRaw < 0n ||
    netOutputRaw > grossCloseoutRaw - repaid
  )
    throw new Error(
      'Leverage close receipt does not match the position and simulation',
    );

  // In 9973dea the delegate checks the curve after the first controller advance.
  // Full close prepares the same curve again. A positive interval makes a second
  // advance in that slot impossible; a disabled controller or CPMM is also identical.
  // Protocol fee allocation changes reserve compounding, not this swap's amountOut.
  // If collateral loses atoms in transfer, its executed price is not the delegate's
  // full-collateral trigger. Keep that trigger unavailable while retaining net PnL.
  const sameCurve =
    market.config.amm.peakAmplificationNad.toString() === '1000000000' ||
    market.config.amm.adjustmentStepNad.toString() === '0' ||
    BigInt(market.config.amm.minAdjustmentIntervalSlots.toString()) > 0n;
  return {
    grossCloseoutRaw,
    triggerCloseoutPriceNad:
      input === sold && sameCurve
        ? (grossCloseoutRaw * 1_000_000_000n) / sold
        : null,
    collateralDecimals: collateral.assetDecimals,
  };
}
