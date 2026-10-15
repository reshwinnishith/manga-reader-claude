// @vitest-environment node
import { describe, it, beforeAll, afterAll, beforeEach, expect } from "vitest";
import "firebase/compat/app";
import "firebase/compat/firestore";
import {
  initializeTestEnvironment,
  RulesTestEnvironment,
  assertFails,
  assertSucceeds,
} from "@firebase/rules-unit-testing";
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  collection,
} from "firebase/firestore";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Socket } from "node:net";

const PROJECT_ID = "demo-manga-reader";
const RULES_PATH = resolve(process.cwd(), "firestore.rules");

async function isPortOpen(port: number, host = "127.0.0.1", timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

describe("Firestore Security Rules for MangaReader", () => {
  let testEnv!: RulesTestEnvironment;
  let emulatorAvailable = false;

  beforeAll(async () => {
    let host = "127.0.0.1";
    let port = 8088;

    if (process.env.FIRESTORE_EMULATOR_HOST) {
      const parts = process.env.FIRESTORE_EMULATOR_HOST.split(":");
      host = parts[0] || "127.0.0.1";
      port = parseInt(parts[1] || "8088", 10);
      emulatorAvailable = await isPortOpen(port, host);
    } else {
      for (const candidatePort of [8088, 8080]) {
        if (await isPortOpen(candidatePort, host)) {
          port = candidatePort;
          emulatorAvailable = true;
          break;
        }
      }
    }

    if (!emulatorAvailable) {
      console.warn("Firestore emulator is not reachable (checked ports 8088, 8080). Transparently skipping rules tests.");
      return;
    }
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        host,
        port,
        rules: readFileSync(RULES_PATH, "utf8"),
      },
    });
  });

  afterAll(async () => {
    if (testEnv) {
      await testEnv.cleanup();
    }
  });

  beforeEach(async (context) => {
    if (!emulatorAvailable || !testEnv) {
      context.skip();
      return;
    }
    await testEnv.clearFirestore();
  });

  // -------------------------------------------------------------
  // 1. Authentication & Ownership Authorization
  // -------------------------------------------------------------
  describe("Authentication & Access Control", () => {
    it("denies unauthenticated read and write access to user profiles", async () => {
      const unauth = testEnv.unauthenticatedContext().firestore();
      const userRef = doc(unauth, "users/user123");

      await expect(assertFails(getDoc(userRef))).resolves.toBeDefined();
      await expect(
        assertFails(
          setDoc(userRef, {
            uid: "user123",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
        ),
      ).resolves.toBeDefined();
    });

    it("denies unauthenticated read and write to subcollections", async () => {
      const unauth = testEnv.unauthenticatedContext().firestore();
      const libRef = doc(unauth, "users/user123/library/manga-1");

      await expect(assertFails(getDoc(libRef))).resolves.toBeDefined();
      await expect(
        assertFails(
          setDoc(libRef, {
            mediaId: "manga-1",
            title: "Berserk",
            status: "reading",
            updatedAt: new Date().toISOString(),
          }),
        ),
      ).resolves.toBeDefined();
    });

    it("prevents User A from reading or modifying User B's profile", async () => {
      const userA = testEnv.authenticatedContext("userA").firestore();
      const userBRef = doc(userA, "users/userB");

      await expect(assertFails(getDoc(userBRef))).resolves.toBeDefined();
      await expect(
        assertFails(
          setDoc(userBRef, {
            uid: "userB",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
        ),
      ).resolves.toBeDefined();
    });

    it("prevents User A from reading or modifying User B's library", async () => {
      const userA = testEnv.authenticatedContext("userA").firestore();
      const userBLibRef = doc(userA, "users/userB/library/entry-1");

      await expect(assertFails(getDoc(userBLibRef))).resolves.toBeDefined();
      await expect(
        assertFails(
          setDoc(userBLibRef, {
            mediaId: "entry-1",
            title: "One Piece",
            status: "reading",
            updatedAt: new Date().toISOString(),
          }),
        ),
      ).resolves.toBeDefined();
    });

    it("denies blanket collection listing of /users for any authenticated user", async () => {
      const userA = testEnv.authenticatedContext("userA").firestore();
      const usersCol = collection(userA, "users");

      await expect(assertFails(getDocs(usersCol))).resolves.toBeDefined();
    });

    it("denies access to unspecified top-level collections by default deny", async () => {
      const userA = testEnv.authenticatedContext("userA").firestore();
      const adminDoc = doc(userA, "admin/config");
      const postsDoc = doc(userA, "posts/post-1");

      await expect(assertFails(getDoc(adminDoc))).resolves.toBeDefined();
      await expect(assertFails(getDoc(postsDoc))).resolves.toBeDefined();
      await expect(assertFails(setDoc(adminDoc, { admin: true }))).resolves.toBeDefined();
    });
  });

  // -------------------------------------------------------------
  // 2. User Profile Validation
  // -------------------------------------------------------------
  describe("Users Collection Schema & Validation", () => {
    it("allows owner to create a valid user profile", async () => {
      const userA = testEnv.authenticatedContext("userA").firestore();
      const userRef = doc(userA, "users/userA");

      const now = new Date().toISOString();
      await expect(
        assertSucceeds(
          setDoc(userRef, {
            uid: "userA",
            createdAt: now,
            updatedAt: now,
            version: 1,
            anonymous: false,
          }),
        ),
      ).resolves.toBeUndefined();
    });

    it("rejects user profile create when uid does not match auth.uid (ownership spoofing)", async () => {
      const userA = testEnv.authenticatedContext("userA").firestore();
      const userRef = doc(userA, "users/userA");

      const now = new Date().toISOString();
      await expect(
        assertFails(
          setDoc(userRef, {
            uid: "attacker-id",
            createdAt: now,
            updatedAt: now,
          }),
        ),
      ).resolves.toBeDefined();
    });

    it("rejects user profile with unauthorized fields (schema pollution)", async () => {
      const userA = testEnv.authenticatedContext("userA").firestore();
      const userRef = doc(userA, "users/userA");

      const now = new Date().toISOString();
      await expect(
        assertFails(
          setDoc(userRef, {
            uid: "userA",
            createdAt: now,
            updatedAt: now,
            isAdmin: true, // unauthorized field
          }),
        ),
      ).resolves.toBeDefined();
    });

    it("prevents changing immutable createdAt or uid on update", async () => {
      // Seed valid doc via admin
      const now = new Date().toISOString();
      await testEnv.withSecurityRulesDisabled(async (context) => {
        await setDoc(doc(context.firestore(), "users/userA"), {
          uid: "userA",
          createdAt: now,
          updatedAt: now,
        });
      });

      const userA = testEnv.authenticatedContext("userA").firestore();
      const userRef = doc(userA, "users/userA");

      // Attempt to modify createdAt
      await expect(
        assertFails(
          updateDoc(userRef, {
            createdAt: new Date("2020-01-01").toISOString(),
            updatedAt: new Date().toISOString(),
          }),
        ),
      ).resolves.toBeDefined();

      // Attempt to modify uid
      await expect(
        assertFails(
          updateDoc(userRef, {
            uid: "new-user-id",
            updatedAt: new Date().toISOString(),
          }),
        ),
      ).resolves.toBeDefined();

      // Valid update succeeds
      const nextTime = new Date().toISOString();
      await expect(
        assertSucceeds(
          updateDoc(userRef, {
            updatedAt: nextTime,
            displayName: "Manga Reader Fan",
          }),
        ),
      ).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------
  // 3. Library Subcollection Validation
  // -------------------------------------------------------------
  describe("Library Subcollection Schema & Validation", () => {
    it("allows user to create a valid library entry", async () => {
      const userA = testEnv.authenticatedContext("userA").firestore();
      const libRef = doc(userA, "users/userA/library/manga-101");

      await expect(
        assertSucceeds(
          setDoc(libRef, {
            mediaId: "manga-101",
            title: "Chainsaw Man",
            status: "reading",
            totalChapters: 120,
            updatedAt: new Date().toISOString(),
          }),
        ),
      ).resolves.toBeUndefined();
    });

    it("allows user to list their own library entries", async () => {
      const userA = testEnv.authenticatedContext("userA").firestore();
      const libCol = collection(userA, "users/userA/library");

      await expect(assertSucceeds(getDocs(libCol))).resolves.toBeDefined();
    });

    it("rejects library entry with an invalid reading status enum", async () => {
      const userA = testEnv.authenticatedContext("userA").firestore();
      const libRef = doc(userA, "users/userA/library/manga-102");

      await expect(
        assertFails(
          setDoc(libRef, {
            mediaId: "manga-102",
            title: "Test Series",
            status: "invalid_status", // invalid enum
            updatedAt: new Date().toISOString(),
          }),
        ),
      ).resolves.toBeDefined();
    });

    it("rejects oversized title (resource exhaustion / DoS check)", async () => {
      const userA = testEnv.authenticatedContext("userA").firestore();
      const libRef = doc(userA, "users/userA/library/manga-103");

      const hugeTitle = "A".repeat(1000); // Max allowed is 500
      await expect(
        assertFails(
          setDoc(libRef, {
            mediaId: "manga-103",
            title: hugeTitle,
            status: "reading",
            updatedAt: new Date().toISOString(),
          }),
        ),
      ).resolves.toBeDefined();
    });

    it("prevents changing immutable mediaId on update", async () => {
      const now = new Date().toISOString();
      await testEnv.withSecurityRulesDisabled(async (context) => {
        await setDoc(doc(context.firestore(), "users/userA/library/manga-104"), {
          mediaId: "manga-104",
          title: "Naruto",
          status: "completed",
          updatedAt: now,
        });
      });

      const userA = testEnv.authenticatedContext("userA").firestore();
      const libRef = doc(userA, "users/userA/library/manga-104");

      await expect(
        assertFails(
          updateDoc(libRef, {
            mediaId: "tampered-media-id",
            updatedAt: new Date().toISOString(),
          }),
        ),
      ).resolves.toBeDefined();
    });

    it("allows owner to delete their library entry using deleteDoc", async () => {
      const now = new Date().toISOString();
      await testEnv.withSecurityRulesDisabled(async (context) => {
        await setDoc(doc(context.firestore(), "users/userA/library/manga-to-delete"), {
          mediaId: "manga-to-delete",
          title: "Delete Candidate",
          status: "reading",
          updatedAt: now,
        });
      });

      const userA = testEnv.authenticatedContext("userA").firestore();
      const libRef = doc(userA, "users/userA/library/manga-to-delete");

      await expect(assertSucceeds(deleteDoc(libRef))).resolves.toBeUndefined();
    });

    it("prevents User B from deleting User A's library entry using deleteDoc", async () => {
      const now = new Date().toISOString();
      await testEnv.withSecurityRulesDisabled(async (context) => {
        await setDoc(doc(context.firestore(), "users/userA/library/manga-protected"), {
          mediaId: "manga-protected",
          title: "Protected Manga",
          status: "reading",
          updatedAt: now,
        });
      });

      const userB = testEnv.authenticatedContext("userB").firestore();
      const libRef = doc(userB, "users/userA/library/manga-protected");

      await expect(assertFails(deleteDoc(libRef))).resolves.toBeDefined();
    });

    it("allows owner to delete documents across progress, readerModes, savedTitles, and sync subcollections", async () => {
      const now = new Date().toISOString();
      await testEnv.withSecurityRulesDisabled(async (context) => {
        const db = context.firestore();
        await setDoc(doc(db, "users/userA/progress/prog-del"), {
          seriesId: "prog-del",
          updatedAt: now,
        });
        await setDoc(doc(db, "users/userA/readerModes/mode-del"), {
          seriesId: "mode-del",
          mode: "webtoon",
          updatedAt: now,
        });
        await setDoc(doc(db, "users/userA/savedTitles/title-del"), {
          mediaId: "title-del",
          title: "To Be Deleted",
          savedAt: now,
        });
        await setDoc(doc(db, "users/userA/sync/userData"), {
          version: 3,
          updatedAt: now,
        });
      });

      const userA = testEnv.authenticatedContext("userA").firestore();
      await expect(assertSucceeds(deleteDoc(doc(userA, "users/userA/progress/prog-del")))).resolves.toBeUndefined();
      await expect(assertSucceeds(deleteDoc(doc(userA, "users/userA/readerModes/mode-del")))).resolves.toBeUndefined();
      await expect(assertSucceeds(deleteDoc(doc(userA, "users/userA/savedTitles/title-del")))).resolves.toBeUndefined();
      await expect(assertSucceeds(deleteDoc(doc(userA, "users/userA/sync/userData")))).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------
  // 4. Progress Subcollection Validation
  // -------------------------------------------------------------
  describe("Progress Subcollection Schema & Validation", () => {
    it("allows owner to write and update reading progress", async () => {
      const userA = testEnv.authenticatedContext("userA").firestore();
      const progRef = doc(userA, "users/userA/progress/series-1");

      const now = new Date().toISOString();
      await expect(
        assertSucceeds(
          setDoc(progRef, {
            seriesId: "series-1",
            chapterId: "ch-10",
            chapterNumber: 10,
            page: 15,
            percentage: 50,
            updatedAt: now,
          }),
        ),
      ).resolves.toBeUndefined();

      // Valid update
      await expect(
        assertSucceeds(
          updateDoc(progRef, {
            page: 16,
            percentage: 53,
            updatedAt: new Date().toISOString(),
          }),
        ),
      ).resolves.toBeUndefined();
    });

    it("rejects progress when seriesId does not match document ID", async () => {
      const userA = testEnv.authenticatedContext("userA").firestore();
      const progRef = doc(userA, "users/userA/progress/series-1");

      await expect(
        assertFails(
          setDoc(progRef, {
            seriesId: "mismatched-series-id",
            updatedAt: new Date().toISOString(),
          }),
        ),
      ).resolves.toBeDefined();
    });

    it("rejects progress with negative page index", async () => {
      const userA = testEnv.authenticatedContext("userA").firestore();
      const progRef = doc(userA, "users/userA/progress/series-2");

      await expect(
        assertFails(
          setDoc(progRef, {
            seriesId: "series-2",
            page: -5, // Negative page is forbidden
            updatedAt: new Date().toISOString(),
          }),
        ),
      ).resolves.toBeDefined();
    });

    it("rejects progress with percentage out of range (> 100)", async () => {
      const userA = testEnv.authenticatedContext("userA").firestore();
      const progRef = doc(userA, "users/userA/progress/series-3");

      await expect(
        assertFails(
          setDoc(progRef, {
            seriesId: "series-3",
            percentage: 150, // Out of bounds
            updatedAt: new Date().toISOString(),
          }),
        ),
      ).resolves.toBeDefined();
    });
  });

  // -------------------------------------------------------------
  // 5. Reader Modes Subcollection Validation
  // -------------------------------------------------------------
  describe("Reader Modes Subcollection Schema & Validation", () => {
    it("allows saving a valid reader mode preference", async () => {
      const userA = testEnv.authenticatedContext("userA").firestore();
      const modeRef = doc(userA, "users/userA/readerModes/series-1");

      await expect(
        assertSucceeds(
          setDoc(modeRef, {
            seriesId: "series-1",
            mode: "webtoon",
            updatedAt: new Date().toISOString(),
          }),
        ),
      ).resolves.toBeUndefined();
    });

    it("rejects invalid reader mode", async () => {
      const userA = testEnv.authenticatedContext("userA").firestore();
      const modeRef = doc(userA, "users/userA/readerModes/series-1");

      await expect(
        assertFails(
          setDoc(modeRef, {
            seriesId: "series-1",
            mode: "unsupported-mode",
            updatedAt: new Date().toISOString(),
          }),
        ),
      ).resolves.toBeDefined();
    });
  });

  // -------------------------------------------------------------
  // 6. Saved Titles Subcollection Validation
  // -------------------------------------------------------------
  describe("Saved Titles Subcollection Schema & Validation", () => {
    it("allows saving an external title snapshot", async () => {
      const userA = testEnv.authenticatedContext("userA").firestore();
      const titleRef = doc(userA, "users/userA/savedTitles/al-30002");

      await expect(
        assertSucceeds(
          setDoc(titleRef, {
            mediaId: "al-30002",
            title: "Berserk",
            savedAt: new Date().toISOString(),
            source: "anilist",
            externalId: 30002,
            type: "manga",
            genres: ["Action", "Dark Fantasy"],
          }),
        ),
      ).resolves.toBeUndefined();
    });

    it("rejects saved title without required title field", async () => {
      const userA = testEnv.authenticatedContext("userA").firestore();
      const titleRef = doc(userA, "users/userA/savedTitles/al-30003");

      await expect(
        assertFails(
          setDoc(titleRef, {
            mediaId: "al-30003",
            savedAt: new Date().toISOString(),
          }),
        ),
      ).resolves.toBeDefined();
    });
  });

  // -------------------------------------------------------------
  // 7. Full Sync Backup Document Validation
  // -------------------------------------------------------------
  describe("Full Sync Document Validation", () => {
    it("allows writing the userData sync singleton document", async () => {
      const userA = testEnv.authenticatedContext("userA").firestore();
      const syncRef = doc(userA, "users/userA/sync/userData");

      await expect(
        assertSucceeds(
          setDoc(syncRef, {
            version: 3,
            updatedAt: new Date().toISOString(),
            library: {},
            progress: {},
            readerModes: {},
            savedTitles: {},
            seeded: true,
          }),
        ),
      ).resolves.toBeUndefined();
    });

    it("denies writing to unauthorized document names under /sync", async () => {
      const userA = testEnv.authenticatedContext("userA").firestore();
      const syncRef = doc(userA, "users/userA/sync/otherDoc");

      await expect(
        assertFails(
          setDoc(syncRef, {
            version: 3,
            updatedAt: new Date().toISOString(),
          }),
        ),
      ).resolves.toBeDefined();
    });

    it("allows writing revision, syncStatus, syncSessionId, and tombstones to userData", async () => {
      const userA = testEnv.authenticatedContext("userA").firestore();
      const syncRef = doc(userA, "users/userA/sync/userData");

      await expect(
        assertSucceeds(
          setDoc(syncRef, {
            version: 3,
            updatedAt: new Date().toISOString(),
            revision: 10,
            syncStatus: "ready",
            syncSessionId: "session-uuid-12345",
            tombstones: {
              "series-deleted-1": new Date().toISOString(),
            },
            library: {},
            progress: {},
            readerModes: {},
            savedTitles: {},
            seeded: true,
          }),
        ),
      ).resolves.toBeUndefined();
    });

    it("allows syncStatus 'syncing' and revision 0", async () => {
      const userA = testEnv.authenticatedContext("userA").firestore();
      const syncRef = doc(userA, "users/userA/sync/userData");

      await expect(
        assertSucceeds(
          setDoc(syncRef, {
            version: 3,
            updatedAt: new Date().toISOString(),
            revision: 0,
            syncStatus: "syncing",
          }),
        ),
      ).resolves.toBeUndefined();
    });

    it("rejects invalid syncStatus enum value", async () => {
      const userA = testEnv.authenticatedContext("userA").firestore();
      const syncRef = doc(userA, "users/userA/sync/userData");

      await expect(
        assertFails(
          setDoc(syncRef, {
            version: 3,
            updatedAt: new Date().toISOString(),
            syncStatus: "corrupted_status",
          }),
        ),
      ).resolves.toBeDefined();
    });

    it("rejects negative revision number", async () => {
      const userA = testEnv.authenticatedContext("userA").firestore();
      const syncRef = doc(userA, "users/userA/sync/userData");

      await expect(
        assertFails(
          setDoc(syncRef, {
            version: 3,
            updatedAt: new Date().toISOString(),
            revision: -5,
          }),
        ),
      ).resolves.toBeDefined();
    });

    it("rejects syncSessionId longer than 100 characters", async () => {
      const userA = testEnv.authenticatedContext("userA").firestore();
      const syncRef = doc(userA, "users/userA/sync/userData");

      await expect(
        assertFails(
          setDoc(syncRef, {
            version: 3,
            updatedAt: new Date().toISOString(),
            syncSessionId: "a".repeat(101),
          }),
        ),
      ).resolves.toBeDefined();
    });

    it("rejects tombstones field when not a map", async () => {
      const userA = testEnv.authenticatedContext("userA").firestore();
      const syncRef = doc(userA, "users/userA/sync/userData");

      await expect(
        assertFails(
          setDoc(syncRef, {
            version: 3,
            updatedAt: new Date().toISOString(),
            tombstones: ["series-1", "series-2"], // array instead of map
          }),
        ),
      ).resolves.toBeDefined();
    });
  });
});
