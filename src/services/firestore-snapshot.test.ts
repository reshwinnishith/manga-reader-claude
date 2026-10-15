import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { USER_DATA_VERSION } from "@/domain/types";
import { emptyUserData } from "@/lib/user-data";
import { fake } from "@/test/fake-firestore";
import { DB, TEST_USER, library } from "@/test/sync-fixtures";

vi.mock("firebase/firestore", async () => (await import("@/test/fake-firestore")).firestoreModule);
vi.mock("./firebase-config", () => ({ isFirebaseConfigured: () => true, getFirebaseConfigFromEnv: () => ({}) }));
vi.mock("./firebase", () => ({ getFirebaseFirestore: () => ({}), getFirebaseAuth: () => ({}) }));
vi.mock("./firebase-auth", () => ({ ensureAnonymousUser: async () => TEST_USER, subscribeToAuthState: () => () => undefined, getCurrentUser: () => TEST_USER }));

import {
  FIRESTORE_DOC_SAFE_LIMIT_BYTES,
  FirestoreSyncService,
  RemoteDataUnrecoverableError,
  RemoteVersionError,
  RevisionConflictError,
  SnapshotVerificationError,
  buildSnapshotPayload,
  canonicalStringify,
  computeDataChecksum,
  estimateDataSize,
  loadRemoteState,
  mergeUserData,
  partitionPayload,
  pruneObsoleteSnapshots,
  readVerifiedSnapshot,
  stageAndVerifySnapshot,
} from "./firestore-sync";

const SNAP = "users/u1/snapshots";
const POINTER = "users/u1/sync/userData";
const snapshotIds = () => fake.paths(`${SNAP}/`).filter((p) => p.split("/").length === 4).map((p) => p.split("/")[3]!);
const partPaths = () => fake.paths(`${SNAP}/`).filter((p) => p.includes("/parts/"));
const big = (n = 900) => library(n, 0, 3000); // several MiB: forces multi-part snapshots

let service: FirestoreSyncService;
beforeEach(() => {
  fake.reset();
  service = new FirestoreSyncService();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("verified snapshots", () => {
  it("round-trips a small library through sorted-key storage", async () => {
    const data = library(5);
    const staged = await stageAndVerifySnapshot(DB, TEST_USER, 1, data);
    expect(staged.totalParts).toBe(1);
    const { data: read } = await readVerifiedSnapshot(DB, TEST_USER, staged.snapshotId, { checksum: staged.checksum, parts: 1 });
    expect(canonicalStringify(read)).toBe(canonicalStringify({ ...data, readerModeTimes: undefined }));
  });

  it("splits large libraries into parts under the safe limit and reassembles them exactly", async () => {
    const data = big();
    expect(estimateDataSize(buildSnapshotPayload(data))).toBeGreaterThan(FIRESTORE_DOC_SAFE_LIMIT_BYTES * 2);
    const staged = await stageAndVerifySnapshot(DB, TEST_USER, 1, data);
    expect(staged.totalParts).toBeGreaterThan(2);
    expect(partPaths()).toHaveLength(staged.totalParts);
    for (const path of partPaths()) expect(estimateDataSize(fake.docs.get(path)!.data)).toBeLessThanOrEqual(FIRESTORE_DOC_SAFE_LIMIT_BYTES);
    const parent = fake.docs.get(`${SNAP}/${staged.snapshotId}`)!.data;
    expect(parent.library).toBeUndefined(); // bulk data lives only in the parts
    const { data: read } = await readVerifiedSnapshot(DB, TEST_USER, staged.snapshotId, { checksum: staged.checksum, parts: staged.totalParts });
    expect(Object.keys(read.library)).toHaveLength(900);
    expect(canonicalStringify(read.savedTitles)).toBe(canonicalStringify(data.savedTitles));
  });

  it("partitions in linear time", () => {
    const payload = buildSnapshotPayload(library(6000, 0, 2500));
    const started = performance.now();
    const parts = partitionPayload(payload);
    const elapsed = performance.now() - started;
    expect(parts.length).toBeGreaterThan(10);
    expect(parts.reduce((n, p) => n + Object.keys(p.savedTitles).length, 0)).toBe(6000);
    // The previous approach re-serialised the growing part for every record: ~6 s for this input.
    expect(elapsed).toBeLessThan(1500);
  });

  it("checksums with SHA-256 even where crypto.subtle is unavailable", async () => {
    const value = { b: [1, 2, { z: 1, a: undefined }], a: "é" };
    const expected = createHash("sha256").update(canonicalStringify(value)).digest("hex");
    expect(await computeDataChecksum(value)).toBe(expected);
    vi.stubGlobal("crypto", { randomUUID: () => "x" });
    try {
      expect(await computeDataChecksum(value)).toBe(expected);
      expect(await computeDataChecksum("x".repeat(1000))).toBe(createHash("sha256").update(canonicalStringify("x".repeat(1000))).digest("hex"));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  describe("every kind of corruption is detected on read", () => {
    const stageMulti = async () => {
      const staged = await stageAndVerifySnapshot(DB, TEST_USER, 1, big(400));
      expect(staged.totalParts).toBeGreaterThan(1);
      return staged;
    };
    const expectRejected = async (id: string, reason: RegExp, expected = {}) => {
      const error = await readVerifiedSnapshot(DB, TEST_USER, id, expected).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SnapshotVerificationError);
      expect((error as Error).message).toMatch(reason);
    };

    it("a missing part", async () => {
      const s = await stageMulti();
      fake.remove(`${SNAP}/${s.snapshotId}/parts/part_1`);
      await expectRejected(s.snapshotId, /part_1 is missing/);
    });
    it("a part whose content changed", async () => {
      const s = await stageMulti();
      fake.mutate(`${SNAP}/${s.snapshotId}/parts/part_0`, (d) => { delete (d.library as Record<string, unknown>)[Object.keys(d.library as object)[0]!]; });
      await expectRejected(s.snapshotId, /part_0 checksum mismatch/);
    });
    it("a part from another snapshot or position", async () => {
      const s = await stageMulti();
      fake.mutate(`${SNAP}/${s.snapshotId}/parts/part_1`, (d) => { d.partIndex = 0; });
      await expectRejected(s.snapshotId, /does not belong/);
    });
    it("changed parent metadata (reader modes, tombstones)", async () => {
      const s = await stageMulti();
      fake.mutate(`${SNAP}/${s.snapshotId}`, (d) => { d.tombstones = { gone: "2026-10-01T00:00:00.000Z" }; });
      await expectRejected(s.snapshotId, /assembled data does not match its checksum/);
    });
    it("changed content of a single-document snapshot", async () => {
      const s = await stageAndVerifySnapshot(DB, TEST_USER, 1, library(3));
      fake.mutate(`${SNAP}/${s.snapshotId}`, (d) => { (d.library as Record<string, { status: string }>)["al-1"]!.status = "dropped"; });
      await expectRejected(s.snapshotId, /does not match its checksum/);
    });
    it("a snapshot not marked complete, with no checksum, or missing", async () => {
      const s = await stageAndVerifySnapshot(DB, TEST_USER, 1, library(3));
      fake.mutate(`${SNAP}/${s.snapshotId}`, (d) => { d.isComplete = false; });
      await expectRejected(s.snapshotId, /not marked complete/);
      fake.mutate(`${SNAP}/${s.snapshotId}`, (d) => { d.isComplete = true; delete d.checksum; });
      await expectRejected(s.snapshotId, /no checksum/);
      fake.remove(`${SNAP}/${s.snapshotId}`);
      await expectRejected(s.snapshotId, /missing/);
    });
    it("a pointer that disagrees about checksum or part count", async () => {
      const s = await stageMulti();
      await expectRejected(s.snapshotId, /differs from the published pointer/, { checksum: "0".repeat(64) });
      await expectRejected(s.snapshotId, /part count differs/, { parts: s.totalParts + 1 });
    });
  });

  it("refuses data written by a newer app version instead of reading or overwriting it", async () => {
    const s = await stageAndVerifySnapshot(DB, TEST_USER, 1, library(2));
    fake.mutate(`${SNAP}/${s.snapshotId}`, (d) => { d.version = USER_DATA_VERSION + 1; });
    await expect(readVerifiedSnapshot(DB, TEST_USER, s.snapshotId)).rejects.toBeInstanceOf(RemoteVersionError);
  });

  it("cleans up everything it staged when a part write fails, and publishes nothing", async () => {
    let parts = 0;
    fake.interceptors.push((op, path) => {
      if (op === "set" && path.includes("/parts/") && ++parts === 2) throw new Error("network down");
    });
    await expect(stageAndVerifySnapshot(DB, TEST_USER, 1, big(900))).rejects.toThrow("network down");
    expect(parts).toBe(2); // the first part really was written before the failure
    expect(fake.paths(`${SNAP}/`)).toEqual([]);
    expect(fake.docs.has(POINTER)).toBe(false);
  });

  it("refuses to return a snapshot that fails its read-back, and removes it", async () => {
    fake.interceptors.push((op, path) => {
      if (op === "get" && path.startsWith(`${SNAP}/rev_1_`) && !path.includes("/parts/")) {
        fake.mutate(path, (d) => { (d.library as Record<string, { status: string }>)["al-0"]!.status = "dropped"; });
      }
    });
    await expect(stageAndVerifySnapshot(DB, TEST_USER, 1, library(3))).rejects.toBeInstanceOf(SnapshotVerificationError);
    expect(fake.paths(`${SNAP}/`)).toEqual([]);
  });
});

describe("recovery from a corrupt active snapshot", () => {
  const push = (data = library(3)) => service.atomicSyncOrPush(DB, TEST_USER, data);
  const active = () => fake.docs.get(POINTER)!.data.activeSnapshotId as string;
  const corrupt = (id: string) => fake.mutate(`${SNAP}/${id}`, (d) => { (d.library as Record<string, { status: string }>)[Object.keys(d.library as object)[0]!]!.status = "dropped"; });

  it("falls back to the newest earlier verified snapshot and reports it", async () => {
    await push(library(2));
    const first = active();
    await push(library(4));
    const second = active();
    corrupt(second);
    const state = await loadRemoteState(DB, TEST_USER);
    expect(state.recoveredFrom?.snapshotId).toBe(first);
    expect(state.recoveredFrom?.reason).toMatch(/does not match its checksum/);
    expect(Object.keys(state.data!.library)).toHaveLength(2);
  });

  it("skips corrupt earlier snapshots too, and a healing sync keeps local data and publishes a verified snapshot", async () => {
    await push(library(2));
    const first = active();
    await push(library(3));
    const second = active();
    await push(library(4));
    const third = active();
    corrupt(third);
    corrupt(second);
    const local = library(6, 10); // other titles read on this device
    const merged = await push(mergeUserData(local, null));
    expect(service["takeRecovery"]()?.snapshotId).toBe(first);
    expect(Object.keys(merged.library).sort()).toEqual(["al-0", "al-1", "al-10", "al-11", "al-12", "al-13", "al-14", "al-15"]);
    const healed = await loadRemoteState(DB, TEST_USER);
    expect(healed.recoveredFrom).toBeUndefined();
    expect(healed.activeSnapshotId).not.toBe(third);
    expect(Object.keys(healed.data!.library)).toHaveLength(8);
  });

  it("refuses, publishes nothing and leaves local data untouched when no snapshot can be verified", async () => {
    await push(library(2));
    await push(library(3));
    for (const id of snapshotIds()) corrupt(id);
    const before = canonicalStringify([...fake.docs.entries()]);

    await expect(loadRemoteState(DB, TEST_USER)).rejects.toBeInstanceOf(RemoteDataUnrecoverableError);
    const local = library(5, 50);
    const localBefore = canonicalStringify(local);
    await expect(service.atomicSyncOrPush(DB, TEST_USER, local)).rejects.toBeInstanceOf(RemoteDataUnrecoverableError);
    expect(canonicalStringify(local)).toBe(localBefore);
    expect(canonicalStringify([...fake.docs.entries()])).toBe(before); // nothing written, nothing deleted

    const listener = vi.fn();
    service.subscribeMerged(listener);
    localStorage.setItem("manga-reader:v1:cloud-sync-enabled", "true");
    const outcome = await service.syncNow(() => local);
    expect(outcome.ok).toBe(false);
    expect(outcome.data).toBe(local);
    expect(listener).not.toHaveBeenCalled();
    expect(service.getStatus()).toBe("error");
    expect(service.getNotice()).toMatch(/could not be read safely/);
    expect(canonicalStringify([...fake.docs.entries()])).toBe(before);
  });

  it("does not mistake a missing active snapshot for an empty remote", async () => {
    await push(library(2));
    fake.remove(`${SNAP}/${active()}`);
    await expect(loadRemoteState(DB, TEST_USER)).rejects.toBeInstanceOf(RemoteDataUnrecoverableError);
    await expect(push(library(1, 90))).rejects.toBeInstanceOf(RemoteDataUnrecoverableError);
    expect(snapshotIds()).toEqual([]); // no replacement was published from local data alone
  });

  it("recovers a multi-part snapshot that lost a part", async () => {
    await push(library(2));
    const first = active();
    await push(big(400));
    const second = active();
    expect(fake.docs.get(`${SNAP}/${second}`)!.data.totalParts).toBeGreaterThan(1);
    fake.remove(`${SNAP}/${second}/parts/part_1`);
    const state = await loadRemoteState(DB, TEST_USER);
    expect(state.recoveredFrom?.snapshotId).toBe(first);
    expect(state.recoveredFrom?.reason).toMatch(/part_1 is missing/);
  });

  it("does not recover over a transient read failure, and does not fall back to a newer-version snapshot", async () => {
    await push(library(2));
    const hit = vi.fn();
    fake.interceptors.push((op, path) => {
      if (op === "get" && path.startsWith(`${SNAP}/`) && !hit.mock.calls.length) { hit(); throw new Error("unavailable"); }
    });
    await expect(loadRemoteState(DB, TEST_USER)).rejects.toThrow("unavailable"); // not treated as corruption
    fake.interceptors = [];
    fake.mutate(`${SNAP}/${active()}`, (d) => { d.version = USER_DATA_VERSION + 1; });
    await expect(loadRemoteState(DB, TEST_USER)).rejects.toBeInstanceOf(RemoteVersionError);
  });

  it("treats a sync document with no snapshot and no data as empty, and old inline documents as data", async () => {
    expect((await loadRemoteState(DB, TEST_USER)).data).toBeNull();
    fake.seed(POINTER, { version: 3, updatedAt: "2026-10-01T00:00:00.000Z", revision: 4 });
    expect(await loadRemoteState(DB, TEST_USER)).toMatchObject({ data: null, revision: 4 });
    fake.seed(POINTER, { version: 3, updatedAt: "2026-10-01T00:00:00.000Z", revision: 4, library: library(1).library, progress: {} });
    expect(Object.keys((await loadRemoteState(DB, TEST_USER)).data!.library)).toEqual(["al-0"]);
  });
});

describe("concurrent writes", () => {
  const barrier = (parties: number) => {
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    return async () => {
      if (++arrived >= parties) release();
      await gate;
    };
  };

  it("two devices publishing at once both land: one retries, the loser's snapshot is removed, nothing is lost", async () => {
    const other = new FirestoreSyncService();
    const wait = barrier(2);
    fake.interceptors.push(async (op, path) => { if (op === "txGet" && path === POINTER && fake.counters.transactions <= 2) await wait(); });
    const [a, b] = await Promise.all([
      service.atomicSyncOrPush(DB, TEST_USER, library(3, 0)),
      other.atomicSyncOrPush(DB, TEST_USER, library(3, 100)),
    ]);
    expect(fake.docs.get(POINTER)!.data.revision).toBe(2);
    const final = (await loadRemoteState(DB, TEST_USER)).data!;
    expect(Object.keys(final.library)).toHaveLength(6);
    expect(Object.keys(a.library).length + Object.keys(b.library).length).toBeGreaterThanOrEqual(9); // one saw both
    expect(snapshotIds()).toHaveLength(2); // revision 1 and 2 only: no orphan from the lost race
    for (const id of snapshotIds()) await readVerifiedSnapshot(DB, TEST_USER, id);
  });

  it("gives up after the retry budget with a conflict error and leaves no orphaned snapshot", async () => {
    await service.atomicSyncOrPush(DB, TEST_USER, library(2));
    const before = snapshotIds();
    fake.interceptors.push((op) => {
      if (op === "txCommit") fake.mutate(POINTER, (d) => { d.revision = (d.revision as number) + 1; }); // someone always publishes first
    });
    await expect(service.atomicSyncOrPush(DB, TEST_USER, library(3), 2)).rejects.toBeInstanceOf(RevisionConflictError);
    expect(snapshotIds()).toEqual(before);
  });

  it("a network failure while publishing removes the staged snapshot, keeps the old pointer, and the next attempt succeeds", async () => {
    await service.atomicSyncOrPush(DB, TEST_USER, library(2));
    const pointer = canonicalStringify(fake.docs.get(POINTER)!.data);
    const before = snapshotIds();
    let failed = false;
    fake.interceptors.push((op) => { if (op === "txCommit" && !failed) { failed = true; throw new Error("offline"); } });
    await expect(service.atomicSyncOrPush(DB, TEST_USER, library(4))).rejects.toThrow("offline");
    expect(canonicalStringify(fake.docs.get(POINTER)!.data)).toBe(pointer);
    expect(snapshotIds()).toEqual(before);
    const merged = await service.atomicSyncOrPush(DB, TEST_USER, library(4));
    expect(Object.keys(merged.library)).toHaveLength(4);
    expect(fake.docs.get(POINTER)!.data.revision).toBe(2);
  });

  it("merges rather than overwrites: a status edit made elsewhere survives a stale device's sync", async () => {
    const edited = library(1);
    edited.library["al-0"] = { seriesId: "al-0", status: "dropped", addedAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-05T00:00:00.000Z" };
    await service.atomicSyncOrPush(DB, TEST_USER, edited);
    const stale = library(1); // same addedAt, status still "reading", older change time
    const merged = await new FirestoreSyncService().atomicSyncOrPush(DB, TEST_USER, stale);
    expect(merged.library["al-0"]?.status).toBe("dropped");
  });

  it("never publishes empty or partial data over a populated remote when local is empty", async () => {
    await service.atomicSyncOrPush(DB, TEST_USER, library(3));
    const merged = await new FirestoreSyncService().atomicSyncOrPush(DB, TEST_USER, emptyUserData());
    expect(Object.keys(merged.library)).toHaveLength(3);
    expect(Object.keys((await loadRemoteState(DB, TEST_USER)).data!.library)).toHaveLength(3);
  });
});

describe("pruning", () => {
  const stageRevisions = async (revisions: number[], multi = false) => {
    const ids: Record<number, string> = {};
    for (const revision of revisions) {
      ids[revision] = (await stageAndVerifySnapshot(DB, TEST_USER, revision, multi ? big(400) : library(2))).snapshotId;
      await new Promise((resolve) => setTimeout(resolve, 2)); // distinct timestamps in ids
    }
    return ids;
  };

  it("deletes obsolete snapshots together with their parts, keeping the window and the active snapshot", async () => {
    const ids = await stageRevisions([1, 2, 3, 4, 5, 6], true);
    expect(partPaths().length).toBeGreaterThan(6);
    const removed = await pruneObsoleteSnapshots(DB, TEST_USER, 6, ids[6]!);
    expect(removed).toBe(3); // revisions 1-3
    expect(snapshotIds().sort()).toEqual([ids[4]!, ids[5]!, ids[6]!].sort());
    for (const path of partPaths()) expect([ids[4], ids[5], ids[6]]).toContain(path.split("/")[3]); // no orphaned parts
  });

  it("never deletes the active snapshot, however old, and reads only what it deletes", async () => {
    const ids = await stageRevisions([1, 2, 3, 4, 5, 6, 7, 8]);
    const readsBefore = fake.counters.docReads;
    const removed = await pruneObsoleteSnapshots(DB, TEST_USER, 8, ids[1]!); // pointer (oddly) still at revision 1
    expect(snapshotIds()).toContain(ids[1]);
    expect(removed).toBe(4); // 2-5; revision 1 is active, 6-8 are recent
    expect(fake.counters.docReads - readsBefore).toBeLessThanOrEqual(6); // the 5 obsolete docs + the pointer re-read, never the recent ones
  });

  it("protects the live pointer's snapshot even when the caller's active id is stale", async () => {
    const ids = await stageRevisions([1, 2, 3, 4, 5, 6, 7, 8]);
    fake.seed(`users/${TEST_USER.uid}/sync/userData`, { revision: 8, activeSnapshotId: ids[2] });
    const removed = await pruneObsoleteSnapshots(DB, TEST_USER, 8, ids[8]!);
    expect(snapshotIds()).toContain(ids[2]);
    expect(removed).toBe(4); // 1, 3, 4, 5
  });

  it("never prunes into the retention window of a pointer that is behind the caller's revision", async () => {
    const ids = await stageRevisions([1, 2, 3, 4, 5, 6, 7, 8]);
    fake.seed(`users/${TEST_USER.uid}/sync/userData`, { revision: 5, activeSnapshotId: ids[5] });
    await pruneObsoleteSnapshots(DB, TEST_USER, 8, ids[8]!);
    expect(snapshotIds().sort()).toEqual([ids[3], ids[4], ids[5], ids[6], ids[7], ids[8]].sort()); // keeps 5-2.. onwards
  });

  it("a deletion the rules refuse does not stop the rest of the cleanup or surface as an error", async () => {
    const ids = await stageRevisions([1, 2, 3, 4, 5, 6, 7, 8], true);
    fake.interceptors.push((op, path) => {
      if (op === "commit" && path.includes(`/${ids[2]}`)) throw Object.assign(new Error("Missing or insufficient permissions."), { code: "permission-denied" });
    });
    const removed = await pruneObsoleteSnapshots(DB, TEST_USER, 8, ids[8]!);
    expect(removed).toBe(4); // 1, 3, 4, 5 (2 was refused)
    expect(snapshotIds()).toContain(ids[2]);
    expect(snapshotIds()).not.toContain(ids[1]);
    expect(snapshotIds()).not.toContain(ids[5]);
    expect(snapshotIds()).toEqual(expect.arrayContaining([ids[6], ids[7], ids[8]]));
    for (const path of partPaths()) expect(snapshotIds()).toContain(path.split("/")[3]); // no orphaned parts
  });

  it("reads nothing when nothing is obsolete", async () => {
    const ids = await stageRevisions([1, 2, 3]);
    const readsBefore = fake.counters.docReads;
    expect(await pruneObsoleteSnapshots(DB, TEST_USER, 3, ids[3]!)).toBe(0);
    expect(fake.counters.docReads - readsBefore).toBe(0);
  });

  it("keeps a bounded number of verified snapshots across many real syncs", async () => {
    for (let i = 1; i <= 7; i++) {
      await service.atomicSyncOrPush(DB, TEST_USER, library(i));
      await new Promise((resolve) => setTimeout(resolve, 5)); // let background pruning settle
    }
    expect(snapshotIds().length).toBeLessThanOrEqual(4);
    expect(fake.docs.get(POINTER)!.data.revision).toBe(7);
    for (const id of snapshotIds()) await readVerifiedSnapshot(DB, TEST_USER, id);
  });
});
