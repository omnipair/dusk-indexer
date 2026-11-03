/** Normalize decoded historical fields; preserve PublicKey/BN instances and all values. */
export function seniorLpFields<T>(value: T): T {
  if (Array.isArray(value)) {
    const items = value.map(seniorLpFields);
    return items.every((item,index) => item === value[index]) ? value : items as T;
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value;
  const names = new Set<string>();
  const entries: Array<[string,unknown]> = [];
  let changed = false;
  for (const [key, item] of Object.entries(value)) {
    const name = key.replace(/ylp/g, 'srlp').replace(/Ylp/g, 'Srlp').replace(/YLP/g, 'SRLP');
    if (names.has(name)) throw new Error('Conflicting senior LP fields');
    names.add(name);
    const normalized = seniorLpFields(item);
    changed ||= name !== key || normalized !== item;
    entries.push([name,normalized]);
  }
  return changed ? Object.fromEntries(entries) as T : value;
}
