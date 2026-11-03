/** Encode canonical test inputs using the spelling of their exact historical IDL. */
export function seniorLpFixtureLayout<T extends { encode: (...args: any[]) => any; decode: (...args: any[]) => any }>(layout: T): T {
  const seen = new Set<object>();
  const historical = (value: unknown): boolean => {
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    return Object.entries(value).some(([key,item]) => key === 'property' && typeof item === 'string' && /ylp|Ylp/.test(item)
      || historical(item));
  };
  const legacy = historical(layout);
  const fields = (value: any, reverse = false): any => {
    if (Array.isArray(value)) return value.map(item => fields(item,reverse));
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value;
    const result: Record<string,unknown> = {};
    // Canonical values override neutral fields decoded from the historical schema.
    const entries = Object.entries(value).sort(([a],[b]) => Number(/srlp|Srlp/.test(a))-Number(/srlp|Srlp/.test(b)));
    for (const [key,item] of entries) {
      const name = reverse ? key.replace(/srlp/g,'ylp').replace(/Srlp/g,'Ylp')
        : key.replace(/ylp/g,'srlp').replace(/Ylp/g,'Srlp');
      result[name] = fields(item,reverse);
    }
    return result;
  };
  return new Proxy(layout, { get(target, property, receiver) {
    if (property === 'encode') return (value: unknown, ...args: any[]) => target.encode(fields(fields(value),legacy),...args);
    if (property === 'decode') return (...args: any[]) => fields(target.decode(...args));
    return Reflect.get(target,property,receiver);
  } });
}
