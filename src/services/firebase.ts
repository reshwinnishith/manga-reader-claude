import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";
import { getFirebaseConfigFromEnv, type FirebaseClientConfig } from "./firebase-config";

export { getFirebaseConfigFromEnv, isFirebaseConfigured, type FirebaseClientConfig } from "./firebase-config";

let cachedApp: FirebaseApp | null = null;
let cachedAuth: Auth | null = null;
let cachedFirestore: Firestore | null = null;

export function getFirebaseApp(customConfig?: FirebaseClientConfig): FirebaseApp | null {
  if (typeof window === "undefined") {
    return null;
  }

  if (cachedApp) {
    return cachedApp;
  }

  const existingApps = getApps();
  if (existingApps.length > 0) {
    cachedApp = existingApps[0] ?? null;
    return cachedApp;
  }

  const config = customConfig ?? getFirebaseConfigFromEnv();
  if (!config) {
    return null;
  }

  try {
    cachedApp = initializeApp(config);
    return cachedApp;
  } catch (err) {
    console.warn("Failed to initialize Firebase app:", err);
    return null;
  }
}

export function getFirebaseAuth(app?: FirebaseApp): Auth | null {
  if (typeof window === "undefined") {
    return null;
  }

  if (cachedAuth) {
    return cachedAuth;
  }

  const targetApp = app ?? getFirebaseApp();
  if (!targetApp) {
    return null;
  }

  try {
    cachedAuth = getAuth(targetApp);
    return cachedAuth;
  } catch (err) {
    console.warn("Failed to initialize Firebase Auth:", err);
    return null;
  }
}

export function getFirebaseFirestore(app?: FirebaseApp): Firestore | null {
  if (typeof window === "undefined") {
    return null;
  }

  if (cachedFirestore) {
    return cachedFirestore;
  }

  const targetApp = app ?? getFirebaseApp();
  if (!targetApp) {
    return null;
  }

  try {
    cachedFirestore = getFirestore(targetApp);
    return cachedFirestore;
  } catch (err) {
    console.warn("Failed to initialize Firestore:", err);
    return null;
  }
}

/** Reset cached instances for isolated test environments */
export function resetFirebaseClientForTesting(): void {
  cachedApp = null;
  cachedAuth = null;
  cachedFirestore = null;
}
