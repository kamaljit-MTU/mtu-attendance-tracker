/* =========================================================
   storage.js - Firestore-backed data layer
    Schema (Firestore):
      users/{uid}            { name, email, role, rollNo, createdAt }
      classes/{classId}      { name, code, description, instructorId,
                               geofence:{lat,lng,radiusM},
                               timeSlots:[{day,start,end}],
                               startDate, endDate,     // YYYY-MM-DD strings; both optional
                               enrollCode, createdAt }
     enrollments/{id}       { classId, studentId, enrolledAt }
     attendance/{id}        { classId, studentId, slot, slotKey,
                              location, selfieData, status, timestamp }
                              ^ selfieData is an inline JPEG dataURL
                                (~8-15KB each, well under the 1MB doc limit).
                                No Firebase Storage needed -> stays on the
                                free tier.

     Storage.init(user)            -> subscribes to live data for this user
     Storage.dispose()             -> unsubscribes
     Storage.ready                 -> boolean: cache hydrated enough to render

     Storage.Users.findById(id)
     Storage.Users.findByEmail(e)  -> not used in production (kept for parity)
     Storage.Users.ensureProfile() -> create/update users/{uid} from auth profile
     Storage.Users.all()           -> denormalized map of relevant users
     Storage.Users.cache()         -> raw map for fast lookups (id->user)

     Storage.Classes.all()
     Storage.Classes.findById(id)
     Storage.Classes.byInstructor(id)
     Storage.Classes.findByEnrollCode(code)
     Storage.Classes.create(data)
     Storage.Classes.update(id, patch)
     Storage.Classes.remove(id)
     Storage.Classes.countEnrolled(id)

     Storage.Enroll.all()
     Storage.Enroll.forStudent(id)
     Storage.Enroll.forClass(id)
     Storage.Enroll.isEnrolled(classId, studentId)
     Storage.Enroll.enroll(classId, studentId)
     Storage.Enroll.unenroll(classId, studentId)

     Storage.Attend.all()
     Storage.Attend.forStudent(id)
     Storage.Attend.forClass(id)
     Storage.Attend.findOne(classId, studentId, slotKey)
     Storage.Attend.record({ classId, studentId, slot, slotKey, location, status, selfie })
       ^ if `selfie` is a dataURL, uploads to Storage and stores the download URL
         in `selfieUrl`. If null, no selfie is attached.

     Storage.Session.current()
     Storage.Session.signOut()
   ========================================================= */

const Storage = (() => {
  // ----- In-memory cache -----
  const cache = {
    me: null,           // current user (from Firestore users/{uid})
    classes: [],        // all classes the user can see
    enrollments: [],    // all enrollments relevant to the user
    attendance: [],     // all attendance records relevant to the user
    users: {},          // id -> user profile (instructors + students encountered)
  };
  let unsubscribers = [];
  let enrollmentUnsubs = []; // instructor-only: per-chunk enrollment listeners
  let isReady = false;
  const onChangeCbs = [];
  function notify() { onChangeCbs.forEach(cb => { try { cb(); } catch (e) { console.error(e); } }); }

  function getDb()  { return window.fb && window.fb.db; }

  function uid() { return getDb().collection('_').doc().id; }
  function code(len = 6) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
    return out;
  }
  async function uniqueEnrollCode() {
    for (let i = 0; i < 6; i++) {
      const c = code(6);
      const snap = await getDb().collection('classes').where('enrollCode', '==', c).limit(1).get();
      if (snap.empty) return c;
    }
    return code(8);
  }

  // ----- init / dispose -----
  async function init(user) {
    dispose();
    if (!user) { cache.me = null; isReady = false; return; }
    // Load own profile doc (or create it on first login)
    const userRef = getDb().collection('users').doc(user.uid);
    const snap = await userRef.get();
    if (!snap.exists) {
      const role = (window.__pendingRole) || 'student';
      window.__pendingRole = null;
      await userRef.set({
        name: user.displayName || (user.email || '').split('@')[0],
        email: (user.email || '').toLowerCase(),
        role,
        rollNo: (window.__pendingRoll) || '',
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    } else if (window.__pendingRole) {
      // Profile exists but caller asked to set role (e.g. a returning user picked a different role)
      await userRef.update({ role: window.__pendingRole, rollNo: window.__pendingRoll || snap.data().rollNo || '' });
      window.__pendingRole = null;
      window.__pendingRoll = null;
    }
    const meSnap = await userRef.get();
    const meData = meSnap.data();
    cache.me = normalizeRecord({ id: user.uid, ...meData, createdAt: meData.createdAt?.toMillis?.() || Date.now() });
    isReady = true;

    // Subscribe to my classes (instructor: byInstructor; student: by enrollment)
    if (cache.me.role === 'instructor') {
      const u = getDb().collection('classes').where('instructorId', '==', user.uid)
        .onSnapshot(snap => {
          cache.classes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
          // (Re)subscribe to enrollments for the current set of class IDs,
          // so the instructor dashboard can show the enrolled students.
          resubscribeEnrollmentsForInstructor();
          notify();
        });
      unsubscribers.push(u);
    } else {
      // Student: start with enrollments, then load classes for those
      const u = getDb().collection('enrollments').where('studentId', '==', user.uid)
        .onSnapshot(async (snap) => {
          cache.enrollments = snap.docs.map(d => normalizeRecord({ id: d.id, ...d.data() }));
          const classIds = cache.enrollments.map(e => e.classId);
          if (classIds.length === 0) { cache.classes = []; notify(); return; }
          // Firestore 'in' supports up to 30 ids per query
          const chunks = [];
          for (let i = 0; i < classIds.length; i += 30) chunks.push(classIds.slice(i, i + 30));
          const fetched = [];
          for (const ch of chunks) {
            const cs = await getDb().collection('classes').where(firebase.firestore.FieldPath.documentId(), 'in', ch).get();
            cs.forEach(d => fetched.push({ id: d.id, ...d.data() }));
          }
          cache.classes = fetched;
          notify();
        });
      unsubscribers.push(u);
    }

    // Subscribe to attendance relevant to me
    if (cache.me.role === 'instructor') {
      // All attendance for my classes
      const u = getDb().collection('attendance')
        .where('instructorId', '==', user.uid)
        .onSnapshot(snap => {
          cache.attendance = snap.docs.map(d => normalizeRecord({ id: d.id, ...d.data() }));
          // Hydrate user profiles referenced by these records
          hydrateUsers(cache.attendance.map(r => r.studentId));
          notify();
        });
      unsubscribers.push(u);
    } else {
      // My own attendance
      const u = getDb().collection('attendance')
        .where('studentId', '==', user.uid)
        .onSnapshot(snap => {
          cache.attendance = snap.docs.map(d => normalizeRecord({ id: d.id, ...d.data() }));
          notify();
        });
      unsubscribers.push(u);
    }
  }

  function dispose() {
    unsubscribers.forEach(u => { try { u(); } catch (e) {} });
    unsubscribers = [];
    enrollmentUnsubs.forEach(u => { try { u(); } catch (e) {} });
    enrollmentUnsubs = [];
    cache.me = null;
    cache.classes = [];
    cache.enrollments = [];
    cache.attendance = [];
    cache.users = {};
    isReady = false;
  }

  // Instructor helper: subscribe to enrollments for the current set of
  // class IDs (chunked to respect Firestore's 30-item `in` limit). Called
  // every time the class list changes.
  function resubscribeEnrollmentsForInstructor() {
    enrollmentUnsubs.forEach(u => { try { u(); } catch (e) {} });
    enrollmentUnsubs = [];
    const classIds = cache.classes.map(c => c.id);
    if (classIds.length === 0) {
      cache.enrollments = [];
      return;
    }
    const chunks = [];
    for (let i = 0; i < classIds.length; i += 30) chunks.push(classIds.slice(i, i + 30));
    for (const ch of chunks) {
      const eUnsub = getDb().collection('enrollments').where('classId', 'in', ch)
        .onSnapshot(esnap => {
          const newOnes = esnap.docs.map(d => normalizeRecord({ id: d.id, ...d.data() }));
          // Replace enrollments whose classId is in this chunk; keep the rest.
          const keep = cache.enrollments.filter(e => !ch.includes(e.classId));
          cache.enrollments = [...keep, ...newOnes];
          // Hydrate user profiles for the enrolled students so the dashboard
          // can show their names.
          hydrateUsers(newOnes.map(e => e.studentId));
          notify();
        });
      enrollmentUnsubs.push(eUnsub);
    }
  }

  async function hydrateUsers(ids) {
    const missing = ids.filter(id => id && !cache.users[id]);
    if (missing.length === 0) return;
    const chunks = [];
    for (let i = 0; i < missing.length; i += 30) chunks.push(missing.slice(i, i + 30));
    for (const ch of chunks) {
      const snap = await getDb().collection('users').where(firebase.firestore.FieldPath.documentId(), 'in', ch).get();
      snap.forEach(d => { cache.users[d.id] = normalizeRecord({ id: d.id, ...d.data() }); });
    }
  }

  function onChange(cb) { onChangeCbs.push(cb); return () => { const i = onChangeCbs.indexOf(cb); if (i >= 0) onChangeCbs.splice(i, 1); }; }

  // Normalize a Firestore Timestamp-like value to a number (epoch ms).
  // Records from snapshots carry raw Firestore Timestamps; converting them
  // here means downstream code can do `new Date(r.timestamp)` safely.
  function toMillis(v) {
    if (v == null) return v;
    if (typeof v === 'number') return v;
    if (v && typeof v.toMillis === 'function') return v.toMillis();
    if (v && typeof v.toDate === 'function') return v.toDate().getTime();
    return v;
  }
  function normalizeRecord(rec) {
    if (!rec) return rec;
    if (rec.timestamp != null) rec.timestamp = toMillis(rec.timestamp);
    if (rec.enrolledAt != null) rec.enrolledAt = toMillis(rec.enrolledAt);
    if (rec.createdAt != null) rec.createdAt = toMillis(rec.createdAt);
    if (rec.updatedAt != null) rec.updatedAt = toMillis(rec.updatedAt);
    return rec;
  }

  // ----- Users -----
  const Users = {
    all() { return Object.values(cache.users); },
    cache() { return cache.users; },
    findById(id) { return cache.users[id] || null; },
    findByEmail(email) { return Object.values(cache.users).find(u => (u.email || '').toLowerCase() === (email || '').toLowerCase()) || null; },
    async ensureProfile({ name, email, role, rollNo }) {
      const user = window.fb.currentUser();
      if (!user) throw new Error('Not signed in');
      const ref = getDb().collection('users').doc(user.uid);
      const data = {
        name, email: (email || '').toLowerCase(), role,
        rollNo: role === 'student' ? (rollNo || '') : '',
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      };
      // Write to Firestore. This is the authoritative store; the name will
      // survive sign-out, sign-in, browser refresh, and any device.
      await ref.set(data, { merge: true });
      // Re-read the canonical doc so the local cache reflects whatever the
      // server actually stored (including server-computed fields like
      // `createdAt` if it was missing) and `updatedAt` resolves to a number.
      const fresh = await ref.get();
      const freshData = fresh.exists ? (fresh.data() || {}) : {};
      const normalized = normalizeRecord({
        id: user.uid,
        name: freshData.name || name,
        email: freshData.email || (email || '').toLowerCase(),
        role: freshData.role || role,
        rollNo: freshData.rollNo != null ? freshData.rollNo : (role === 'student' ? (rollNo || '') : ''),
        createdAt: freshData.createdAt?.toMillis?.() || cache.me?.createdAt || Date.now(),
        updatedAt: freshData.updatedAt?.toMillis?.() || Date.now(),
      });
      cache.users[user.uid] = normalized;
      cache.me = normalized;
      notify();
      return normalized;
    },
  };

  // ----- Classes -----
  const Classes = {
    all() { return cache.classes.slice(); },
    findById(id) { return cache.classes.find(c => c.id === id) || null; },
    byInstructor(id) { return cache.classes.filter(c => c.instructorId === id); },
    async findByEnrollCode(c) {
      const target = (c || '').trim().toUpperCase();
      const snap = await getDb().collection('classes').where('enrollCode', '==', target).limit(1).get();
      if (snap.empty) return null;
      const d = snap.docs[0];
      return { id: d.id, ...d.data() };
    },
    async create(data) {
      const geoIn = data.geofence || {};
      const cls = {
        name: data.name,
        code: (data.code || '').toUpperCase(),
        description: data.description || '',
        geofence: {
          lat: Number(geoIn.lat ?? data.lat) || 0,
          lng: Number(geoIn.lng ?? data.lng) || 0,
          radiusM: Math.max(20, Number(geoIn.radiusM ?? data.radiusM) || 100),
        },
        timeSlots: (data.timeSlots || []).map(s => ({ day: s.day, start: s.start, end: s.end })),
        startDate: Utils.normalizeDateStr(data.startDate),   // 'YYYY-MM-DD' or null
        endDate: Utils.normalizeDateStr(data.endDate),
        instructorId: data.instructorId,
        enrollCode: await uniqueEnrollCode(),
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      };
      const ref = await getDb().collection('classes').add(cls);
      const fresh = { id: ref.id, ...cls, createdAt: Date.now() };
      cache.classes.push(fresh);
      notify();
      return fresh;
    },
    async update(id, patch) {
      const ref = getDb().collection('classes').doc(id);
      const out = { ...patch };
      if (patch.geofence) {
        out.geofence = {
          lat: Number(patch.geofence.lat) || 0,
          lng: Number(patch.geofence.lng) || 0,
          radiusM: Math.max(20, Number(patch.geofence.radiusM) || 100),
        };
      }
      if (patch.timeSlots) {
        out.timeSlots = patch.timeSlots.map(s => ({ day: s.day, start: s.start, end: s.end }));
      }
      if ('startDate' in patch) out.startDate = Utils.normalizeDateStr(patch.startDate);
      if ('endDate' in patch) out.endDate = Utils.normalizeDateStr(patch.endDate);
      await ref.update(out);
      const i = cache.classes.findIndex(c => c.id === id);
      if (i >= 0) cache.classes[i] = { ...cache.classes[i], ...out };
      notify();
      return cache.classes[i] || null;
    },
    async remove(id) {
      const db = getDb();
      if (!db) throw new Error('Firestore is not available.');

      const classRef = db.collection('classes').doc(id);
      const classSnap = await classRef.get();
      if (!classSnap.exists) {
        // Already gone; just clean the cache and bail.
        cache.classes = cache.classes.filter(c => c.id !== id);
        cache.enrollments = cache.enrollments.filter(e => e.classId !== id);
        cache.attendance = cache.attendance.filter(a => a.classId !== id);
        notify();
        return cache.classes;
      }

      // 1) Enrollments (best-effort; tolerate "already gone")
      try {
        const enr = await db.collection('enrollments').where('classId', '==', id).get();
        for (let i = 0; i < enr.docs.length; i += 500) {
          const batch = db.batch();
          enr.docs.slice(i, i + 500).forEach(d => batch.delete(d.ref));
          await batch.commit();
        }
      } catch (err) {
        console.warn('Enrollments cascade failed (continuing):', err && err.code, err && err.message);
      }

      // 2) Attendance (best-effort)
      try {
        const att = await db.collection('attendance').where('classId', '==', id).get();
        for (let i = 0; i < att.docs.length; i += 500) {
          const batch = db.batch();
          att.docs.slice(i, i + 500).forEach(d => batch.delete(d.ref));
          await batch.commit();
        }
      } catch (err) {
        console.warn('Attendance cascade failed (continuing):', err && err.code, err && err.message);
      }

      // 3) The class itself. With the relaxed rules (`isSignedIn()`) this
      //    should always succeed. If it still fails, we surface the exact
      //    code so the user can act.
      try {
        await classRef.delete();
      } catch (err) {
        const code = err && err.code;
        const msg = err && err.message;
        console.error('Class doc delete failed', { code, message: msg, id });
        if (code === 'permission-denied' || code === 'unauthenticated') {
          throw new Error(
            `Firestore rejected the delete (${code}). This usually means the deployed ` +
            `rules on the server are older than firestore.rules in this project. ` +
            `Run \`firebase deploy --only firestore:rules\` and hard-refresh ` +
            `(Ctrl/Cmd+Shift+R). If it still fails, open the Firebase console → ` +
            `Firestore → classes and delete the document by hand: ` +
            `https://console.firebase.google.com/project/mtu-attendance-tracker/firestore/data/classes/${id}`
          );
        }
        throw err;
      }

      // Verify
      const verify = await classRef.get();
      if (verify.exists) {
        throw new Error('Class document still exists after delete attempt.');
      }

      cache.classes = cache.classes.filter(c => c.id !== id);
      cache.enrollments = cache.enrollments.filter(e => e.classId !== id);
      cache.attendance = cache.attendance.filter(a => a.classId !== id);
      notify();
      return cache.classes;
    },
    countEnrolled(id) { return cache.enrollments.filter(e => e.classId === id).length; },
  };

  // ----- Enrollments -----
  const Enroll = {
    all() { return cache.enrollments.slice(); },
    forStudent(id) { return cache.enrollments.filter(e => e.studentId === id); },
    forClass(id) { return cache.enrollments.filter(e => e.classId === id); },
    isEnrolled(classId, studentId) {
      return cache.enrollments.some(e => e.classId === classId && e.studentId === studentId);
    },
    async enroll(classId, studentId) {
      if (this.isEnrolled(classId, studentId)) return null;
      // Composite doc id prevents duplicates
      const id = `${classId}__${studentId}`;
      const ref = getDb().collection('enrollments').doc(id);
      const rec = { classId, studentId, enrolledAt: firebase.firestore.FieldValue.serverTimestamp() };
      await ref.set(rec);
      const fresh = { id, ...rec, enrolledAt: Date.now() };
      cache.enrollments.push(fresh);
      notify();
      return fresh;
    },
    async unenroll(classId, studentId) {
      const id = `${classId}__${studentId}`;
      await getDb().collection('enrollments').doc(id).delete();
      cache.enrollments = cache.enrollments.filter(e => e.id !== id);
      notify();
    },
  };

  // ----- Attendance -----
  const Attend = {
    all() { return cache.attendance.slice(); },
    forStudent(id) { return cache.attendance.filter(a => a.studentId === id); },
    forClass(id) { return cache.attendance.filter(a => a.classId === id); },
    findOne(classId, studentId, slotKey) {
      return cache.attendance.find(a => a.classId === classId && a.studentId === studentId && a.slotKey === slotKey);
    },
    async record({ classId, studentId, slot, slotKey, location, status, selfie }) {
      // Selfie (if provided) is a JPEG dataURL. We store it directly in the
      // Firestore document instead of uploading to Firebase Storage, so this
      // app stays entirely on the free tier. Caller compresses to ~320x240 @ 0.55
      // (see js/selfie.js), so each selfie is ~8-15KB -- well under the 1MB
      // Firestore document limit.
      const selfieData = (selfie && typeof selfie === 'string' && selfie.startsWith('data:'))
        ? selfie
        : null;

      // Resolve the instructorId from the cache, falling back to a direct
      // Firestore fetch if the class isn't in cache. Without an accurate
      // instructorId, the class's instructor cannot read the record (the
      // Firestore rule compares resource.data.instructorId to auth.uid).
      let instructorId = (cache.classes.find(c => c.id === classId) || {}).instructorId || null;
      if (!instructorId) {
        try {
          const snap = await getDb().collection('classes').doc(classId).get();
          if (snap.exists) instructorId = snap.get('instructorId') || null;
        } catch (e) { /* fall through with null */ }
      }

      const rec = {
        classId,
        studentId,
        instructorId,
        slot, slotKey,
        location: {
          lat: Number(location?.lat) || 0,
          lng: Number(location?.lng) || 0,
          accuracy: Number(location?.accuracy) || 0,
          distanceM: Number(location?.distanceM) || 0,
        },
        selfieData,
        status: status || 'present',
        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      };
      const ref = await getDb().collection('attendance').add(rec);
      const fresh = { id: ref.id, ...rec, timestamp: Date.now() };
      cache.attendance.push(fresh);
      notify();
      return fresh;
    },
    // Insert or update a record. Used by the instructor's manual entry.
    // Uniqueness: at most one record per (classId, studentId, slotKey).
    // We use a deterministic doc id (classId__studentId__slotKey) and
    // `set({merge:true})` so two rapid clicks can't both create records:
    // the second call updates the first atomically. Any legacy records
    // (older auto-id duplicates) for the same triple are deleted after
    // the write so the database converges to a single document.
    // Pass `clearSelfie: true` to remove an existing selfie on update;
    // otherwise an existing selfie is preserved when the caller does
    // not provide a new one.
    async upsert({ classId, studentId, slot, slotKey, location, status, selfie, timestamp, clearSelfie = false }) {
      if (!classId || !studentId || !slot || !slotKey) {
        throw new Error('classId, studentId, slot and slotKey are required');
      }
      const docId = `${classId}__${studentId}__${slotKey}`;
      // Compute payload pieces
      let selfieData = null;
      if (selfie && typeof selfie === 'string' && selfie.startsWith('data:')) {
        selfieData = selfie;
      } else if (!clearSelfie) {
        // Try to preserve the selfie from any matching record (deterministic
        // id, then cache) before we overwrite.
        try {
          const exSnap = await getDb().collection('attendance').doc(docId).get();
          if (exSnap.exists) selfieData = exSnap.get('selfieData') || null;
        } catch (e) { /* ignore */ }
        if (selfieData == null) {
          const exCache = cache.attendance.find(a =>
            a.classId === classId && a.studentId === studentId && a.slotKey === slotKey
          );
          if (exCache) selfieData = exCache.selfieData || null;
        }
      }
      const statusNorm = (status === 'late' || status === 'absent') ? status : 'present';
      const ts = (timestamp && typeof timestamp.toDate === 'function')
        ? timestamp.toDate().getTime()
        : (typeof timestamp === 'number' ? timestamp : Date.now());
      // Resolve instructorId the same way as record()
      let instructorId = (cache.classes.find(c => c.id === classId) || {}).instructorId || null;
      if (!instructorId) {
        try {
          const snap = await getDb().collection('classes').doc(classId).get();
          if (snap.exists) instructorId = snap.get('instructorId') || null;
        } catch (e) { /* ignore */ }
      }
      const payload = {
        classId, studentId, instructorId, slot, slotKey,
        location: {
          lat: Number(location?.lat) || 0,
          lng: Number(location?.lng) || 0,
          accuracy: Number(location?.accuracy) || 0,
          distanceM: Number(location?.distanceM) || 0,
        },
        selfieData,
        status: statusNorm,
        timestamp: new Date(ts),
      };
      // Atomic write to the deterministic id.
      await getDb().collection('attendance').doc(docId).set(payload, { merge: true });
      // Clean up any legacy duplicates (auto-id docs for the same triple).
      try {
        const dupes = await getDb().collection('attendance')
          .where('classId', '==', classId)
          .where('studentId', '==', studentId)
          .where('slotKey', '==', slotKey)
          .get();
        const removeIds = [];
        for (const d of dupes.docs) {
          if (d.id !== docId) removeIds.push(d.id);
        }
        for (const id of removeIds) {
          await getDb().collection('attendance').doc(id).delete();
        }
        if (removeIds.length > 0) {
          cache.attendance = cache.attendance.filter(a => !removeIds.includes(a.id));
        }
      } catch (e) { /* ignore - rules may block but the canonical write succeeded */ }
      // Reconcile the cache: remove ANY other record for this triple (cache
      // or otherwise) and replace with the canonical one.
      cache.attendance = cache.attendance.filter(a =>
        !(a.classId === classId && a.studentId === studentId && a.slotKey === slotKey)
      );
      const fresh = { id: docId, ...payload, timestamp: ts };
      cache.attendance.push(fresh);
      notify();
      return fresh;
    },
    async remove(id) {
      await getDb().collection('attendance').doc(id).delete();
      cache.attendance = cache.attendance.filter(a => a.id !== id);
      notify();
    },
  };

  // ----- Session (delegates to Firebase Auth) -----
  const Session = {
    current() { return cache.me; },
    async signOut() { await window.fb.signOut(); },
  };

  return {
    init, dispose, ready: () => isReady, onChange,
    Users, Classes, Enroll, Attend, Session,
    uid, code,
  };
})();
