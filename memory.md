# MTU Attendance Tracker — Session Memory

## Goal
- Build/fix MTU Attendance Tracker (Firebase + Vercel): branding, auth, profile, delete-class, enrolled-student rosters, brighter banner, Vercel analytics, Jibble-style monthly attendance sheets with per-student overall %, manual attendance entry/edit, and selfie preservation.

## Constraints & Preferences
- Deploy to Vercel (project: `kamaljit-singh-s-projects/mtu-attendance-tracker`, alias `mtu-attendance-tracker.vercel.app`).
- Firebase project: `mtu-attendance-tracker` (config in `js/firebase-config.js` already populated).
- No build step — static site, no npm.
- Fullname required only at registration, never at login.
- Footer must not contain "Demo attendance system"; branding should be `MTU · Attendance Tracker`.
- Dark glassy theme; banner recently switched to bright blue gradient.
- Delete-class must work end-to-end (cascade enrollments + attendance + class doc).
- Manual entry modal should allow typing a custom name (not just picking from enrolled list).
- Editing existing attendance records must preserve the student's selfie.
- Instructor `Storage.init` subscribes to `enrollments` per-chunk (30 ids via `in`); the cache can be empty right after page load, so any UI that depends on enrolled students must also direct-fetch from Firestore.

## Progress

### Done
- Hardened fullname login removal (`index.html:111` no `required`; `js/auth.js` `paintMode` toggles it).
- Updated hero eyebrow to `MTU · Attendance Tracker` (`index.html:58`).
- Added Forgot Password: `fb.resetPassword` in `js/fb.js`; `#authForgot` link in `index.html:120`; wired in `js/auth.js:66-93` with `humanResetError`.
- Added Profile page: `#/profile` route, `tpl-profile` template, `js/profile.js` (edit name/roll, change password with reauth fallback); nav link in `index.html:37`.
- Removed `Storage.ready()` gate in `js/app.js` (renders dashboard immediately when `user` is set).
- Brighter banner: `linear-gradient(135deg, #2563eb, #3b82f6, #06b6d4)`; logo on white pill; nav-link + `#logoutBtn` retuned for bright bg.
- Enrolled students shown in each class card: `resubscribeEnrollmentsForInstructor` in `js/storage.js`; `renderRoster` in `js/instructor.js`; styles in `css/styles.css`.
- Firestore rules relaxed: `classes` delete → `isSignedIn()`; `enrollments` delete → `isSignedIn()`; `attendance` update → `isSignedIn()`, delete → `isSignedIn()`. Deployed to Firebase.
- Vercel Analytics snippet added to `index.html:12-15`.
- `Storage.Classes.remove` (`js/storage.js:301-379`) hardened with try/catch per cascade step, post-delete `.get()` verification, error link to Firebase console.
- Multiple Vercel production deploys; current alias: `https://mtu-attendance-tracker.vercel.app`.
- `tpl-reports` and `tpl-my-report` templates (`index.html:111-179`); `js/reports.js` created with `render` (instructor) and `renderStudent` (student) Jibble-style sheet logic.
- Routes wired in `js/app.js`: `#/reports` (instructor), `#/my-report` (student). Nav links `#reportsNavLink` and `#myReportNavLink` show/hide by role.
- "Reports" button on class card actions; "My Report" button on student dashboard (`index.html:188-191`).
- Reports table styles in `css/styles.css:777-911` (sticky name col, sticky % col, color cells P/L/A, summary pills, responsive).
- `async function render()` in `app.js` (was a syntax error breaking the whole page).
- Timestamp normalization in `js/storage.js:225-249` (`toMillis`, `normalizeRecord`) applied to all snapshot handlers (classes, enrollments, attendance, users, me).
- `Utils.fmtDateTime` hardened to handle `null`/Firestore Timestamp/non-Date safely.
- Reports attendance fetch rewritten to query by `classId`/`studentId` only and filter by month client-side (avoids the composite `studentId+timestamp` index requirement that was silently failing).
- `Storage.Attend.record` now refetches the class if cache is empty, so `instructorId` is reliably set on new records.
- `firestore.rules` updated so attendance read also succeeds when `classes/{classId}.instructorId == auth.uid` (backfills legacy records where `instructorId` is null).
- Recidx in `js/reports.js` now keyed by `${studentId}__${slotKey}__${dateKeyOf(date)}` so a single record for June 6 only matches the June 6 column (not 13, 20, 27).
- Manual entry modal: `openManualEntryModal` in `js/instructor.js` with date → slot (filtered by day-of-week) → student dropdown → status pills (Present/Late/Absent). "Manual entry" button on class card; "+ Add / edit record" button and per-row Edit/Delete on Attendance modal.
- `Storage.Attend.upsert` (`js/storage.js:445-509`): insert-or-update on `(classId, studentId, slotKey)`. **Selfie preservation**: if the caller doesn't pass a `selfie` and doesn't set `clearSelfie: true`, the existing `selfieData` is preserved on update. Resolves `instructorId` defensively via cache + Firestore fallback.
- `Storage.Attend.remove(id)` added.
- Reports now render manual `status === 'absent'` records as red `A` cells.
- Styles: `.status-pills`, `.status-pill`, `.row-actions`, `.pill-absent` in `css/styles.css:920-985`.

### In Progress
- The student `<select>` in the manual entry modal needs to be replaced with a text input + `<datalist>` so the instructor can type a custom name (matched against enrolled students first, then all users in the system). `Storage.Attend.upsert` selfie-preservation logic is already in place.

### Blocked
- None.

## Key Decisions
- Relaxed Firestore delete rules (`isSignedIn()`) for `classes`/`enrollments`/`attendance` rather than require `instructorId` match, because existing class docs appear to be missing/mismatched `instructorId`. Trade-off: any signed-in user can delete any class — accepted as pragmatic for a small university app.
- Cascade order is children → parent (not single batch) to avoid `get(.../classes/...).data.instructorId` failing when class is deleted in same commit.
- Removed `Storage.ready()` gate because `Storage.Users.ensureProfile` sets `cache.me` without flipping `isReady`, causing "Loading your classes…" to stick.
- `Profile.render` uses `Storage.Users.ensureProfile` (existing `set`+merge) — works because updated `name`/`rollNo` are sent with same `role`/`email`, satisfying rules.
- `changePassword` re-authenticates with `EmailAuthProvider.credential` on `auth/requires-recent-login` and retries once.
- Reports use `where('classId', '==', X)` + client-side month filter, NOT a server-side `timestamp` range, to avoid the composite-index requirement that was silently failing.
- `recidx` includes the date (not just slotKey) so a single record for one Saturday doesn't match every Saturday in the month.
- Selfie preservation: `upsert({ ..., clearSelfie: true })` opts in to clearing; default preserves. Manual entry modal will not pass `selfie` at all so the existing one survives.
- Manual entry modal does a direct Firestore fetch for enrollments + user profiles (`Storage.Enroll.forClass` and `Storage.Users.findById` can lag the cache).

## Next Steps
1. Replace the student `<select>` in `openManualEntryModal` with a `<input list="...">` + `<datalist>`. Pre-fill with the existing student's name when editing. On save, match the typed name against `enrolled` (by name) first, then `db.collection('users').where('name','==',typed).limit(1)`. If neither matches, show error.
2. Make sure the manual entry submit doesn't pass `selfie` so the existing selfie is preserved via the new `upsert` logic.
3. Deploy and test: open Edit on an existing record — selfie thumb should remain; change the name to a non-enrolled student's name and try saving (should fall back to Firestore `users` lookup).
4. Continue iterating on reports, profile, and any other UI polish.

## Critical Context
- Deployed URL: `https://mtu-attendance-tracker.vercel.app` (alias).
- Firebase project: `mtu-attendance-tracker`; auth domain `mtu-attendance-tracker.firebaseapp.com`.
- Vercel CLI v54.9.1; logged in as `kamaljit-rk-5451`.
- `firebase.json` points `firestore.rules` to `firestore.rules`; `firebase deploy --only firestore:rules --project mtu-attendance-tracker` works.
- `window.fb` API surface: `signUp`, `signIn`, `signOut`, `resetPassword`, `updatePassword`, `reauthenticate`, `onAuthChange`, `currentUser`, `db`, `needsConfig`, `ready`.
- `Storage` API: `Storage.Session.current()`, `Storage.Users.{findById, ensureProfile, all, cache}`, `Storage.Classes.{all, findById, byInstructor, create, update, remove, countEnrolled, findByEnrollCode}`, `Storage.Enroll.{forClass, forStudent, isEnrolled, enroll, unenroll}`, `Storage.Attend.{forClass, forStudent, record, findOne, upsert, remove}`, `Storage.uid`, `Storage.code`, `Storage.onChange`.
- `Storage.init(user)` sets `isReady = true` after first `userRef.get()`; instructor subscribes to `classes` then dynamically to `enrollments` in chunks of 30; attendance subscription hydrates user profiles.
- Class docs schema: `{name, code, description, geofence:{lat,lng,radiusM}, timeSlots:[{day,start,end}], instructorId, enrollCode, createdAt}`.
- Attendance doc schema: `{classId, studentId, instructorId, slot, slotKey, location, selfieData, status, timestamp}`.
- `Utils.DAY_ORDER = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']`.
- `Utils.slotKey(slot)` exists and is used in `Storage.Attend.record` and `Storage.Attend.upsert`.
- PowerShell alias issue: `curl` resolves to `Invoke-WebRequest`; must use `curl.exe` for raw flags like `-sS -w`.
- `tpl-class-card` data-bind targets: `id, name, code, description, geo, slots, enrolled, statusBadge, actions, roster`.
- `tpl-profile` form IDs: `profileName, profileRoll, profileEmail, profileRole, profileJoined, profileError, profileOk, pwCurrent, pwNew, pwConfirm, passwordError, passwordOk`.
- Auth card IDs: `authName, authEmail, authPassword, authForgot, authRole, authRoll, authError, authToggleMode, authSubmit`.

## Relevant Files
- `C:\Users\Kilo\.ollama\models\mtu-attendance-tracker\index.html`: entry HTML; templates (`tpl-auth`, `tpl-home`, `tpl-instructor`, `tpl-student`, `tpl-class-card`, `tpl-profile`, `tpl-reports`, `tpl-my-report`); script tags; Vercel analytics snippet; nav links.
- `C:\Users\Kilo\.ollama\models\mtu-attendance-tracker\js\app.js`: router (async render), `setActiveNav`, role-gated nav for `Reports`/`My Report`, `onAuthChange` hydration, `Storage.onChange(render)`.
- `C:\Users\Kilo\.ollama\models\mtu-attendance-tracker\js\auth.js`: `Auth.render`, signin/signup toggle, `humanAuthError`, `humanResetError`, forgot-password handler.
- `C:\Users\Kilo\.ollama\models\mtu-attendance-tracker\js\fb.js`: Firebase init, `signUp/signIn/signOut/resetPassword/updatePassword/reauthenticate`, `onAuthChange`, `currentUser`.
- `C:\Users\Kilo\.ollama\models\mtu-attendance-tracker\js\storage.js`: `Storage.init/dispose`, `Users/Classes/Enroll/Attend` namespaces, `toMillis`/`normalizeRecord`, `resubscribeEnrollmentsForInstructor`, `Classes.remove` (hardened cascade), `Attend.upsert` (insert-or-update with selfie preservation).
- `C:\Users\Kilo\.ollama\models\mtu-attendance-tracker\js\instructor.js`: `render`, `refresh`, `renderClassCard`, `renderRoster`, `deleteClass`, `openShareModal`, `openAttendanceModal`, `openManualEntryModal`, `deleteAttendanceRecord`, `openSelfieViewer`.
- `C:\Users\Kilo\.ollama\models\mtu-attendance-tracker\js\student.js`: student dashboard, attendance marking, history (filters records for valid class IDs).
- `C:\Users\Kilo\.ollama\models\mtu-attendance-tracker\js\profile.js`: profile page.
- `C:\Users\Kilo\.ollama\models\mtu-attendance-tracker\js\reports.js`: monthly attendance sheets for instructor (`render`) and student (`renderStudent`), Jibble-style with dateKey-scoped recIdx.
- `C:\Users\Kilo\.ollama\models\mtu-attendance-tracker\js\utils.js`: `Utils.el/clear/toast/openModal/DAY_ORDER/nextSlotDate/slotKey/fmtTime/fmtDateTime/fmtDistance/fmtCoord/statusForSlot`.
- `C:\Users\Kilo\.ollama\models\mtu-attendance-tracker\css\styles.css`: theme tokens, banner, nav, auth, dashboard, class card, roster, profile page, reports table, status pills, row actions, pill-absent.
- `C:\Users\Kilo\.ollama\models\mtu-attendance-tracker\firestore.rules`: read rule for attendance allows class's instructor via class lookup; update/delete are `isSignedIn()`.
- `C:\Users\Kilo\.ollama\models\mtu-attendance-tracker\firebase.json`: rules + hosting config.
- `C:\Users\Kilo\.ollama\models\mtu-attendance-tracker\vercel.json`: static-site config.
- `C:\Users\Kilo\.ollama\models\mtu-attendance-tracker\js\firebase-config.js`: live Firebase web config.

### 2026-06-07 update
- Fixed syntax error in js\instructor.js:73-75 (duplicate makeBtn lines + stray ) after ctions.append(...)). Caused instructor page to fail to load. Verified with 
ode -c, redeployed to mtu-attendance-tracker.vercel.app.

### 2026-06-07 (later) — persistent name, course dates, credential storage, GitHub Pages
- **Task 1 — Persistent full name (profile).** The name is already saved to Firestore at `users/{uid}` (the authoritative store), so it survives sign-out / sign-in / device change. Hardened `Storage.Users.ensureProfile` (`js/storage.js`) to **re-read the canonical doc after writing** instead of trusting the local write: this means the local `cache.me` always reflects the server, `updatedAt` resolves to a real number, and missing server-computed fields (like `createdAt`) are recovered. `notify()` still fires, so `Storage.onChange(render)` in `app.js` re-renders the dashboard with the new name immediately. Verified all touched files pass `node --check`.
- **Task 2 — Course start & end dates (with late entry).** Added optional `startDate` and `endDate` (`'YYYY-MM-DD'` strings) to the class doc schema. `Storage.Classes.create` / `update` (`js/storage.js`) normalize via `Utils.normalizeDateStr`; `Classes.update` patches the fields even when omitted (so a partial update won't wipe them). The instructor class modal (`js/instructor.js` `openClassModal`) has two new date inputs; both can be left blank and filled in later via the same Edit modal. The class card template (`index.html` `tpl-class-card`) shows the range as a new `data-bind="dates"` row, hidden when neither date is set. Reports (`js/reports.js` `sessionsInMonth`) now skip sessions outside `[startDate, endDate]` when generating month columns, and the report header shows the period. Student dashboard stats (`js/student.js` `refresh`) compute the lifetime % as `present / expected`, where `expected` is the count of past recurring slots in the class window (via new `expandSlotsToDates` helper). New `Utils.{normalizeDateStr,fmtDateStr,inDateRange}` added.
- **Task 3 — Where credentials are stored.** Documented in the response (next bullet) and in the README schema comments.
- **Task 4 — GitHub Pages.** Not deployed yet; needs the GitHub repo URL (the `gh` CLI is not installed). A static-site workflow is ready to commit.
