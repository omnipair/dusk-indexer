import { Connection, PublicKey } from '@solana/web3.js';
import {
  canonicalJson,
  DUSK_DEPLOYMENT_COMMITMENT,
  sha256,
} from '../config/duskProtocol';
import type { DuskPinnedProgram } from '../config/duskProtocol';

const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const HEADER_BYTES = 45;
type Rpc = Pick<Connection, 'getMultipleAccountsInfoAndContext'>;
export interface ObservedProgram {
  programDataAddress: string;
  programDataSlot: string;
  upgradeAuthority: string | null;
  binarySha256: string;
  sourceSlot: number;
}

function parseHeader(data: Buffer) {
  if (data.length < HEADER_BYTES || data.readUInt32LE(0) !== 3 || data[12] > 1)
    throw new Error('Malformed upgradeable ProgramData header');
  return {
    programDataSlot: data.readBigUInt64LE(4).toString(),
    upgradeAuthority:
      data[12] === 0
        ? null
        : new PublicKey(data.subarray(13, HEADER_BYTES)).toBase58(),
  };
}

/** Recheck every loader account at one bank; only immutable binary hashes cache. */
export function createDuskProgramObserver(rpc: Rpc) {
  const hashes = new Map<string, Promise<string>>();
  let minimumSlot = 0;
  return async (
    pins: readonly DuskPinnedProgram[],
  ): Promise<ObservedProgram[]> => {
    if (
      !pins.length ||
      pins.length > 2 ||
      new Set(pins.map((pin) => pin.programId)).size !== pins.length
    )
      throw new Error('Invalid bounded program observation');
    const floor = Math.max(
      minimumSlot,
      ...pins.map((pin) => pin.deployment.deploySlot + 1),
    );
    const observed = await rpc.getMultipleAccountsInfoAndContext(
      pins.flatMap((pin) => [
        new PublicKey(pin.programId),
        new PublicKey(pin.deployment.programData),
      ]),
      {
        commitment: DUSK_DEPLOYMENT_COMMITMENT,
        minContextSlot: floor,
        dataSlice: { offset: 0, length: HEADER_BYTES },
      },
    );
    if (
      !Number.isSafeInteger(observed.context.slot) ||
      observed.context.slot < floor ||
      observed.value.length !== pins.length * 2
    )
      throw new Error(
        'Program observation returned incomplete or regressed state',
      );
    const headers = pins.map((pin, index) => {
      const program = observed.value[index * 2],
        account = observed.value[index * 2 + 1];
      if (
        !program?.executable ||
        program.lamports <= 0 ||
        !program.owner.equals(LOADER) ||
        program.data.length < 36 ||
        program.data.readUInt32LE(0) !== 2 ||
        new PublicKey(program.data.subarray(4, 36)).toBase58() !==
          pin.deployment.programData
      )
        throw new Error(`Program ${pin.programId} differs from deployment pin`);
      if (
        !account ||
        account.executable ||
        account.lamports <= 0 ||
        !account.owner.equals(LOADER) ||
        account.data.length !== HEADER_BYTES
      )
        throw new Error('Invalid pinned ProgramData account');
      const header = parseHeader(account.data);
      if (
        header.programDataSlot !== String(pin.deployment.deploySlot) ||
        header.upgradeAuthority !== pin.deployment.upgradeAuthority
      )
        throw new Error(
          'ProgramData deployment slot or upgrade authority differs from pin',
        );
      return header;
    });
    const programs = await Promise.all(
      pins.map(async (pin, index) => {
        const header = headers[index];
        const key = canonicalJson({
          programId: pin.programId,
          ...pin.deployment,
          binarySha256: pin.binarySha256,
        });
        let pending = hashes.get(key);
        if (!pending) {
          pending = (async () => {
            // The finalized binary may precede the current confirmed bank, but
            // must follow this exact deployment and carry the identical header.
            const binary = await rpc.getMultipleAccountsInfoAndContext(
              [new PublicKey(pin.deployment.programData)],
              {
                commitment: 'finalized',
                minContextSlot: pin.deployment.deploySlot + 1,
              },
            );
            const account = binary.value[0];
            if (
              !Number.isSafeInteger(binary.context.slot) ||
              binary.context.slot <= pin.deployment.deploySlot ||
              binary.value.length !== 1 ||
              !account ||
              account.executable ||
              account.lamports <= 0 ||
              !account.owner.equals(LOADER) ||
              account.data.length !==
                HEADER_BYTES + pin.deployment.allocatedBinaryBytes ||
              !account.data
                .subarray(0, HEADER_BYTES)
                .equals(observed.value[index * 2 + 1]!.data)
            )
              throw new Error(
                'ProgramData changed while hashing its pinned binary',
              );
            const digest = sha256(account.data.subarray(HEADER_BYTES));
            if (digest !== pin.binarySha256)
              throw new Error(
                `Program ${pin.programId} binary differs from deployment pin`,
              );
            return digest;
          })();
          hashes.set(key, pending);
          const owned = pending;
          void pending.catch(() => {
            if (hashes.get(key) === owned) hashes.delete(key);
          });
        }
        return {
          programDataAddress: pin.deployment.programData,
          ...header,
          binarySha256: await pending,
          sourceSlot: observed.context.slot,
        };
      }),
    );
    minimumSlot = Math.max(minimumSlot, observed.context.slot);
    return programs;
  };
}
