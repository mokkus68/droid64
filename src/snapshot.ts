// Snapshots: capture and restore the state of the emulated machine.
// The machine is a graph of plain class instances; we copy their numeric, boolean and
// typed-array fields (skipping functions, ROMs and the media, which are saved separately)
// and later write them back into a machine built with the same configuration.

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const b64 = (u: Uint8Array) => {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const TYPED: Record<string, any> = { Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array };

function encodeTyped(v: ArrayBufferView): Json {
  const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return { $t: v.constructor.name, d: b64(bytes) };
}
function decodeTyped(j: { $t: string; d: string }): ArrayBufferView {
  const bytes = unb64(j.d);
  const C = TYPED[j.$t] ?? Uint8Array;
  return new C(bytes.buffer, 0, bytes.byteLength / (C.BYTES_PER_ELEMENT ?? 1));
}

/** Copy the state of an object graph. `skip` names fields never saved (back references, ROMs, media…). */
export function capture(obj: any, skip: Set<string>, seen = new WeakSet<object>()): Json {
  const out: { [k: string]: Json } = {};
  seen.add(obj);
  for (const key of Object.keys(obj)) {
    if (skip.has(key)) continue;
    const v = obj[key];
    const enc = encodeValue(v, skip, seen);
    if (enc !== undefined) out[key] = enc;
  }
  return out;
}

function encodeValue(v: any, skip: Set<string>, seen: WeakSet<object>): Json | undefined {
  if (v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v !== 'object') return undefined;            // functions, undefined
  if (ArrayBuffer.isView(v)) return encodeTyped(v);
  if (v instanceof Map || v instanceof Set || v instanceof WeakSet) return undefined;
  if (Array.isArray(v)) {
    const items = v.map((x) => encodeValue(x, skip, seen));
    return items.map((x) => (x === undefined ? null : x));
  }
  if (seen.has(v)) return undefined;                       // shared or cyclic reference
  return { $o: capture(v, skip, seen) };
}

/** Write captured state back into an object graph of the same shape. */
export function restore(obj: any, data: any) {
  for (const key of Object.keys(data)) {
    const val = data[key];
    const cur = obj[key];
    obj[key] = decodeInto(cur, val);
  }
}

function decodeInto(cur: any, val: any): any {
  if (val === null || typeof val !== 'object') {
    // keep live objects if the snapshot says "nothing" for a field that is an object now
    return typeof cur === 'object' && cur !== null && val === null ? null : val;
  }
  if (val.$t) {
    const arr = decodeTyped(val);
    if (cur && ArrayBuffer.isView(cur) && (cur as any).length === (arr as any).length) { (cur as any).set(arr); return cur; }
    return arr;
  }
  if (Array.isArray(val)) {
    if (Array.isArray(cur)) {
      for (let i = 0; i < val.length; i++) cur[i] = decodeInto(cur[i], val[i]);
      cur.length = val.length;
      return cur;
    }
    return val.map((x: any) => decodeInto(undefined, x));
  }
  if (val.$o) {
    if (cur && typeof cur === 'object') { restore(cur, val.$o); return cur; }
    return cur; // no live object to fill (configuration differs): leave it
  }
  return cur;
}

export { b64 as bytesToBase64, unb64 as base64ToBytes };

/** Small FNV-1a hash, used to tell whether a snapshot was taken with the same ROMs. */
export function fingerprint(...parts: (Uint8Array | null | undefined)[]): string {
  let h = 0x811c9dc5;
  for (const p of parts) {
    if (!p) { h = Math.imul(h ^ 0xff, 0x01000193); continue; }
    for (let i = 0; i < p.length; i++) h = Math.imul(h ^ p[i], 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ---- storage in IndexedDB (much larger than localStorage) ----
const DB = 'droid64';
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('snapshots', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = fn(db.transaction('snapshots', mode).objectStore('snapshots'));
    r.onsuccess = () => resolve(r.result as T);
    r.onerror = () => reject(r.error);
  });
}
export interface StoredSnapshot { id: string; created: number; title: string; thumb: string; size: number; data: string; }
export const listSnapshots = () => tx<StoredSnapshot[]>('readonly', (s) => s.getAll());
export const putSnapshot = (s: StoredSnapshot) => tx<IDBValidKey>('readwrite', (st) => st.put(s));
export const deleteSnapshot = (id: string) => tx<undefined>('readwrite', (st) => st.delete(id));
