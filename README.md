# MTU Attendance Tracker

A geofenced, time-bound, selfie-verified attendance system for Manipur Technical University. Built as a single-page static app backed by **Firebase** (Auth + Firestore + Storage) and deployed on **Vercel**.

## Features

- Email/password sign-up and sign-in (Firebase Auth)
- Instructor dashboard: create / edit / delete classes with geofence and time slots, shareable enrollment links, real-time attendance with selfie verification
- Student dashboard: enroll by code or link, mark attendance from inside the geofence during the time window, with a live webcam selfie
- Selfies are compressed and stored **inline in the Firestore document** — no Firebase Storage needed, so the whole app stays on the free tier
- Offline-tolerant: Firestore caches locally; syncs when the connection returns

## Project structure

```
index.html             entry HTML
js/
  firebase-config.js   <-- PUT YOUR FIREBASE CONFIG HERE
  fb.js                Firebase init + auth helpers
  storage.js           Firestore-backed data layer (Storage.Users/Classes/Enroll/Attend/Session)
  auth.js              sign-in / sign-up UI + flow
  instructor.js        instructor dashboard
  student.js           student dashboard
  selfie.js            webcam capture
  geofence.js          GPS + distance helpers
  utils.js             DOM + formatting helpers
css/styles.css         styles
firestore.rules        Firestore security rules
firebase.json          Firebase project config
vercel.json            Vercel static-site config
```

## One-time setup

### 1. Create a Firebase project

1. Open <https://console.firebase.google.com/> and create (or pick) a project.
2. **Authentication → Get started → Sign-in method → Email/Password** → enable.
3. **Firestore Database → Create database → Production mode** → choose a region.
4. **Project settings (gear icon) → General → Your apps → `</>` (Web app)**
   - Give it a nickname (e.g. `mtu-attendance-web`).
   - Skip "Firebase Hosting" — we are deploying to Vercel.
   - Copy the `firebaseConfig` object.

### 2. Paste your config

Open `js/firebase-config.js` and replace each `REPLACE_…` with the matching value from the Firebase console:

```js
window.FIREBASE_CONFIG = {
  apiKey:            "AIza...",
  authDomain:        "your-project.firebaseapp.com",
  projectId:         "your-project",
  storageBucket:     "your-project.appspot.com",
  messagingSenderId: "1234567890",
  appId:             "1:1234567890:web:abcdef",
};
```

(The `storageBucket` field stays in the config because Firebase requires it, but the app does not use Storage. Selfies go straight into Firestore.)

### 3. Deploy the security rules

Install the Firebase CLI (once):

```bash
npm install -g firebase-tools
firebase login
```

From the project root:

```bash
firebase use --add           # pick your project
firebase deploy --only firestore:rules
```

This pushes `firestore.rules` to your project.

### 4. (Optional) Add authorized domains

In the Firebase console → **Authentication → Settings → Authorized domains**, add the domain you deploy to (e.g. `mtu-attendance.vercel.app`). `localhost` and `127.0.0.1` are already allowed for local testing.

## Run locally

```bash
# any static file server will do
python -m http.server 8765
# then open http://127.0.0.1:8765/
```

If you want to develop against the Firebase emulator suite, set `window.FIREBASE_USE_EMULATORS = true` in `js/firebase-config.js` and run `firebase emulators:start` (Auth on 9099, Firestore on 8080, Storage on 9199).

## Deploy to Vercel

### Option A — CLI

```bash
npm install -g vercel
vercel              # follow prompts; pick this folder
vercel --prod       # promote to production
```

That's it. Vercel auto-detects the static site; `vercel.json` adds security headers.

### Option B — Git integration

1. Push this folder to a GitHub/GitLab/Bitbucket repo.
2. In the Vercel dashboard, **Add New Project → Import** the repo.
3. Leave build settings blank (it's a static site).
4. **Deploy**. Each push to the default branch auto-deploys.

## Deploy to GitHub Pages

GitHub Pages serves static sites from a branch root or `/docs` folder. The project is
already a static site at the repo root, so no build step is required.

### One-time setup

1. **Push to GitHub** (skip if already there):
   ```bash
   git init
   git add .
   git commit -m "Initial MTU Attendance Tracker"
   git branch -M main
   git remote add origin https://github.com/kamaljit-MTU/mtu-attendance-tracker.git
   git push -u origin main
   ```
2. **Enable Pages**: GitHub repo → **Settings → Pages** → Source: **Deploy from a branch** → Branch: `main` / `(root)`. Save. The site will be available at
   `https://kamaljit-MTU.github.io/mtu-attendance-tracker/`.

### Required Firebase Auth change

The Firebase project must allow your GitHub Pages domain to issue sign-in tokens.

Firebase console → **Authentication → Settings → Authorized domains** → **Add domain** → add
`kamaljit-MTU.github.io`. (For project subdomains, also add `mtu-attendance-tracker.firebaseapp.com`
and `localhost`, which are usually already present.)

Without this, users will see `Firebase: Error (auth/unauthorized-domain)` when signing in
on the GitHub Pages URL.

### Notes

- The Vercel analytics snippet in `index.html` is loaded **only** when the site is hosted on
  `*.vercel.app`; on GitHub Pages it's a no-op.
- The `firebase-config.js` API key is a public web key, safe to commit and publish.
- `vercel.json` is ignored by GitHub Pages but is harmless to keep.
- The `caveman/` folder and `node_modules/` are git-ignored; they aren't part of the app.

## How it works (architecture in 60 seconds)

- **Auth**: Firebase Auth (email/password). The first time a user signs up, the app writes a profile doc at `users/{uid}` containing `{ name, email, role, rollNo, createdAt }`.
- **Classes**: stored in `classes/{classId}`. Each class has `geofence:{lat,lng,radiusM}`, `timeSlots:[…]`, `enrollCode` (a random 6-char code), and `instructorId`.
- **Enrollments**: stored in `enrollments/{classId}__{studentId}` so a student cannot be enrolled in the same class twice.
- **Attendance**: stored in `attendance/{autoId}`. The student's selfie is captured as a compressed JPEG (~8–15 KB at 320×240 @ 0.55 quality) and stored **inline** in the `selfieData` field of the same document — no Storage bucket, no bandwidth charges. Instructors display the dataURL directly.
- **Realtime updates**: each user subscribes to just the collections they need (their own classes, their own enrollments, their own attendance). New data appears instantly on screen — no manual refresh.
- **Offline**: Firestore persists the cache in IndexedDB, so the app keeps working on flaky campus Wi-Fi.

## Security

- The Firestore rules (see `firestore.rules`) enforce:
  - Only signed-in users can read anything.
  - Users can write only their own profile, and they cannot change their own `role` or `email` after the fact.
  - Anyone can read the public class list (so the enrollment-code lookup works), but only the class's `instructorId` can create / update / delete it.
  - Students can only create enrollment and attendance records for themselves.
## Going beyond the demo

When you are ready to use it in production:

1. **Restrict by email domain**: in `js/auth.js`, after `fb.signUp`, reject addresses that don't end in `@mtu.ac.in`. Alternatively, enforce this with Firebase Auth's built-in email-domain allowlist (Blaze plan only).
2. **Pin the role**: the role is self-selected today. For a real rollout, lock it down by creating accounts for instructors in the Firebase console with a pre-set role, or use Cloud Functions to set the role server-side from an authoritative list.
3. **Custom domain**: in Vercel → Project → Settings → Domains, add `attendance.mtu.ac.in` (or whatever your university IT provides).
4. **Capacity planning**: the Firestore free tier (Spark) gives you 1 GiB of storage and 50K reads/day. With ~10 KB per selfie, you can fit about 100,000 attendance records before you need to upgrade — more than enough for years of a typical class. If you ever outgrow it, the cheapest upgrade is Cloudflare R2 (10 GB free, free egress) instead of Firebase Storage.

## Troubleshooting

- **"Firebase: Error (auth/unauthorized-domain)"** — add your Vercel domain to Firebase Auth → Authorized domains.
- **"Missing or insufficient permissions"** — the security rules were not deployed. Run `firebase deploy --only firestore:rules` again.
- **App shows "Firebase not configured"** — you forgot to paste the config in `js/firebase-config.js`. The placeholder values start with `REPLACE_`; replace them.
- **Selfie modal opens but the camera is blank** — the browser denied camera permission, or you are on `http://` outside localhost. Vercel serves over HTTPS so the deployed app is fine; locally use `http://127.0.0.1` (not `0.0.0.0`).
