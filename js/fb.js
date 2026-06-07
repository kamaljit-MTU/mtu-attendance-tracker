/* =========================================================
   fb.js - Firebase initialization + auth helpers
   Requires:
     - firebase-config.js (window.FIREBASE_CONFIG)
     - firebase-app-compat, firebase-auth-compat, firebase-firestore-compat
       loaded via <script> in index.html
   (No Storage SDK: selfies are stored inline in Firestore docs
    to keep the project on the free tier.)
   ========================================================= */

(function () {
  const cfg = window.FIREBASE_CONFIG;
  const isPlaceholder = !cfg || !cfg.apiKey || cfg.apiKey.startsWith('REPLACE_');

  if (isPlaceholder) {
    window.fb = {
      ready: false,
      needsConfig: true,
      auth: null, db: null,
      signUp: async () => { throw new Error('Firebase is not configured. Edit js/firebase-config.js first.'); },
      signIn: async () => { throw new Error('Firebase is not configured. Edit js/firebase-config.js first.'); },
      signOut: async () => {},
      resetPassword: async () => { throw new Error('Firebase is not configured. Edit js/firebase-config.js first.'); },
      updatePassword: async () => { throw new Error('Firebase is not configured. Edit js/firebase-config.js first.'); },
      reauthenticate: async () => { throw new Error('Firebase is not configured. Edit js/firebase-config.js first.'); },
      onAuthChange: (_cb) => () => {},
      currentUser: () => null,
    };
    return;
  }

  firebase.initializeApp(cfg);
  const auth = firebase.auth();
  const db = firebase.firestore();

  // Offline persistence (cached locally; syncs when back online)
  if (window.FIREBASE_USE_EMULATORS) {
    auth.useEmulator('http://127.0.0.1:9099');
    db.useEmulator('127.0.0.1', 8080);
  } else {
    try { db.enablePersistence({ synchronizeTabs: true }); } catch (e) { /* multiple tabs etc. */ }
  }

  async function signUp({ email, password }) {
    const cred = await auth.createUserWithEmailAndPassword(email, password);
    return cred.user;
  }
  async function signIn({ email, password }) {
    const cred = await auth.signInWithEmailAndPassword(email, password);
    return cred.user;
  }
  async function signOut() { await auth.signOut(); }

  // Sends a password-reset email to the given address.
  async function resetPassword(email) {
    return auth.sendPasswordResetEmail(email);
  }

  // Updates the current user's password. Requires a recent sign-in
  // (within the last few minutes). If the session is too old, callers
  // should collect the current password and call `reauthenticate` first.
  async function updatePassword(newPassword) {
    const u = auth.currentUser;
    if (!u) throw new Error('Not signed in.');
    await u.updatePassword(newPassword);
    return u;
  }

  // Re-authenticates the current user with email + current password,
  // so a subsequent sensitive action (like updatePassword) succeeds.
  async function reauthenticate(email, currentPassword) {
    const u = auth.currentUser;
    if (!u) throw new Error('Not signed in.');
    const credential = firebase.auth.EmailAuthProvider.credential(email, currentPassword);
    await u.reauthenticateWithCredential(credential);
    return u;
  }

  function onAuthChange(cb) {
    return auth.onAuthStateChanged(cb);
  }
  function currentUser() { return auth.currentUser; }

  window.fb = {
    ready: true,
    needsConfig: false,
    auth, db,
    signUp, signIn, signOut,
    resetPassword, updatePassword, reauthenticate,
    onAuthChange,
    currentUser,
  };
})();
