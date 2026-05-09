export interface OrderedEventRef {
  slot: number;
  txSig?: string | null;
  instructionPath?: string | null;
}

export function isBeforeEarningSource(
  candidate: OrderedEventRef,
  source: OrderedEventRef
): boolean {
  if (candidate.slot < source.slot) {
    return true;
  }
  if (candidate.slot > source.slot) {
    return false;
  }
  return Boolean(
    candidate.txSig
      && source.txSig
      && candidate.txSig === source.txSig
      && candidate.instructionPath
      && source.instructionPath
      && candidate.instructionPath < source.instructionPath
  );
}

export function hasUnknownSameSlotOrdering(
  candidate: OrderedEventRef,
  source: OrderedEventRef
): boolean {
  if (candidate.slot !== source.slot) {
    return false;
  }
  if (!candidate.txSig || !source.txSig || !candidate.instructionPath || !source.instructionPath) {
    return true;
  }
  return candidate.txSig !== source.txSig;
}
