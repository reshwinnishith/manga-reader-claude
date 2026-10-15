import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Auth, User } from "firebase/auth";

const sdk = vi.hoisted(() => ({
  linkWithPopup: vi.fn(),
  signInWithPopup: vi.fn(),
  signInWithCredential: vi.fn(),
  signInAnonymously: vi.fn(),
  credentialFromError: vi.fn(),
}));

vi.mock("firebase/auth", () => ({
  GoogleAuthProvider: class { static credentialFromError = sdk.credentialFromError; },
  linkWithPopup: sdk.linkWithPopup,
  signInWithPopup: sdk.signInWithPopup,
  signInWithCredential: sdk.signInWithCredential,
  signInAnonymously: sdk.signInAnonymously,
  onAuthStateChanged: vi.fn(),
}));
vi.mock("./firebase", () => ({ getFirebaseAuth: () => null }));

import { signInWithGoogleSafely } from "./firebase-auth";

const user = (uid: string, isAnonymous: boolean, providers: string[] = []) =>
  ({ uid, isAnonymous, providerData: providers.map((providerId) => ({ providerId })) }) as unknown as User;
const authWith = (currentUser: User | null) => ({ currentUser }) as unknown as Auth;
const failure = (code: string) => Object.assign(new Error(code), { code });

beforeEach(() => {
  Object.values(sdk).forEach((fn) => fn.mockReset());
});

describe("Google sign-in with safe anonymous-account linking", () => {
  it("upgrades an anonymous account in place: same user ID, so its cloud data is kept", async () => {
    const anonymous = user("anon-1", true);
    sdk.linkWithPopup.mockResolvedValue({ user: user("anon-1", false, ["google.com"]) });
    const result = await signInWithGoogleSafely(authWith(anonymous));
    expect(result.status).toBe("linked");
    expect(result.user.uid).toBe("anon-1");
    expect(sdk.linkWithPopup).toHaveBeenCalledWith(anonymous, expect.anything());
    expect(sdk.signInWithCredential).not.toHaveBeenCalled();
    expect(sdk.signInWithPopup).not.toHaveBeenCalled();
  });

  it("when the Google account already exists (another device), signs in to it and reports the abandoned anonymous user", async () => {
    const credential = { providerId: "google.com" };
    sdk.linkWithPopup.mockRejectedValue(failure("auth/credential-already-in-use"));
    sdk.credentialFromError.mockReturnValue(credential);
    sdk.signInWithCredential.mockResolvedValue({ user: user("google-uid", false, ["google.com"]) });
    const result = await signInWithGoogleSafely(authWith(user("anon-1", true)));
    expect(result).toMatchObject({ status: "signed-in", previousAnonymousUid: "anon-1" });
    expect(result.user.uid).toBe("google-uid");
    expect(sdk.signInWithCredential).toHaveBeenCalledWith(expect.anything(), credential);
  });

  it("does not switch accounts if the existing account's credential cannot be recovered from the error", async () => {
    sdk.linkWithPopup.mockRejectedValue(failure("auth/credential-already-in-use"));
    sdk.credentialFromError.mockReturnValue(null);
    await expect(signInWithGoogleSafely(authWith(user("anon-1", true)))).rejects.toThrow("auth/credential-already-in-use");
    expect(sdk.signInWithCredential).not.toHaveBeenCalled();
  });

  it.each(["auth/popup-closed-by-user", "auth/popup-blocked", "auth/operation-not-allowed", "auth/network-request-failed"])(
    "leaves the anonymous session untouched on %s",
    async (code) => {
      sdk.linkWithPopup.mockRejectedValue(failure(code));
      await expect(signInWithGoogleSafely(authWith(user("anon-1", true)))).rejects.toThrow(code);
      expect(sdk.signInWithCredential).not.toHaveBeenCalled();
      expect(sdk.signInWithPopup).not.toHaveBeenCalled();
      expect(sdk.signInAnonymously).not.toHaveBeenCalled();
    },
  );

  it("does nothing when already signed in with Google", async () => {
    const result = await signInWithGoogleSafely(authWith(user("g", false, ["google.com"])));
    expect(result.status).toBe("already");
    expect(sdk.linkWithPopup).not.toHaveBeenCalled();
  });

  it("signs in normally when no user exists, and links Google to a user of another provider", async () => {
    sdk.signInWithPopup.mockResolvedValue({ user: user("new", false, ["google.com"]) });
    expect((await signInWithGoogleSafely(authWith(null))).status).toBe("signed-in");
    sdk.linkWithPopup.mockResolvedValue({ user: user("email-1", false, ["password", "google.com"]) });
    expect((await signInWithGoogleSafely(authWith(user("email-1", false, ["password"])))).status).toBe("linked");
  });

  it("fails clearly when Firebase is not configured", async () => {
    await expect(signInWithGoogleSafely()).rejects.toThrow("not configured");
  });
});
