/**
 * An in-memory stand-in for the parts of `firebase/firestore` the sync code uses,
 * faithful where it matters for correctness tests:
 *
 * - Reads return deep copies with object keys sorted (as Firestore does), so a
 *   checksum that depends on key order fails here the way it would for real.
 * - Writes reject `undefined`, and documents over 1 MiB, as Firestore does.
 * - Transactions are optimistic: if a document the callback read changed before
 *   commit, the callback re-runs (up to 5 attempts), like the real SDK.
 * - Queries support where / orderBy / limit on a top-level field.
 * - `interceptors` can delay or fail any operation to simulate races and outages.
 *
 * It does not evaluate security rules; those are tested against the real emulator.
 */

type Json = Record<string, unknown>;
type Op = "get" | "set" | "delete" | "query" | "commit" | "txGet" | "txCommit";
export type Interceptor = (op: Op, path: string) => void | Promise<void>;

interface Ref { path: string; id: string; kind: "doc" | "collection" }
interface Constraint { type: "where" | "orderBy" | "limit"; field?: string; op?: string; value?: unknown; dir?: "asc" | "desc"; n?: number }
interface QueryRef { kind: "query"; path: string; constraints: Constraint[] }

const MAX_DOC_BYTES = 1048576;

function assertStorable(value: unknown, where = "document"): void {
  if (value === undefined) throw new Error(`Function setDoc() called with invalid data. Unsupported field value: undefined (found in ${where})`);
  if (typeof value === "function") throw new Error(`Unsupported field value: a function (found in ${where})`);
  if (Array.isArray(value)) value.forEach((v, i) => assertStorable(v, `${where}[${i}]`));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) assertStorable(v, `${where}.${k}`);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys((value as Json)[k])]));
  }
  return value;
}

function deepMerge(target: Json, source: Json): Json {
  const out: Json = { ...target };
  for (const [k, v] of Object.entries(source)) {
    const existing = out[k];
    out[k] = v && typeof v === "object" && !Array.isArray(v) && existing && typeof existing === "object" && !Array.isArray(existing)
      ? deepMerge(existing as Json, v as Json)
      : v;
  }
  return out;
}

const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");

export class FakeFirestore {
  readonly docs = new Map<string, { data: Json; version: number }>();
  interceptors: Interceptor[] = [];
  readonly counters = { docReads: 0, docWrites: 0, docDeletes: 0, queries: 0, transactions: 0, txRetries: 0 };
  private listeners = new Set<{ path: string; next: (snap: unknown) => void }>();

  reset() {
    this.docs.clear();
    this.interceptors = [];
    this.listeners.clear();
    for (const k of Object.keys(this.counters) as Array<keyof typeof this.counters>) this.counters[k] = 0;
  }

  /** Paths (optionally under a prefix) currently stored, sorted. */
  paths(prefix = ""): string[] {
    return [...this.docs.keys()].filter((p) => p.startsWith(prefix)).sort();
  }

  /** Test helper: write without any hooks or validation. */
  seed(path: string, data: Json) {
    this.docs.set(path, { data: JSON.parse(JSON.stringify(data)) as Json, version: (this.docs.get(path)?.version ?? 0) + 1 });
    this.notify(path);
  }

  /** Test helper: change a stored document in place (simulates corruption). */
  mutate(path: string, fn: (data: Json) => void) {
    const entry = this.docs.get(path);
    if (!entry) throw new Error(`No document at ${path}`);
    fn(entry.data);
    entry.version++;
  }

  remove(path: string) {
    this.docs.delete(path);
    this.notify(path);
  }

  async intercept(op: Op, path: string) {
    for (const interceptor of this.interceptors) await interceptor(op, path);
  }

  snapshotOf(path: string) {
    const entry = this.docs.get(path);
    const ref: Ref = { path, id: path.split("/").pop()!, kind: "doc" };
    return {
      exists: () => entry !== undefined,
      data: () => (entry ? (sortKeys(JSON.parse(JSON.stringify(entry.data))) as Json) : undefined),
      id: ref.id,
      ref,
      metadata: { hasPendingWrites: false, fromCache: false },
    };
  }

  applySet(path: string, data: unknown, merge: boolean) {
    assertStorable(data);
    const plain = JSON.parse(JSON.stringify(data)) as Json;
    const next = merge ? deepMerge(this.docs.get(path)?.data ?? {}, plain) : plain;
    if (JSON.stringify(next).length > MAX_DOC_BYTES) throw new Error(`Document ${path} exceeds the 1 MiB size limit`);
    this.docs.set(path, { data: next, version: (this.docs.get(path)?.version ?? 0) + 1 });
    this.counters.docWrites++;
    this.notify(path);
  }

  applyDelete(path: string) {
    if (this.docs.delete(path)) this.counters.docDeletes++;
    this.notify(path);
  }

  notify(path: string) {
    for (const l of this.listeners) if (l.path === path) l.next(this.snapshotOf(path));
  }

  addListener(path: string, next: (snap: unknown) => void) {
    const entry = { path, next };
    this.listeners.add(entry);
    return () => this.listeners.delete(entry);
  }

  get listenerCount() {
    return this.listeners.size;
  }

  run(q: QueryRef) {
    let rows = [...this.docs.entries()].filter(([p]) => parentOf(p) === q.path);
    for (const c of q.constraints) {
      if (c.type === "where") {
        rows = rows.filter(([, v]) => {
          const x = v.data[c.field!] as number | string;
          const y = c.value as number | string;
          switch (c.op) {
            case "<": return x < y;
            case "<=": return x <= y;
            case ">": return x > y;
            case ">=": return x >= y;
            case "==": return x === y;
            default: throw new Error(`Unsupported operator ${c.op}`);
          }
        });
      }
    }
    for (const c of q.constraints.filter((k) => k.type === "orderBy").reverse()) {
      rows.sort(([, a], [, b]) => {
        const x = a.data[c.field!] as number | string;
        const y = b.data[c.field!] as number | string;
        return (x < y ? -1 : x > y ? 1 : 0) * (c.dir === "desc" ? -1 : 1);
      });
    }
    const limit = q.constraints.find((k) => k.type === "limit");
    if (limit) rows = rows.slice(0, limit.n);
    return rows;
  }
}

export const fake = new FakeFirestore();

const segments = (args: string[]) => args.join("/");

export const firestoreModule = {
  collection: (_db: unknown, ...parts: string[]): Ref => ({ path: segments(parts), id: parts[parts.length - 1]!, kind: "collection" }),
  doc: (_db: unknown, ...parts: string[]): Ref => ({ path: segments(parts), id: parts[parts.length - 1]!, kind: "doc" }),
  query: (collectionRef: Ref, ...constraints: Constraint[]): QueryRef => ({ kind: "query", path: collectionRef.path, constraints }),
  where: (field: string, op: string, value: unknown): Constraint => ({ type: "where", field, op, value }),
  orderBy: (field: string, dir: "asc" | "desc" = "asc"): Constraint => ({ type: "orderBy", field, dir }),
  limit: (n: number): Constraint => ({ type: "limit", n }),

  async getDoc(ref: Ref) {
    await fake.intercept("get", ref.path);
    fake.counters.docReads++;
    return fake.snapshotOf(ref.path);
  },
  async getDocs(q: QueryRef | Ref) {
    const queryRef: QueryRef = "constraints" in q ? q : { kind: "query", path: q.path, constraints: [] };
    await fake.intercept("query", queryRef.path);
    fake.counters.queries++;
    const rows = fake.run(queryRef);
    fake.counters.docReads += rows.length;
    const docs = rows.map(([path]) => fake.snapshotOf(path));
    return { empty: docs.length === 0, size: docs.length, docs, forEach: (cb: (d: unknown) => void) => docs.forEach(cb) };
  },
  async setDoc(ref: Ref, data: unknown, options?: { merge?: boolean }) {
    await fake.intercept("set", ref.path);
    fake.applySet(ref.path, data, options?.merge === true);
  },
  async deleteDoc(ref: Ref) {
    await fake.intercept("delete", ref.path);
    fake.applyDelete(ref.path);
  },
  writeBatch: () => {
    const ops: Array<{ type: "set" | "delete"; ref: Ref; data?: unknown; merge?: boolean }> = [];
    return {
      set(ref: Ref, data: unknown, options?: { merge?: boolean }) { ops.push({ type: "set", ref, data, merge: options?.merge === true }); },
      delete(ref: Ref) { ops.push({ type: "delete", ref }); },
      async commit() {
        if (ops.length > 500) throw new Error("A write batch can contain at most 500 writes");
        await fake.intercept("commit", ops[0]?.ref.path ?? "");
        for (const op of ops) {
          if (op.type === "set") assertStorable(op.data);
        }
        for (const op of ops) {
          if (op.type === "set") fake.applySet(op.ref.path, op.data, op.merge === true);
          else fake.applyDelete(op.ref.path);
        }
      },
    };
  },
  async runTransaction<T>(_db: unknown, update: (tx: unknown) => Promise<T>): Promise<T> {
    fake.counters.transactions++;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const reads = new Map<string, number>();
      const writes: Array<{ ref: Ref; data: unknown; merge: boolean }> = [];
      const tx = {
        async get(ref: Ref) {
          await fake.intercept("txGet", ref.path);
          reads.set(ref.path, fake.docs.get(ref.path)?.version ?? 0);
          fake.counters.docReads++;
          return fake.snapshotOf(ref.path);
        },
        set(ref: Ref, data: unknown, options?: { merge?: boolean }) { writes.push({ ref, data, merge: options?.merge === true }); return tx; },
      };
      const result = await update(tx);
      await fake.intercept("txCommit", writes[0]?.ref.path ?? "");
      const stale = [...reads].some(([path, version]) => (fake.docs.get(path)?.version ?? 0) !== version);
      if (stale) {
        fake.counters.txRetries++;
        continue;
      }
      for (const w of writes) assertStorable(w.data);
      for (const w of writes) fake.applySet(w.ref.path, w.data, w.merge);
      return result;
    }
    throw new Error("Transaction failed after 5 attempts (contention)");
  },
  onSnapshot(ref: Ref, next: (snap: unknown) => void) {
    const unsubscribe = fake.addListener(ref.path, next);
    queueMicrotask(() => next(fake.snapshotOf(ref.path)));
    return unsubscribe;
  },
};
