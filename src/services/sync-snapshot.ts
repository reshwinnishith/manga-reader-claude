import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  setDoc,
  where,
  writeBatch,
  type Firestore,
} from "firebase/firestore";
import type {
  LibraryEntry,
  ReaderMode,
  SavedTitle,
  SeriesProgress,
  UserData,
} from "@/domain/types";
import { USER_DATA_VERSION } from "@/domain/types";

/**
 * Immutable snapshot storage for cloud sync.
 *
 * Layout under users/{uid}:
 *   snapshots/{snapshotId}                 parent (and, for small libraries, all data)
 *   snapshots/{snapshotId}/parts/part_{i}  data partitions for large libraries
 *   sync/userData                          pointer: revision + activeSnapshotId + checksum
 *
 * Writers stage a complete snapshot, read it back and verify it, and only then
 * publish the pointer in a compare-and-swap transaction. Readers load only the
 * published snapshot and verify every part and the whole-snapshot checksum; if
 * that fails they recover from an earlier verified snapshot, and if none exists
 * they refuse (RemoteDataUnrecoverableError) rather than treat the remote as empty.
 */

/** 1 MiB hard limit for Cloud Firestore documents */
export const FIRESTORE_DOC_MAX_BYTES = 1048576;
/** 900 KiB safe threshold to protect against Firestore 1 MiB document limit */
export const FIRESTORE_DOC_SAFE_LIMIT_BYTES = 900 * 1024;
/** 500 KiB maximum safe size for individual records to prevent single-record document exhaustion */
export const FIRESTORE_RECORD_SAFE_LIMIT_BYTES = 500 * 1024;
export const MAX_BATCH_OPERATIONS = 400;
/** Snapshots this many revisions behind the active one are kept for recovery. */
export const RETAINED_REVISIONS = 2;
const PRUNE_BATCH_SIZE = 20;
const RECOVERY_CANDIDATES = 5;

export interface SnapshotManifest {
  totalLibrary: number;
  totalProgress: number;
  totalSavedTitles: number;
  snapshotBytes: number;
}

export interface StagedSnapshotDoc {
  snapshotId: string;
  revision: number;
  createdAt: string;
  isComplete: boolean;
  version: number;
  checksum?: string;
  totalParts?: number;
  library?: Record<string, LibraryEntry>;
  progress?: Record<string, SeriesProgress>;
  readerModes?: Record<string, ReaderMode>;
  readerModeTimes?: Record<string, string>;
  savedTitles?: Record<string, SavedTitle>;
  tombstones?: Record<string, string>;
  seeded?: boolean;
}

export interface StagedSnapshotPartDoc {
  partId: string;
  snapshotId: string;
  partIndex: number;
  totalParts: number;
  library?: Record<string, LibraryEntry>;
  progress?: Record<string, SeriesProgress>;
  savedTitles?: Record<string, SavedTitle>;
  checksum?: string;
  createdAt: string;
}

/** Another writer published first; the caller re-reads, re-merges and retries. */
export class RevisionConflictError extends Error {
  constructor(expected: number, actual: number) {
    super(`Revision conflict: expected revision ${expected}, but server is at ${actual}`);
    this.name = "RevisionConflictError";
  }
}

/** A snapshot failed verification (missing, incomplete, wrong checksum or parts). */
export class SnapshotVerificationError extends Error {
  constructor(public readonly snapshotId: string, public readonly reason: string) {
    super(`Snapshot '${snapshotId}' failed verification: ${reason}`);
    this.name = "SnapshotVerificationError";
  }
}

/**
 * The remote copy exists but cannot be read safely. Sync must stop: nothing is
 * published and local data is left exactly as it is.
 */
export class RemoteDataUnrecoverableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteDataUnrecoverableError";
  }
}

// ---- Size, canonical form and checksums ---------------------------------------

/** UTF-8 byte size of serialized JSON; unserializable data counts as too large. */
export function estimateDataSize(data: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(data)).length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** JSON with sorted keys and no `undefined`, identical wherever it is produced. */
export function canonicalStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): string => {
    if (v === null) return "null";
    switch (typeof v) {
      case "string":
        return JSON.stringify(v);
      case "number":
        return Number.isFinite(v) ? String(v) : "null";
      case "boolean":
        return v ? "true" : "false";
      case "object": {
        if (seen.has(v)) throw new Error("Cannot serialize circular data");
        seen.add(v);
        let out: string;
        if (Array.isArray(v)) {
          out = `[${v.map((item) => (item === undefined ? "null" : walk(item))).join(",")}]`;
        } else {
          const record = v as Record<string, unknown>;
          out = `{${Object.keys(record)
            .filter((k) => record[k] !== undefined && typeof record[k] !== "function")
            .sort()
            .map((k) => `${JSON.stringify(k)}:${walk(record[k])}`)
            .join(",")}}`;
        }
        seen.delete(v);
        return out;
      }
      default:
        return "null";
    }
  };
  return walk(value);
}

/** Firestore rejects `undefined` and returns map keys sorted; store plain JSON. */
export function toPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 in plain JS, used only where `crypto.subtle` is unavailable (insecure contexts). */
function sha256Fallback(message: string): string {
  const bytes = new TextEncoder().encode(message);
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as number[];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25);
      const ch = (e! & f!) ^ (~e! & g!);
      const t1 = (hh! + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22);
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d! + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i++) h[i] = (h[i]! + next[i]!) >>> 0;
  }
  return Array.from(h, (n) => n.toString(16).padStart(8, "0")).join("");
}

/** SHA-256 (hex) of the canonical form of `data`. */
export async function computeDataChecksum(data: unknown): Promise<string> {
  const text = canonicalStringify(data);
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return sha256Fallback(text);
}

export interface SnapshotPayload {
  library: Record<string, LibraryEntry>;
  progress: Record<string, SeriesProgress>;
  readerModes: Record<string, ReaderMode>;
  readerModeTimes: Record<string, string>;
  savedTitles: Record<string, SavedTitle>;
  tombstones: Record<string, string>;
  seeded: boolean;
}

interface PartPayload {
  library: Record<string, LibraryEntry>;
  progress: Record<string, SeriesProgress>;
  savedTitles: Record<string, SavedTitle>;
}

/** Everything a snapshot stores, with defaults filled so write and read agree. */
export function buildSnapshotPayload(data: UserData): SnapshotPayload {
  return toPlain({
    library: data.library,
    progress: data.progress,
    readerModes: data.readerModes,
    readerModeTimes: data.readerModeTimes || {},
    savedTitles: data.savedTitles,
    tombstones: data.tombstones || {},
    seeded: Boolean(data.seeded),
  });
}

export function payloadToUserData(payload: SnapshotPayload): UserData {
  return {
    version: USER_DATA_VERSION,
    library: payload.library,
    progress: payload.progress,
    readerModes: payload.readerModes,
    ...(Object.keys(payload.readerModeTimes).length > 0 ? { readerModeTimes: payload.readerModeTimes } : {}),
    savedTitles: payload.savedTitles,
    tombstones: payload.tombstones,
    seeded: payload.seeded,
  };
}

/**
 * Validates document and record size guards before any Firestore write.
 * Ensures manifest metadata and individual records never exceed size bounds.
 */
export function validateRecordSizeGuards(data: UserData): void {
  const manifestProbe = {
    version: USER_DATA_VERSION,
    readerModes: data.readerModes,
    readerModeTimes: data.readerModeTimes,
    tombstones: data.tombstones,
    seeded: data.seeded,
  };
  if (estimateDataSize(manifestProbe) > FIRESTORE_DOC_SAFE_LIMIT_BYTES) {
    throw new Error("Manifest metadata exceeds Firestore safe document size limit.");
  }
  const check = (kind: string, records: Record<string, unknown>) => {
    for (const [id, record] of Object.entries(records)) {
      if (estimateDataSize(record) > FIRESTORE_RECORD_SAFE_LIMIT_BYTES) {
        throw new Error(`${kind} record '${id}' exceeds safe record size limit (${FIRESTORE_RECORD_SAFE_LIMIT_BYTES} bytes).`);
      }
    }
  };
  check("Library", data.library);
  check("Progress", data.progress);
  check("Saved title", data.savedTitles);
}

let clientSessionId =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

export function getClientSessionId(): string {
  return clientSessionId;
}

export function setClientSessionId(id: string): void {
  clientSessionId = id;
}

/** Unique snapshot ID scoped by revision and session; snapshots are never rewritten. */
export function generateSnapshotId(revision: number, sessionId = clientSessionId): string {
  const cleanSession = sessionId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  // The random tail keeps two snapshots staged in the same millisecond by one session distinct.
  const nonce = Math.random().toString(36).slice(2, 8);
  return `rev_${revision}_${cleanSession}_${Date.now()}_${nonce}`;
}

// ---- Batched deletes/writes -----------------------------------------------------

export interface ChunkedOperation {
  type: "set" | "delete";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ref: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options?: any;
}

/** Commits writes in chunks of <= 400 operations, under the 500 batch limit. */
export async function commitChunkedBatches(
  db: Firestore,
  operations: ChunkedOperation[],
  batchLimit = MAX_BATCH_OPERATIONS,
): Promise<void> {
  for (let i = 0; i < operations.length; i += batchLimit) {
    const batch = writeBatch(db);
    for (const op of operations.slice(i, i + batchLimit)) {
      if (op.type === "set") batch.set(op.ref, op.data, op.options);
      else batch.delete(op.ref);
    }
    await batch.commit();
  }
}

const snapshotRef = (db: Firestore, uid: string, snapshotId: string) => doc(db, "users", uid, "snapshots", snapshotId);
const partRef = (db: Firestore, uid: string, snapshotId: string, index: number) =>
  doc(db, "users", uid, "snapshots", snapshotId, "parts", `part_${index}`);

/** Deletes a snapshot's parts and then the snapshot itself (Firestore never cascades). */
export async function deleteSnapshotTree(db: Firestore, user: { uid: string }, snapshotId: string, totalParts: number): Promise<void> {
  const operations: ChunkedOperation[] = [];
  if (totalParts > 1) {
    for (let i = 0; i < totalParts; i++) operations.push({ type: "delete", ref: partRef(db, user.uid, snapshotId, i) });
  }
  operations.push({ type: "delete", ref: snapshotRef(db, user.uid, snapshotId) });
  await commitChunkedBatches(db, operations);
}

// ---- Staging --------------------------------------------------------------------

/**
 * Splits records into parts of at most the safe limit in one pass. Each record
 * is measured once and a running size is kept, so the cost is linear.
 */
export function partitionPayload(payload: SnapshotPayload): PartPayload[] {
  const empty = (): PartPayload => ({ library: {}, progress: {}, savedTitles: {} });
  const baseBytes = estimateDataSize(empty());
  const parts: PartPayload[] = [];
  let current = empty();
  let currentBytes = baseBytes;
  let currentCount = 0;
  const add = <K extends keyof PartPayload>(kind: K, id: string, value: PartPayload[K][string]) => {
    // key + quotes + colon + comma on top of the serialized value
    const bytes = estimateDataSize(value) + estimateDataSize(id) + 2;
    if (currentCount > 0 && currentBytes + bytes > FIRESTORE_DOC_SAFE_LIMIT_BYTES) {
      parts.push(current);
      current = empty();
      currentBytes = baseBytes;
      currentCount = 0;
    }
    (current[kind] as Record<string, unknown>)[id] = value;
    currentBytes += bytes;
    currentCount++;
  };
  for (const [id, value] of Object.entries(payload.library)) add("library", id, value);
  for (const [id, value] of Object.entries(payload.progress)) add("progress", id, value);
  for (const [id, value] of Object.entries(payload.savedTitles)) add("savedTitles", id, value);
  if (currentCount > 0 || parts.length === 0) parts.push(current);
  return parts;
}

/**
 * Stages an immutable snapshot, then reads it back and verifies checksums before
 * returning, so only a verified snapshot can ever be published. If anything fails
 * the staged documents are removed (best effort) and the error is rethrown.
 */
export async function stageAndVerifySnapshot(
  db: Firestore,
  user: { uid: string },
  targetRevision: number,
  data: UserData,
): Promise<{ snapshotId: string; checksum: string; totalParts: number }> {
  validateRecordSizeGuards(data);

  const snapshotId = generateSnapshotId(targetRevision);
  const now = new Date().toISOString();
  const payload = buildSnapshotPayload(data);
  const checksum = await computeDataChecksum(payload);
  let written = 0;
  let totalParts = 1;

  try {
    if (estimateDataSize(payload) <= FIRESTORE_DOC_SAFE_LIMIT_BYTES) {
      const snapDoc: StagedSnapshotDoc = {
        snapshotId,
        revision: targetRevision,
        createdAt: now,
        isComplete: true,
        version: USER_DATA_VERSION,
        checksum,
        totalParts: 1,
        ...payload,
      };
      await setDoc(snapshotRef(db, user.uid, snapshotId), snapDoc);
    } else {
      const parts = partitionPayload(payload);
      totalParts = parts.length;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        const partDoc: StagedSnapshotPartDoc = {
          partId: `part_${i}`,
          snapshotId,
          partIndex: i,
          totalParts,
          ...part,
          checksum: await computeDataChecksum(part),
          createdAt: now,
        };
        if (estimateDataSize(partDoc) > FIRESTORE_DOC_SAFE_LIMIT_BYTES) {
          throw new Error(`Snapshot part ${i} exceeds the safe document size.`);
        }
        await setDoc(partRef(db, user.uid, snapshotId, i), partDoc);
        written = i + 1;
      }
      const parent: StagedSnapshotDoc = {
        snapshotId,
        revision: targetRevision,
        createdAt: now,
        isComplete: true,
        version: USER_DATA_VERSION,
        checksum,
        totalParts,
        readerModes: payload.readerModes,
        readerModeTimes: payload.readerModeTimes,
        tombstones: payload.tombstones,
        seeded: payload.seeded,
      };
      await setDoc(snapshotRef(db, user.uid, snapshotId), parent);
    }
    written = Math.max(written, 1);
    // Read-back verification before publication: parts, whole checksum, completeness.
    await readVerifiedSnapshot(db, user, snapshotId, { checksum, parts: totalParts });
    return { snapshotId, checksum, totalParts };
  } catch (error) {
    await deleteSnapshotTree(db, user, snapshotId, Math.max(totalParts, written)).catch(() => undefined);
    throw error;
  }
}

// ---- Verified reads and recovery ------------------------------------------------

export interface VerifiedSnapshot {
  data: UserData;
  snapshot: StagedSnapshotDoc;
}

/**
 * Reads a snapshot and proves it is whole: parent complete, every expected part
 * present and consistent, each part checksum and the assembled checksum correct.
 */
export async function readVerifiedSnapshot(
  db: Firestore,
  user: { uid: string },
  snapshotId: string,
  expected: { checksum?: string; parts?: number } = {},
): Promise<VerifiedSnapshot> {
  const fail = (reason: string): never => {
    throw new SnapshotVerificationError(snapshotId, reason);
  };
  const parentSnap = await getDoc(snapshotRef(db, user.uid, snapshotId));
  if (!parentSnap.exists()) return fail("snapshot document is missing");
  const parent = parentSnap.data() as StagedSnapshotDoc;
  if (parent.isComplete !== true) return fail("snapshot is not marked complete");
  if (typeof parent.version === "number" && parent.version > USER_DATA_VERSION) {
    throw new RemoteVersionError(parent.version);
  }
  if (typeof parent.checksum !== "string" || parent.checksum.length === 0) return fail("snapshot has no checksum");
  if (expected.checksum !== undefined && parent.checksum !== expected.checksum) return fail("checksum differs from the published pointer");
  const totalParts = typeof parent.totalParts === "number" && parent.totalParts >= 1 ? parent.totalParts : 1;
  if (expected.parts !== undefined && totalParts !== expected.parts) return fail("part count differs from the published pointer");

  let library = parent.library || {};
  let progress = parent.progress || {};
  let savedTitles = parent.savedTitles || {};
  if (totalParts > 1) {
    const reads = await Promise.all(Array.from({ length: totalParts }, (_, i) => getDoc(partRef(db, user.uid, snapshotId, i))));
    for (let i = 0; i < reads.length; i++) {
      const read = reads[i]!;
      if (!read.exists()) return fail(`part_${i} is missing`);
      const part = read.data() as StagedSnapshotPartDoc;
      if (part.snapshotId !== snapshotId || part.partIndex !== i || part.totalParts !== totalParts) {
        return fail(`part_${i} does not belong to this snapshot`);
      }
      const partPayload: PartPayload = { library: part.library || {}, progress: part.progress || {}, savedTitles: part.savedTitles || {} };
      if ((await computeDataChecksum(partPayload)) !== part.checksum) return fail(`part_${i} checksum mismatch`);
      library = { ...library, ...partPayload.library };
      progress = { ...progress, ...partPayload.progress };
      savedTitles = { ...savedTitles, ...partPayload.savedTitles };
    }
  }

  const payload: SnapshotPayload = {
    library,
    progress,
    readerModes: parent.readerModes || {},
    readerModeTimes: parent.readerModeTimes || {},
    savedTitles,
    tombstones: parent.tombstones || {},
    seeded: parent.seeded === true,
  };
  if ((await computeDataChecksum(payload)) !== parent.checksum) return fail("assembled data does not match its checksum");
  return { data: payloadToUserData(payload), snapshot: parent };
}

/** The remote data was written by a newer app version; do not read or overwrite it. */
export class RemoteVersionError extends RemoteDataUnrecoverableError {
  constructor(public readonly remoteVersion: number) {
    super(`Cloud data was saved by a newer version of the app (data version ${remoteVersion}). Update the app to sync.`);
    this.name = "RemoteVersionError";
  }
}

export interface RemoteState {
  /** null when nothing has ever been published for this user. */
  data: UserData | null;
  revision: number;
  activeSnapshotId?: string;
  /** Set when the active snapshot failed verification and an earlier one was used. */
  recoveredFrom?: { snapshotId: string; reason: string };
}

interface SyncPointer {
  revision?: number;
  activeSnapshotId?: string;
  snapshotChecksum?: string;
  snapshotParts?: number;
  library?: Record<string, LibraryEntry>;
  progress?: Record<string, SeriesProgress>;
  readerModes?: Record<string, ReaderMode>;
  savedTitles?: Record<string, SavedTitle>;
  tombstones?: Record<string, string>;
  seeded?: boolean;
}

/**
 * Loads the verified remote state. Never returns partial data: it returns the
 * active snapshot, else the newest earlier verified snapshot (reporting the
 * recovery), else throws RemoteDataUnrecoverableError.
 */
export async function loadRemoteState(db: Firestore, user: { uid: string }): Promise<RemoteState> {
  const pointerSnap = await getDoc(doc(db, "users", user.uid, "sync", "userData"));
  if (!pointerSnap.exists()) return { data: null, revision: 0 };
  const pointer = pointerSnap.data() as SyncPointer;
  const revision = typeof pointer.revision === "number" ? pointer.revision : 0;
  const activeSnapshotId = pointer.activeSnapshotId;

  if (!activeSnapshotId) {
    // Pre-snapshot documents stored data inline.
    if (pointer.library || pointer.progress) {
      return {
        data: {
          version: USER_DATA_VERSION,
          library: pointer.library || {},
          progress: pointer.progress || {},
          readerModes: pointer.readerModes || {},
          savedTitles: pointer.savedTitles || {},
          tombstones: pointer.tombstones || {},
          seeded: pointer.seeded === true,
        },
        revision,
      };
    }
    return { data: null, revision };
  }

  let failure: unknown;
  try {
    const { data } = await readVerifiedSnapshot(db, user, activeSnapshotId, {
      checksum: pointer.snapshotChecksum,
      parts: pointer.snapshotParts,
    });
    return { data, revision, activeSnapshotId };
  } catch (error) {
    if (error instanceof RemoteVersionError || !(error instanceof SnapshotVerificationError)) throw error;
    failure = error;
  }

  const reason = failure instanceof Error ? failure.message : String(failure);
  const candidates = await getDocs(
    query(collection(db, "users", user.uid, "snapshots"), where("revision", "<=", revision), orderBy("revision", "desc"), limit(RECOVERY_CANDIDATES + 1)),
  );
  const ids: Array<{ id: string; revision: number; createdAt: string }> = [];
  candidates.forEach((d) => {
    const snap = d.data() as StagedSnapshotDoc;
    if (d.id !== activeSnapshotId && snap.isComplete === true) {
      ids.push({ id: d.id, revision: snap.revision, createdAt: snap.createdAt || "" });
    }
  });
  ids.sort((a, b) => b.revision - a.revision || b.createdAt.localeCompare(a.createdAt));
  for (const candidate of ids.slice(0, RECOVERY_CANDIDATES)) {
    try {
      const { data } = await readVerifiedSnapshot(db, user, candidate.id);
      return { data, revision, recoveredFrom: { snapshotId: candidate.id, reason } };
    } catch (error) {
      if (error instanceof RemoteVersionError) throw error;
      // try the next older candidate
    }
  }
  throw new RemoteDataUnrecoverableError(
    `Cloud data could not be read safely: ${reason}. No earlier verified snapshot was found. Nothing was changed; your local data is untouched.`,
  );
}

// ---- Pruning --------------------------------------------------------------------

/**
 * Deletes snapshots older than the retained window, including their parts, using
 * one filtered query: only obsolete snapshots are read (never the active or
 * recent ones). The active snapshot is never deleted. Returns how many were removed.
 */
export async function pruneObsoleteSnapshots(
  db: Firestore,
  user: { uid: string },
  currentRevision: number,
  activeSnapshotId: string,
): Promise<number> {
  try {
    const keepFrom = Math.max(currentRevision - RETAINED_REVISIONS, 0);
    const obsolete = await getDocs(
      query(collection(db, "users", user.uid, "snapshots"), where("revision", "<", keepFrom), limit(PRUNE_BATCH_SIZE)),
    );
    if (obsolete.empty) return 0;
    // Pruning runs in the background, so the caller's view may be stale: another device can have
    // published (or re-pointed) since. Re-read the pointer now; protect whatever it names and never
    // retain less than the more conservative (lower) of the two revisions.
    const protectedIds = new Set<string>([activeSnapshotId]);
    let safeFrom = keepFrom;
    const pointer = await getDoc(doc(db, "users", user.uid, "sync", "userData"));
    if (pointer.exists()) {
      const live = pointer.data() as { activeSnapshotId?: unknown; revision?: unknown };
      if (typeof live.activeSnapshotId === "string") protectedIds.add(live.activeSnapshotId);
      if (typeof live.revision === "number") safeFrom = Math.min(safeFrom, Math.max(live.revision - RETAINED_REVISIONS, 0));
    }
    let removed = 0;
    // One snapshot (its parts and itself) per atomic batch: if the rules refuse one because it became
    // active in the meantime, or it is already gone, the others are still cleaned up.
    for (const d of obsolete.docs) {
      const snap = d.data() as StagedSnapshotDoc;
      if (protectedIds.has(d.id) || (typeof snap.revision === "number" && snap.revision >= safeFrom)) continue;
      const parts = typeof snap.totalParts === "number" ? snap.totalParts : 1;
      try {
        await deleteSnapshotTree(db, user, d.id, parts);
        removed++;
      } catch (error) {
        console.warn(`Obsolete snapshot ${d.id} was not pruned (it will be retried later):`, error);
      }
    }
    return removed;
  } catch (error) {
    console.warn("Obsolete snapshot pruning skipped or failed:", error);
    return 0;
  }
}
