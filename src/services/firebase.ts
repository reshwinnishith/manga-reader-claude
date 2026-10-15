import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";

export interface FirebaseClientConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId: string;
}

export function getFirebaseConfigFromEnv(): FirebaseClientConfig | null {
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  const authDomain = process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN;
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const storageBucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
  const messagingSenderId = process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID;
  const appId = process.env.NEXT_PUBLIC_FIREBASE_APP_ID;

  if (!apiKey || !authDomain || !projectId || !appId) {
    return null;
  }

  return {
    apiKey,
    authDomain,
    projectId,
    storageBucket,
    messagingSenderId,
    appId,
  };
}

export function isFirebaseConfigured(): boolean {
  return getFirebaseConfigFromEnv() !== null;
}

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
