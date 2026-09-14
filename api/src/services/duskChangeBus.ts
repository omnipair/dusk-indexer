import { loadPinnedProtocol } from '../config/duskProtocol';

export type DuskReadChange = { kind: 'change' | 'resync' | 'unavailable'; sourceSlot: number };
const listeners = new Set<(change: DuskReadChange) => void>();

/** Database messages are invalidation hints; never forward their payloads. */
export function parseDuskReadChange(payload: string | undefined): DuskReadChange | null {
  if (!payload || payload.length > 8192) return null;
  let notice: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(payload);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    notice = value as Record<string, unknown>;
  } catch { return null; }
  const pin = loadPinnedProtocol();
  const program = [pin.dusk, pin.leverageDelegate].find(p => p.programId === notice.programId);
  const slot = notice.slot;
  if (!program || notice.cluster !== pin.cluster || notice.idlHash !== program.idlCanonicalSha256
    || notice.protocolRevision !== pin.revision || typeof slot !== 'number'
    || !Number.isSafeInteger(slot) || slot < pin.historyFirstSlot) return null;
  return { kind: 'change', sourceSlot: slot };
}

export function publishDuskReadChange(change: DuskReadChange): void {
  for (const listener of listeners) {
    try { listener(change); } catch { /* one closed client cannot stop invalidation */ }
  }
}

export function subscribeDuskReadChanges(listener: (change: DuskReadChange) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
