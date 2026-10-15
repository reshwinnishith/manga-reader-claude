import {
  GoogleAuthProvider,
  linkWithPopup,
  onAuthStateChanged,
  signInAnonymously,
  signInWithCredential,
  signInWithPopup,
  type Auth,
  type User,
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

export type GoogleSignInResult =
  | { status: "already"; user: User }
  /** The anonymous account was upgraded in place: same user ID, same cloud data. */
  | { status: "linked"; user: User }
  /** The Google account already had cloud data from another device; local data merges into it on the next sync. */
  | { status: "signed-in"; user: User; previousAnonymousUid?: string };

const CREDENTIAL_IN_USE = new Set(["auth/credential-already-in-use", "auth/email-already-in-use"]);

/**
 * Google sign-in that never discards data (not wired to any UI or enabled by
 * default; it needs the Google provider enabled in the Firebase project):
 *
 * - Anonymous user: link the Google credential to it. The user ID is unchanged,
 *   so the cloud data already stored under it is kept and becomes reachable from
 *   other devices that sign in with the same Google account.
 * - Google account already linked elsewhere (`credential-already-in-use`, e.g. it
 *   was set up on another device): sign in to that account instead. This device's
 *   library is still complete in localStorage, and the next sync merges it into
 *   the account's snapshot; the abandoned anonymous user's cloud copy is left in
 *   place (see docs/firebase-sync-architecture.md for cleanup).
 * - No user yet: plain Google sign-in.
 */
export async function signInWithGoogleSafely(
  authInstance?: Auth,
  provider: GoogleAuthProvider = new GoogleAuthProvider(),
): Promise<GoogleSignInResult> {
  const auth = authInstance ?? getFirebaseAuth();
  if (!auth) throw new Error("Firebase is not configured.");

  const current = auth.currentUser;
  if (current && !current.isAnonymous && current.providerData.some((p) => p.providerId === "google.com")) {
    return { status: "already", user: current };
  }
  if (!current) {
    const credential = await signInWithPopup(auth, provider);
    return { status: "signed-in", user: credential.user };
  }
  if (!current.isAnonymous) {
    // Signed in with another provider: link Google as an additional sign-in method.
    return { status: "linked", user: (await linkWithPopup(current, provider)).user };
  }
  try {
    return { status: "linked", user: (await linkWithPopup(current, provider)).user };
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (!code || !CREDENTIAL_IN_USE.has(code)) throw error;
    const credential = GoogleAuthProvider.credentialFromError(error as Parameters<typeof GoogleAuthProvider.credentialFromError>[0]);
    if (!credential) throw error;
    const previousAnonymousUid = current.uid;
    const signedIn = await signInWithCredential(auth, credential);
    return { status: "signed-in", user: signedIn.user, previousAnonymousUid };
  }
}
