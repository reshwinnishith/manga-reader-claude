// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "firebase/compat/app";
import "firebase/compat/firestore";
import { assertFails, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { deleteDoc, doc, getDoc } from "firebase/firestore";
import type { Firestore } from "firebase/firestore";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Socket } from "node:net";
import { library } from "@/test/sync-fixtures";
import { removeFromLibrary, setReaderMode, setReadingStatus } from "@/lib/user-data";
import {
  FirestoreSyncService,
  RemoteDataUnrecoverableError,
  canonicalStringify,
  loadRemoteState,
  pruneObsoleteSnapshots,
  readVerifiedSnapshot,
} from "./firestore-sync";

/**
 * The real sync code against the real Firestore emulator WITH the security rules
 * enforced, so a mismatch between what the client writes and what the rules accept
 * fails here. Skipped (loudly) without an emulator; fails instead when
 * REQUIRE_FIRESTORE_EMULATOR=true (CI). Run with `npm run test:rules`.
 */
const USER = { uid: "userA", isAnonymous: true, metadata: { creationTime: "2026-01-01T00:00:00.000Z" } };
const portOpen = (port: number, host: string) =>
  new Promise<boolean>((done) => {
    const socket = new Socket();
    socket.setTimeout(400);
    socket.once("connect", () => { socket.destroy(); done(true); });
    socket.once("timeout", () => { socket.destroy(); done(false); });
    socket.once("error", () => { socket.destroy(); done(false); });
    socket.connect(port, host);
  });

describe("sync client against the Firestore rules (real emulator)", () => {
  let env!: RulesTestEnvironment;
  let available = false;
  let db: Firestore;
  let service: FirestoreSyncService;
  const snapshotIds = async () => {
    let ids: string[] = [];
    await env.withSecurityRulesDisabled(async (ctx) => {
      const { collection, getDocs } = await import("firebase/firestore");
      ids = (await getDocs(collection(ctx.firestore() as unknown as Firestore, "users/userA/snapshots"))).docs.map((d) => d.id);
    });
    return ids;
  };
  const admin = (fn: (adminDb: Firestore) => Promise<void>) => env.withSecurityRulesDisabled(async (ctx) => fn(ctx.firestore() as unknown as Firestore));

  beforeAll(async () => {
    const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080").split(":") as [string, string];
    available = await portOpen(Number(port), host);
    if (!available) {
      if (process.env.REQUIRE_FIRESTORE_EMULATOR === "true") throw new Error("REQUIRE_FIRESTORE_EMULATOR is set but no Firestore emulator is reachable.");
      console.warn("Firestore emulator not reachable: SKIPPING the sync-vs-rules integration tests (run `npm run test:rules`).");
      return;
    }
    env = await initializeTestEnvironment({ projectId: "demo-manga-reader-sync", firestore: { host, port: Number(port), rules: readFileSync(resolve(process.cwd(), "firestore.rules"), "utf8") } });
  });
  afterAll(async () => { await env?.cleanup(); });
  beforeEach(async (context) => {
    if (!available) return context.skip();
    await env.clearFirestore();
    db = env.authenticatedContext("userA").firestore() as unknown as Firestore;
    service = new FirestoreSyncService();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("publishes successive revisions that the rules accept, and the result verifies", async () => {
    for (let i = 1; i <= 3; i++) await service.atomicSyncOrPush(db, USER, library(i));
    const state = await loadRemoteState(db, USER);
    expect(Object.keys(state.data!.library)).toHaveLength(3);
    expect(state.revision).toBe(3);
    expect((await getDoc(doc(db, "users/userA/sync/userData"))).data()).toMatchObject({ revision: 3, snapshotParts: 1 });
    expect((await getDoc(doc(db, "users/userA"))).data()).toMatchObject({ uid: "userA", anonymous: true });
  });

  it("publishes a large multi-part library that the rules accept (parts first, parent after, pointer last)", async () => {
    const merged = await service.atomicSyncOrPush(db, USER, library(900, 0, 3000));
    expect(Object.keys(merged.library)).toHaveLength(900);
    const pointer = (await getDoc(doc(db, "users/userA/sync/userData"))).data()!;
    expect(pointer.snapshotParts).toBeGreaterThan(2);
    const verified = await readVerifiedSnapshot(db, USER, pointer.activeSnapshotId as string, { checksum: pointer.snapshotChecksum as string, parts: pointer.snapshotParts as number });
    expect(Object.keys(verified.data.savedTitles)).toHaveLength(900);
  }, 60_000);

  it("prunes old snapshots and their parts under the rules, never touching the active one", async () => {
    await service.atomicSyncOrPush(db, USER, library(900, 0, 3000)); // revision 1, multi-part
    for (let i = 2; i <= 6; i++) await service.atomicSyncOrPush(db, USER, library(i));
    await new Promise((resolve) => setTimeout(resolve, 1500)); // background pruning
    const remaining = await snapshotIds();
    expect(remaining.length).toBeLessThanOrEqual(4);
    // Every later revision still carries the 900 titles, so retained snapshots keep their parts;
    // what must not exist is a part whose snapshot was pruned.
    const partParents: string[] = [];
    await admin(async (adminDb) => {
      const { collectionGroup, getDocs } = await import("firebase/firestore");
      for (const d of (await getDocs(collectionGroup(adminDb, "parts"))).docs) partParents.push(d.ref.parent.parent!.id);
    });
    expect(partParents.length).toBeGreaterThan(0);
    for (const parent of partParents) expect(remaining).toContain(parent); // no orphaned parts
    const pointer = (await getDoc(doc(db, "users/userA/sync/userData"))).data()!;
    expect(remaining).toContain(pointer.activeSnapshotId);
    await readVerifiedSnapshot(db, USER, pointer.activeSnapshotId as string);
  }, 60_000);

  it("the rules refuse to delete the active snapshot even if the client tried", async () => {
    await service.atomicSyncOrPush(db, USER, library(2));
    const active = (await getDoc(doc(db, "users/userA/sync/userData"))).data()!.activeSnapshotId as string;
    await expect(assertFails(deleteDoc(doc(db, `users/userA/snapshots/${active}`)))).resolves.toBeDefined();
    expect(await pruneObsoleteSnapshots(db, USER, 99, active)).toBeGreaterThanOrEqual(0);
    expect((await getDoc(doc(db, `users/userA/snapshots/${active}`))).exists()).toBe(true);
  });

  it("a stale pruner whose captured active id is out of date neither aborts nor deletes the real active snapshot", async () => {
    for (let i = 1; i <= 4; i++) await service.atomicSyncOrPush(db, USER, library(i));
    await new Promise((resolve) => setTimeout(resolve, 1000)); // let background pruning settle
    const stale = (await getDoc(doc(db, "users/userA/sync/userData"))).data()!.activeSnapshotId as string;
    // Another device re-pointed the (revision 9) pointer at an older-revision snapshot, and two more
    // obsolete snapshots exist. The pruner below still believes `stale` is the active one.
    await admin(async (adminDb) => {
      const { getDoc: read, setDoc, updateDoc } = await import("firebase/firestore");
      const base = (await read(doc(adminDb, `users/userA/snapshots/${stale}`))).data()!;
      for (const [id, revision] of [["old-1", 1], ["old-2", 2]] as const) {
        await setDoc(doc(adminDb, `users/userA/snapshots/${id}`), { ...base, snapshotId: id, revision });
      }
      await updateDoc(doc(adminDb, "users/userA/sync/userData"), { activeSnapshotId: "old-2", revision: 9 });
    });
    const removed = await pruneObsoleteSnapshots(db, USER, 9, stale);
    const remaining = await snapshotIds();
    expect(remaining).toContain("old-2"); // the real active snapshot survives
    expect(remaining).not.toContain("old-1"); // and its rejection did not abort the rest of the cleanup
    expect(removed).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("two devices converge on library, status, reader mode, progress and deletion through the real rules", async () => {
    const t = (n: number) => `2026-10-02T00:00:0${n}.000Z`;
    const deviceB = new FirestoreSyncService();
    // Device A publishes a library; device B pulls it.
    await service.atomicSyncOrPush(db, USER, library(3));
    let b = await deviceB.atomicSyncOrPush(db, USER, library(0));
    expect(Object.keys(b.library).sort()).toEqual(["al-0", "al-1", "al-2"]);
    expect(b.progress["al-0"]!.chapters.c1!.page).toBe(3);
    // B changes status + reader mode, finishes a chapter, and deletes a title while A edits others.
    b = setReaderMode(setReadingStatus(b, "al-0", "completed", t(1)), "al-0", "paged-rtl", t(1));
    b.progress["al-0"] = { ...b.progress["al-0"]!, updatedAt: t(1), chapters: { c1: { page: 19, pageCount: 20, atEnd: true, completed: true, updatedAt: t(1) } } };
    b = removeFromLibrary(b, "al-2", t(2));
    await deviceB.atomicSyncOrPush(db, USER, b);
    const a = await service.atomicSyncOrPush(db, USER, setReadingStatus(library(3), "al-1", "dropped", t(3)));
    expect(a.library["al-0"]).toMatchObject({ status: "completed" });
    expect(a.library["al-1"]).toMatchObject({ status: "dropped" });
    expect(a.library["al-2"]).toBeUndefined(); // the deletion propagated
    expect(a.readerModes["al-0"]).toBe("paged-rtl");
    expect(a.progress["al-0"]!.chapters.c1).toMatchObject({ page: 19, completed: true });
    // Re-adding after the deletion (newer than the tombstone) survives on the other device.
    const readded = { ...a, library: { ...a.library, "al-2": { seriesId: "al-2", status: "planned" as const, addedAt: t(5), updatedAt: t(5) } } };
    await service.atomicSyncOrPush(db, USER, readded);
    expect((await deviceB.atomicSyncOrPush(db, USER, b)).library["al-2"]).toMatchObject({ status: "planned" });
  }, 60_000);

  it("keeps two accounts completely separate, and one cannot read or publish into the other's data", async () => {
    const userB = { uid: "userB", isAnonymous: true, metadata: { creationTime: "2026-01-01T00:00:00.000Z" } };
    const dbB = env.authenticatedContext("userB").firestore() as unknown as Firestore;
    await service.atomicSyncOrPush(db, USER, library(3, 0));
    await new FirestoreSyncService().atomicSyncOrPush(dbB, userB, library(2, 100));
    const a = await loadRemoteState(db, USER);
    const b = await loadRemoteState(dbB, userB);
    expect(Object.keys(a.data!.library).sort()).toEqual(["al-0", "al-1", "al-2"]);
    expect(Object.keys(b.data!.library).sort()).toEqual(["al-100", "al-101"]);
    await expect(assertFails(getDoc(doc(dbB, "users/userA/sync/userData")))).resolves.toBeDefined();
    const activeA = (await getDoc(doc(db, "users/userA/sync/userData"))).data()!.activeSnapshotId as string;
    await expect(assertFails(getDoc(doc(dbB, `users/userA/snapshots/${activeA}`)))).resolves.toBeDefined();
    await expect(assertFails(deleteDoc(doc(dbB, `users/userA/snapshots/old`)))).resolves.toBeDefined();
    // An attempt by B to sync into A's account is refused and changes nothing.
    await expect(new FirestoreSyncService().atomicSyncOrPush(dbB, USER, library(1, 500))).rejects.toBeDefined();
    expect(Object.keys((await loadRemoteState(db, USER)).data!.library)).toHaveLength(3);
  }, 60_000);

  it("offline edits made on one device are merged, not lost, when it reconnects after another device published", async () => {
    const t = (n: number) => `2026-10-03T00:00:0${n}.000Z`;
    const phone = new FirestoreSyncService();
    await phone.atomicSyncOrPush(db, USER, library(2)); // phone synced, then goes offline
    // While the phone is offline another device adds a title and moves the revision on twice.
    await service.atomicSyncOrPush(db, USER, library(3));
    await service.atomicSyncOrPush(db, USER, library(4));
    // The phone's offline edits (status + a new title) made against its older copy.
    const offline = setReadingStatus(library(2), "al-0", "completed", t(1));
    offline.library["al-50"] = { seriesId: "al-50", status: "reading", addedAt: t(2), updatedAt: t(2) };
    const merged = await phone.atomicSyncOrPush(db, USER, offline);
    expect(Object.keys(merged.library).sort()).toEqual(["al-0", "al-1", "al-2", "al-3", "al-50"]);
    expect(merged.library["al-0"]).toMatchObject({ status: "completed" });
    expect((await loadRemoteState(db, USER)).revision).toBe(4);
  }, 60_000);

  it("two devices publishing at once both land under real transaction semantics", async () => {
    const other = new FirestoreSyncService();
    const [a, b] = await Promise.all([service.atomicSyncOrPush(db, USER, library(3, 0)), other.atomicSyncOrPush(db, USER, library(3, 100))]);
    expect(Object.keys(a.library).length + Object.keys(b.library).length).toBeGreaterThanOrEqual(9);
    const state = await loadRemoteState(db, USER);
    expect(Object.keys(state.data!.library)).toHaveLength(6);
    expect(state.revision).toBe(2);
    expect(await snapshotIds()).toHaveLength(2); // the loser's staged snapshot was removed
  }, 60_000);

  it("recovers from a corrupted active snapshot and heals it with a new valid revision", async () => {
    await service.atomicSyncOrPush(db, USER, library(2));
    await service.atomicSyncOrPush(db, USER, library(4));
    const active = (await getDoc(doc(db, "users/userA/sync/userData"))).data()!.activeSnapshotId as string;
    await admin(async (adminDb) => {
      const { updateDoc } = await import("firebase/firestore");
      await updateDoc(doc(adminDb, `users/userA/snapshots/${active}`), { "library.al-0.status": "dropped" });
    });
    const state = await loadRemoteState(db, USER);
    expect(state.recoveredFrom).toBeDefined();
    expect(Object.keys(state.data!.library)).toHaveLength(2);
    const healed = await service.atomicSyncOrPush(db, USER, library(5, 50));
    expect(Object.keys(healed.library)).toHaveLength(7);
    const after = await loadRemoteState(db, USER);
    expect(after.recoveredFrom).toBeUndefined();
    expect(after.revision).toBe(3);
  });

  it("refuses, writes nothing and keeps local data when every snapshot is corrupt", async () => {
    await service.atomicSyncOrPush(db, USER, library(2));
    for (const id of await snapshotIds()) {
      await admin(async (adminDb) => {
        const { updateDoc } = await import("firebase/firestore");
        await updateDoc(doc(adminDb, `users/userA/snapshots/${id}`), { checksum: "0".repeat(64) });
      });
    }
    const before = canonicalStringify(await snapshotIds());
    const local = library(3, 70);
    await expect(service.atomicSyncOrPush(db, USER, local)).rejects.toBeInstanceOf(RemoteDataUnrecoverableError);
    expect(canonicalStringify(await snapshotIds())).toBe(before);
    expect((await getDoc(doc(db, "users/userA/sync/userData"))).data()!.revision).toBe(1);
  });

  it("the optional per-collection copies still satisfy the rules when enabled", async () => {
    const data = library(3);
    data.readerModes["al-0"] = "paged-rtl";
    data.readerModeTimes = { "al-0": "2026-10-01T00:00:00.000Z" };
    data.tombstones = { "al-9": "2026-10-01T00:00:00.000Z" };
    await service.atomicSyncOrPush(db, USER, data);
    const id = (service as unknown as { currentReconciliationId: number }).currentReconciliationId;
    await service.reconcileSubcollections(db, USER, id, 1, data);
    for (const path of ["users/userA/library/al-0", "users/userA/progress/al-0", "users/userA/readerModes/al-0", "users/userA/savedTitles/al-0"]) {
      expect((await getDoc(doc(db, path))).exists(), path).toBe(true);
    }
  });
});
