import test from 'node:test';
import assert from 'node:assert/strict';
import { getMetadataAccountDataSerializer } from '@metaplex-foundation/mpl-token-metadata';
import { none, publicKey } from '@metaplex-foundation/umi';
import { AccountType, ExtensionType, MintLayout, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { pack } from '@solana/spl-token-metadata';
import { snapshotTokenMetadata, tokenMetadataAddress } from '../services/duskMarketExtras';
import type { LiveMarketSimulationSnapshot } from '../services/duskMarketSimulation';
import { fixtureKey } from './duskYieldCheckpointFixtures';

const mint = fixtureKey(44),authority = fixtureKey(45);
function mintBytes() {
  const raw = Buffer.alloc(MintLayout.span);
  MintLayout.encode({ mintAuthorityOption: 0,mintAuthority: authority,supply: 100n,decimals: 0,isInitialized: true,
    freezeAuthorityOption: 0,freezeAuthority: authority },raw);
  return raw;
}
function snapshot() {
  return { accounts: [{ address: mint.toBase58(),account: { owner: TOKEN_PROGRAM_ID.toBase58(),executable: false,data: mintBytes().toString('base64') } }] } as LiveMarketSimulationSnapshot;
}
test('Metaplex labels are bound to the mint and optional padding is removed',() => {
  const sample = snapshot(),metadata = getMetadataAccountDataSerializer().serialize({
    mint: publicKey(mint.toBase58()),updateAuthority: publicKey(authority.toBase58()),name: 'Example\0\0',symbol: 'EX\0',uri: '',
    sellerFeeBasisPoints: 0,creators: none(),primarySaleHappened: false,isMutable: true,editionNonce: none(),tokenStandard: none(),
    collection: none(),uses: none(),collectionDetails: none(),programmableConfig: none(),
  });
  const entry = { address: tokenMetadataAddress(mint.toBase58()),account: {
    owner: 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',executable: false,data: Buffer.from(metadata).toString('base64') } };
  sample.accounts.push(entry);
  assert.deepEqual(snapshotTokenMetadata(sample,mint.toBase58()),{ mint: mint.toBase58(),name: 'Example',symbol: 'EX',source: 'metaplex',address: entry.address });
  entry.account.owner = TOKEN_PROGRAM_ID.toBase58();
  assert.equal(snapshotTokenMetadata(sample,mint.toBase58()),null);
});
test('Token-2022 embedded metadata supplies display names without changing mint precision',() => {
  const sample = snapshot(),data = Buffer.from(pack({ mint,name: 'Fee test',symbol: 'FEE',uri: '',additionalMetadata: [] }));
  const raw = Buffer.alloc(166+4+data.length); mintBytes().copy(raw); raw[165] = AccountType.Mint;
  raw.writeUInt16LE(ExtensionType.TokenMetadata,166); raw.writeUInt16LE(data.length,168); data.copy(raw,170);
  sample.accounts[0].account = { owner: TOKEN_2022_PROGRAM_ID.toBase58(),executable: false,data: raw.toString('base64') };
  assert.equal(snapshotTokenMetadata(sample,mint.toBase58())?.symbol,'FEE');
  // A metadata extension naming a different mint must never rename this token.
  fixtureKey(46).toBuffer().copy(raw,170+32);
  sample.accounts[0].account!.data = raw.toString('base64');
  assert.equal(snapshotTokenMetadata(sample,mint.toBase58()),null);
});
test('unlabelled or malformed token metadata remains optional',() => {
  const sample = snapshot();
  assert.equal(snapshotTokenMetadata(sample,mint.toBase58()),null);
  sample.accounts.push({ address: tokenMetadataAddress(mint.toBase58()),account: {
    owner: 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',executable: false,data: 'AA==' } });
  assert.equal(snapshotTokenMetadata(sample,mint.toBase58()),null);
});
