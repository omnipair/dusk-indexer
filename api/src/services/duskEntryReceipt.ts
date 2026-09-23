import { utils } from '@coral-xyz/anchor';
import type { Dusk } from '@omnipair/dusk-sdk';
import type { PublicKey, SimulatedTransactionResponse } from '@solana/web3.js';
const U64_MAX = (1n << 64n) - 1n;
type OpenEvent = {
  market: PublicKey;
  position: PublicKey;
  owner: PublicKey;
  debtAssetMint: PublicKey;
  collateralAssetMint: PublicKey;
  marginAmount: { toString(): string };
  collateralAmount: { toString(): string };
  debtShares: { toString(): string };
  multiplierBps: { toString(): string };
  closeoutValue: { toString(): string };
  equity: { toString(): string };
  metadata: {
    signer: PublicKey;
    market: PublicKey;
    slot: { toString(): string };
  };
  swap: {
    assetInSide: number;
    feeAssetSide: number;
    amountIn: { toString(): string };
    amountOut: { toString(): string };
    baseFee: { toString(): string };
    divergenceFee: { toString(): string };
    volatilityFee: { toString(): string };
  };
};

export function readDuskOpenEvent(
  result: SimulatedTransactionResponse,
  context: { dusk: Dusk },
): OpenEvent {
  // Anchor 0.31's event-CPI instruction tag, before the IDL event discriminator.
  const tag = Buffer.from('e445a52e51cb9a1d', 'hex');
  const events: OpenEvent[] = [];
  for (const group of result.innerInstructions ?? []) {
    for (const instruction of group.instructions) {
      if (
        !instruction.programId.equals(context.dusk.program.programId) ||
        !('data' in instruction)
      )
        continue;
      const bytes = Buffer.from(utils.bytes.bs58.decode(instruction.data));
      if (!bytes.subarray(0, 8).equals(tag)) continue;
      const event = context.dusk.program.coder.events.decode(
        bytes.subarray(8).toString('base64'),
      );
      if (event?.name === 'leveragePositionOpened')
        events.push(event.data as OpenEvent);
    }
  }
  if (events.length !== 1)
    throw new Error('The program did not return one leverage entry receipt');
  return events[0];
}

export function duskU64(value: unknown): bigint {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new Error(
      'Raw token amounts must be safe integers or decimal strings',
    );
  }
  if (!/^(0|[1-9][0-9]*)$/.test(String(value))) {
    throw new Error('Raw token amounts must be unsigned decimal integers');
  }
  const raw = BigInt(String(value));
  if (raw > U64_MAX) throw new Error('Raw token amount exceeds u64');
  return raw;
}
