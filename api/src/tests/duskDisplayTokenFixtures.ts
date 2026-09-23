import { AccountLayout, MintLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';

import type { AccountInfo } from '@solana/web3.js';

export function mintAccount(program = TOKEN_PROGRAM_ID): AccountInfo<Buffer> {
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 1_000_000_000n,
      decimals: 9,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  );
  return {
    data,
    owner: program,
    lamports: 1_000_000,
    executable: false,
    rentEpoch: 0,
  };
}

export function tokenAccount(
  mint: PublicKey,
  owner: PublicKey,
  amount: bigint,
): AccountInfo<Buffer> {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 1,
      isNative: 2_039_280n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return {
    data,
    owner: TOKEN_PROGRAM_ID,
    lamports: Number(amount + 2_039_280n),
    executable: false,
    rentEpoch: 0,
  };
}
