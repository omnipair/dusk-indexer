import { quoteFrozenVirtualBook } from './duskFrozenVirtualBookEngine';
import { sdkForProtocol } from './virtualBook/native';
type Arguments = Parameters<typeof quoteFrozenVirtualBook>;
// Import the published SDK once. The engine still creates an entirely new VM,
// validates its executable and sets Clock/accounts from this request's bank.
void sdkForProtocol().then(() => process.send!({ kind: 'ready' }),() => process.exit(1));
let busy = false;
process.on('disconnect',() => process.exit(0));
process.on('message',async (input: { requestId: string; bank: Arguments[0]; selection: Arguments[1]; deployment: Arguments[2] }) => {
  if (busy || typeof input?.requestId !== 'string') { process.exit(1); return; }
  busy = true;
  const send = (value: object) => { busy = false; process.send!({ ...value,requestId: input.requestId }); };
  try { send({ kind: 'book',...await quoteFrozenVirtualBook(input.bank,input.selection,input.deployment) }); }
  catch { send({ kind: 'unavailable' }); }
});
