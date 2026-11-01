import { Connection, PublicKey } from '@solana/web3.js';
import { DUSK_DEPLOYMENT_COMMITMENT, duskApiConfig } from '../config/duskProtocol';

/**
 * Whether the program's futarchy authority exists. It holds the protocol
 * authority and the fee recipients `initialize_market` reads. An in-place
 * upgrade keeps it; a deploy to a new program ID starts without it, and every
 * market launch then fails until the upgrade authority creates it.
 */
export interface FutarchyAuthorityStatus {
  address: string;
  /** Null when the read failed: unknown, not missing. */
  initialized: boolean | null;
}

/** A missing account is read again after this long; a present one never is. */
const MISSING_RECHECK_MS = 30_000;
const observed = new Map<string, { initialized: boolean; at: number }>();

export async function futarchyAuthorityStatus(
  programId: string,
  rpc?: Pick<Connection, 'getAccountInfo'>,
  now = Date.now(),
): Promise<FutarchyAuthorityStatus> {
  const program = new PublicKey(programId);
  const address = PublicKey.findProgramAddressSync([Buffer.from('futarchy_authority')], program)[0].toBase58();
  const cached = observed.get(programId);
  if (cached && (cached.initialized || now - cached.at < MISSING_RECHECK_MS))
    return { address, initialized: cached.initialized };
  try {
    const account = await (rpc ?? new Connection(duskApiConfig().rpcUrl, DUSK_DEPLOYMENT_COMMITMENT)).getAccountInfo(
      new PublicKey(address),
    );
    const initialized = account !== null && account.owner.equals(program);
    observed.set(programId, { initialized, at: now });
    return { address, initialized };
  } catch {
    return { address, initialized: null };
  }
}
