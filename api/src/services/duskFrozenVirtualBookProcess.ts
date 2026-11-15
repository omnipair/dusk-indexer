import { quoteFrozenVirtualBook } from './duskFrozenVirtualBookEngine';
type Arguments = Parameters<typeof quoteFrozenVirtualBook>;
process.once('message',async (input: { bank: Arguments[0]; selection: Arguments[1]; deployment: Arguments[2] }) => {
  const send = (value: object) => process.send!(value,() => process.disconnect());
  try { send({ kind: 'book',...await quoteFrozenVirtualBook(input.bank,input.selection,input.deployment) }); }
  catch { send({ kind: 'unavailable' }); }
});
