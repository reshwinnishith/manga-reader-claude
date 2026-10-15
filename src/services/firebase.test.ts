import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  getFirebaseConfigFromEnv,
  isFirebaseConfigured,
  getFirebaseApp,
  getFirebaseAuth,
  getFirebaseFirestore,
  resetFirebaseClientForTesting,
} from "./firebase";

describe("Firebase Client Service", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetFirebaseClientForTesting();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    resetFirebaseClientForTesting();
  });

  it("returns null when required environment variables are missing", () => {
    delete process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
    delete process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

    expect(getFirebaseConfigFromEnv()).toBeNull();
    expect(isFirebaseConfigured()).toBe(false);
  });

  it("extracts config when all required environment variables are set", () => {
    process.env.NEXT_PUBLIC_FIREBASE_API_KEY = "test-key";
    process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN = "test.firebaseapp.com";
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = "test-project";
    process.env.NEXT_PUBLIC_FIREBASE_APP_ID = "1:12345:web:abcdef";

    const config = getFirebaseConfigFromEnv();
    expect(config).not.toBeNull();
    expect(config?.projectId).toBe("test-project");
    expect(isFirebaseConfigured()).toBe(true);
  });

  it("safely handles getFirebaseApp in environment without credentials", () => {
    delete process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
    delete process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

    expect(getFirebaseApp()).toBeNull();
    expect(getFirebaseAuth()).toBeNull();
    expect(getFirebaseFirestore()).toBeNull();
  });
});
