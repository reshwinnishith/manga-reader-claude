import {
  signInAnonymously,
  onAuthStateChanged,
  type User,
  type Auth,
} from "firebase/auth";
import { getFirebaseAuth } from "./firebase";

export interface AuthState {
  user: User | null;
  loading: boolean;
  error: Error | null;
}

let authPromise: Promise<User | null> | null = null;

/**
 * Ensures the client has a signed-in anonymous Firebase user.
 * Firebase Auth persists anonymous sessions in IndexedDB/localStorage
 * across page refreshes and browser restarts under the same domain.
 */
export async function ensureAnonymousUser(authInstance?: Auth): Promise<User | null> {
  const auth = authInstance ?? getFirebaseAuth();
  if (!auth) {
    return null;
  }

  if (auth.currentUser) {
    return auth.currentUser;
  }

  if (authPromise) {
    return authPromise;
  }

  authPromise = (async () => {
    try {
      // First wait for Firebase Auth to initialize existing persisted session if any
      await auth.authStateReady();
      if (auth.currentUser) {
        return auth.currentUser;
      }

      // No existing session: sign in anonymously
      const credential = await signInAnonymously(auth);
      return credential.user;
    } catch (err) {
      console.warn("Failed to sign in anonymously with Firebase Auth:", err);
      return null;
    } finally {
      authPromise = null;
    }
  })();

  return authPromise;
}

/**
 * Subscribes to Firebase Auth state changes.
 * Returns unsubscribe function.
 */
export function subscribeToAuthState(
  callback: (user: User | null) => void,
  authInstance?: Auth
): () => void {
  const auth = authInstance ?? getFirebaseAuth();
  if (!auth) {
    callback(null);
    return () => {};
  }

  return onAuthStateChanged(auth, (user) => {
    callback(user);
  });
}

/**
 * Synchronously returns current user if already signed in.
 */
export function getCurrentUser(authInstance?: Auth): User | null {
  const auth = authInstance ?? getFirebaseAuth();
  return auth?.currentUser ?? null;
}
