/** Isolated native execution: all depth batches use one unchanged Clock and bank. */
import { convertIdlToCamelCase } from '@coral-xyz/anchor/dist/cjs/idl';
import { createFrozenProgramRuntime } from './duskFrozenProgramRuntime';
import { frozenPreviewConnection } from './duskFrozenPreviewConnection';
import { FrozenLeverageBank, quoteRuntimeBytes } from './duskLeverageMaximumInput';
import { duskRawIdl } from './duskMarketSimulation';
import { createVirtualBookRuntime } from './virtualBook/native';
import { readDuskVirtualBook } from './virtualBook/virtual-book-read';
import { readDuskVirtualBookQuotes } from './virtualBook/virtual-book-quotes';
import { projectDuskVirtualBook } from './virtualBook/virtual-book-view-model';
import type { DuskDeploymentEnvelope } from './duskDeploymentService';
import type { VirtualBookSelection } from './duskVirtualBook';

export async function quoteFrozenVirtualBook(bank: FrozenLeverageBank,selection: VirtualBookSelection,deployment: DuskDeploymentEnvelope) {
  const idl = duskRawIdl(),binary = quoteRuntimeBytes(deployment.programId,deployment.programBinarySha256);
  if (bank.slot<deployment.sourceSlot || idl.address!==deployment.programId) throw new Error('Frozen book deployment differs');
  const tags = convertIdlToCamelCase(idl).instructions.filter(ix => ['previewMarket','previewSwap'].includes(ix.name)).map(ix => Uint8Array.from(ix.discriminator));
  if (tags.length!==2) throw new Error('Frozen book preview instructions unavailable');
  const svm = createFrozenProgramRuntime(bank,deployment.programId,binary);
  const runtime = await createVirtualBookRuntime(frozenPreviewConnection(svm,bank,deployment.programId,tags));
  const boundary = { assertCompatibleForRead: async (_: unknown,_signal?: AbortSignal,floor=0) => {
    if (floor>bank.slot) throw new Error('Frozen depth bank is behind its boundary');
    return { observedSlot: bank.slot };
  } };
  const snapshot = await readDuskVirtualBook({ dusk: runtime.dusk,market: selection.market,deployment,boundary });
  const quoted = await readDuskVirtualBookQuotes({ dusk: runtime.dusk,snapshot,boundary,groupingBps: selection.groupingBps,levels: selection.levels });
  const book = projectDuskVirtualBook(quoted);
  if (!book || quoted.slot!==bank.slot || quoted.firstQuoteSlot!==bank.slot) throw new Error('Frozen depth capture is inconsistent');
  return { book,slot: bank.slot,firstQuoteSlot: bank.slot,baseMint: quoted.account.baseSide.assetMint.toBase58(),
    quoteMint: quoted.account.quoteSide.assetMint.toBase58(),baseDecimals: quoted.account.baseSide.assetDecimals,quoteDecimals: quoted.account.quoteSide.assetDecimals };
}
