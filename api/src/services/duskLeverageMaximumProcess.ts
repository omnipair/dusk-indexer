import { quoteRuntimeBytes, searchFrozenLeverageMaximum, searchFrozenLeverageSize, NativeLeverageRejection } from './duskLeverageMaximumEngine';
process.once('message',(workerData: { input: Parameters<typeof searchFrozenLeverageMaximum>[0]; bank: Parameters<typeof searchFrozenLeverageMaximum>[1]; idl: Parameters<typeof searchFrozenLeverageMaximum>[2]; programId: string; binarySha256: string }) => {
const send = (value: object) => process.send!(value,() => process.disconnect());
try {
  const binary = quoteRuntimeBytes(workerData.programId,workerData.binarySha256);
  const started = performance.now();
  const result = (workerData.input.size ? searchFrozenLeverageSize : searchFrozenLeverageMaximum)(workerData.input,workerData.bank,workerData.idl,binary);
  send({ kind: workerData.input.size ? 'size' : 'maximum',...result,computeMs: performance.now()-started });
} catch (error) {
  send(error instanceof NativeLeverageRejection ? { kind: 'capacity',rejection: error.rejection }
    : { kind: 'unavailable',message: error instanceof Error ? error.message : 'Native quote unavailable' });
}

});
