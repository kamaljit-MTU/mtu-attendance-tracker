/* =========================================================
   instructor.js - Instructor dashboard logic
   ========================================================= */

const Instructor = (() => {
  let currentUser = null;
  let liveTimer = null;

  function render(user) {
    currentUser = user;
    const tpl = document.getElementById('tpl-instructor');
    const node = tpl.content.cloneNode(true);
    node.querySelector('[data-bind="userName"]').textContent = user.name;
    node.querySelector('#newClassBtn').addEventListener('click', () => openClassModal(null));
    requestAnimationFrame(() => refresh());
    return node;
  }

  function refresh() {
    const list = document.getElementById('classList');
    const empty = document.getElementById('classEmpty');
    if (!list) return;
    Utils.clear(list);

    const classes = Storage.Classes.byInstructor(currentUser.id);
    if (classes.length === 0) {
      empty.classList.remove('hidden');
    } else {
      empty.classList.add('hidden');
      for (const cls of classes) list.appendChild(renderClassCard(cls));
    }

    // Update stats
    const totalStudents = classes.reduce((acc, c) => acc + Storage.Classes.countEnrolled(c.id), 0);
    const todayCount = classes.filter(c => c.timeSlots.some(s => s.day === Utils.DAY_ORDER[new Date().getDay()])).length;
    setStat('classCount', classes.length);
    setStat('studentCount', totalStudents);
    setStat('todayCount', todayCount);

    if (liveTimer) clearInterval(liveTimer);
    liveTimer = setInterval(updateLiveStatuses, 30000);
  }

  function setStat(key, value) {
    const n = document.querySelector(`[data-bind="${key}"]`);
    if (n) n.textContent = value;
  }

  function renderClassCard(cls) {
    const tpl = document.getElementById('tpl-class-card');
    const node = tpl.content.cloneNode(true);
    const article = node.querySelector('article');
    article.dataset.bind = cls.id;
    node.querySelector('[data-bind="name"]').textContent = cls.name;
    node.querySelector('[data-bind="code"]').textContent = cls.code || '—';
    node.querySelector('[data-bind="description"]').textContent = cls.description || 'No description.';
    const slotsText = cls.timeSlots.length === 0
      ? 'No slots'
      : cls.timeSlots.map(s => `${s.day} ${s.start}–${s.end}`).join(', ');
    node.querySelector('[data-bind="slots"]').textContent = slotsText;
    node.querySelector('[data-bind="geo"]').textContent = `${Utils.fmtCoord(cls.geofence.lat)}, ${Utils.fmtCoord(cls.geofence.lng)} · ${cls.geofence.radiusM} m`;
    node.querySelector('[data-bind="enrolled"]').textContent = Storage.Classes.countEnrolled(cls.id);
    // Course date range (start/end)
    const dateRange = formatClassDateRange(cls);
    const datesEl = node.querySelector('[data-bind="dates"]');
    if (datesEl) {
      if (dateRange) {
        datesEl.textContent = dateRange;
        datesEl.closest('li').classList.remove('hidden');
      } else {
        // No dates set yet — hide the row to avoid a blank "Dates: —"
        const li = datesEl.closest('li');
        if (li) li.classList.add('hidden');
      }
    }

    const actions = node.querySelector('[data-bind="actions"]');
    actions.append(
      makeBtn('Share link', 'btn-secondary', () => openShareModal(cls)),
      makeBtn('Edit', 'btn-ghost', () => openClassModal(cls)),
      makeBtn('Manual entry', 'btn-ghost', () => openManualEntryModal(cls)),
      makeBtn('Attendance', 'btn-ghost', () => openAttendanceModal(cls)),
      makeBtn('Reports', 'btn-primary', () => { window.location.hash = `#/reports?classId=${encodeURIComponent(cls.id)}`; }),
      makeBtn('Delete', 'btn-danger', () => deleteClass(cls))
    );

    // Enrolled students roster
    const rosterEl = node.querySelector('[data-bind="roster"]');
    renderRoster(rosterEl, cls.id);

    // Live status badge
    const badge = node.querySelector('[data-bind="statusBadge"]');
    applyLiveStatus(badge, cls);

    return article;
  }

  // Populate the enrolled-students list inside a class card.
  // Shows "Name (RollNo)" for students. Sorted alphabetically.
  function renderRoster(container, classId) {
    Utils.clear(container);
    const enrollments = Storage.Enroll.forClass(classId);
    if (enrollments.length === 0) {
      container.appendChild(Utils.el('div', { class: 'roster-empty' }, 'No students enrolled yet.'));
      return;
    }
    // Map enrollments to user profiles (may be missing while hydrating).
    const rows = enrollments
      .map(e => {
        const u = Storage.Users.findById(e.studentId);
        const label = u
          ? ((u.role === 'student' && u.rollNo) ? `${u.name} · ${u.rollNo}` : (u.name || 'Unnamed student'))
          : 'Loading student info…';
        const sortKey = (u && u.name) ? u.name.toLowerCase() : 'zzz';
        return { label, sortKey };
      })
      .sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    const heading = Utils.el('div', { class: 'roster-heading' },
      Utils.el('span', {}, 'Enrolled students'),
      Utils.el('span', { class: 'roster-count' }, enrollments.length)
    );
    const list = Utils.el('ul', { class: 'roster-list' });
    for (const r of rows) {
      list.appendChild(Utils.el('li', { class: 'roster-item' }, r.label));
    }
    container.append(heading, list);
  }

  function makeBtn(text, cls, onclick) {
    return Utils.el('button', { class: `btn btn-sm ${cls}`, type: 'button', onclick }, text);
  }

  // Human-friendly course date range, e.g. "Jan 1 – May 30, 2026" or "Jan 1, 2026 –".
  // Returns '' when neither start nor end is set.
  function formatClassDateRange(cls) {
    const s = cls && cls.startDate;
    const e = cls && cls.endDate;
    if (!s && !e) return '';
    const sFmt = Utils.fmtDateStr(s);
    const eFmt = Utils.fmtDateStr(e);
    if (sFmt && eFmt) {
      // Drop the year from the start when both are in the same year
      if (s && s.slice(0, 4) === e && e.slice(0, 4)) {
        const sShort = sFmt.replace(/,?\s*\d{4}$/, '');
        return `${sShort} – ${eFmt}`;
      }
      return `${sFmt} – ${eFmt}`;
    }
    if (sFmt) return `From ${sFmt}`;
    return `Until ${eFmt}`;
  }

  function updateLiveStatuses() {
    const cards = document.querySelectorAll('.class-card');
    cards.forEach(card => {
      const id = card.dataset.bind;
      const cls = Storage.Classes.findById(id);
      if (!cls) return;
      const badge = card.querySelector('[data-bind="statusBadge"]');
      applyLiveStatus(badge, cls);
    });
  }

  function applyLiveStatus(badge, cls) {
    if (!badge) return;
    const now = new Date();
    const statuses = cls.timeSlots.map(s => Utils.statusForSlot(s, now));
    if (statuses.includes('on-time')) {
      badge.textContent = 'LIVE · On time';
      badge.className = 'badge';
    } else if (statuses.includes('late')) {
      badge.textContent = 'LIVE · Late window';
      badge.className = 'badge badge-soon';
    } else if (statuses.includes('opening')) {
      badge.textContent = 'Opens soon';
      badge.className = 'badge badge-soon';
    } else if (statuses.includes('upcoming')) {
      badge.textContent = 'Upcoming';
      badge.className = 'badge badge-locked';
    } else if (statuses.includes('ended')) {
      badge.textContent = 'Just ended';
      badge.className = 'badge badge-ended';
    } else {
      badge.textContent = 'Inactive';
      badge.className = 'badge badge-locked';
    }
  }

  // -------- Create / Edit Class modal --------
  function openClassModal(existing) {
    const isEdit = !!existing;
    const initial = existing
      ? JSON.parse(JSON.stringify(existing))
      : { name: '', code: '', description: '', geofence: { lat: 24.8170, lng: 93.9368, radiusM: 100 }, timeSlots: [{ day: 'Mon', start: '09:00', end: '10:00' }], startDate: '', endDate: '' };

    const form = Utils.el('form', { class: 'auth-form', autocomplete: 'off' },
      field('Class name', 'name', initial.name, { placeholder: 'e.g. Data Structures', required: true }),
      field('Course code', 'code', initial.code, { placeholder: 'e.g. CS301' }),
      field('Description', 'description', initial.description, { placeholder: 'Short description (optional)', textarea: true }),
      Utils.el('div', { class: 'field' },
        Utils.el('label', {}, 'Course start & end dates'),
        Utils.el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:8px;' },
          field('Start date', 'startDate', initial.startDate || '', { type: 'date' }),
          field('End date', 'endDate', initial.endDate || '', { type: 'date' })
        ),
        Utils.el('p', { class: 'muted small', style: 'margin:4px 0 0;' },
          'Optional. Set later to fix or extend the course window. Reports will only count sessions inside this range.')
      ),
      Utils.el('div', { class: 'field' },
        Utils.el('label', {}, 'Geofence center'),
        Utils.el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:8px;' },
          field('Latitude', 'lat', initial.geofence.lat, { type: 'number', step: '0.000001', required: true }),
          field('Longitude', 'lng', initial.geofence.lng, { type: 'number', step: '0.000001', required: true })
        )
      ),
      field('Allowed radius (meters)', 'radiusM', initial.geofence.radiusM, { type: 'number', min: '20', max: '5000', required: true }),
      Utils.el('div', { class: 'field' },
        Utils.el('label', {}, 'Class time slots'),
        Utils.el('div', { id: 'slotList' }),
        Utils.el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: addSlot }, '+ Add slot')
      ),
      Utils.el('div', { class: 'field' },
        Utils.el('label', {}, 'Pick current location as center'),
        Utils.el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: (e) => useMyLocation(e, form) }, 'Use my GPS')
      ),
      Utils.el('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:8px;' },
        Utils.el('button', { type: 'button', class: 'btn btn-ghost', onclick: closeModal }, 'Cancel'),
        Utils.el('button', { type: 'submit', class: 'btn btn-primary' }, isEdit ? 'Save changes' : 'Create class')
      )
    );

    const { body, close } = Utils.openModal();
    body.previousElementSibling.textContent = isEdit ? `Edit class · ${existing.name}` : 'Create new class';
    body.appendChild(form);

    const slotList = form.querySelector('#slotList');
    function renderSlots() {
      Utils.clear(slotList);
      initial.timeSlots.forEach((slot, i) => {
        const row = Utils.el('div', { class: 'slot-row' },
          selectDay(slot.day, (v) => slot.day = v),
          timeInput('Start', slot.start, (v) => slot.start = v),
          timeInput('End', slot.end, (v) => slot.end = v),
          Utils.el('button', { type: 'button', class: 'btn btn-danger btn-sm slot-del', onclick: () => {
            initial.timeSlots.splice(i, 1);
            if (initial.timeSlots.length === 0) initial.timeSlots.push({ day: 'Mon', start: '09:00', end: '10:00' });
            renderSlots();
          } }, 'Remove')
        );
        slotList.appendChild(row);
      });
    }
    function addSlot() {
      initial.timeSlots.push({ day: 'Mon', start: '09:00', end: '10:00' });
      renderSlots();
    }
    renderSlots();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const startDate = Utils.normalizeDateStr(fd.get('startDate'));
      const endDate = Utils.normalizeDateStr(fd.get('endDate'));
      if (startDate && endDate && startDate > endDate) {
        Utils.toast('End date must be on or after the start date.', 'error');
        return;
      }
      const payload = {
        name: fd.get('name').toString().trim(),
        code: fd.get('code').toString().trim(),
        description: fd.get('description').toString().trim(),
        startDate,
        endDate,
        geofence: {
          lat: Number(fd.get('lat')),
          lng: Number(fd.get('lng')),
          radiusM: Number(fd.get('radiusM')),
        },
        timeSlots: initial.timeSlots.filter(s => s.start < s.end),
      };
      if (!payload.name) { Utils.toast('Class name is required', 'error'); return; }
      if (payload.timeSlots.length === 0) { Utils.toast('Add at least one time slot (end must be after start)', 'error'); return; }
      if (isNaN(payload.geofence.lat) || isNaN(payload.geofence.lng)) { Utils.toast('Valid coordinates are required', 'error'); return; }

      const submit = form.querySelector('button[type="submit"]');
      if (submit) { submit.disabled = true; submit.textContent = isEdit ? 'Saving…' : 'Creating…'; }
      try {
        if (isEdit) {
          await Storage.Classes.update(existing.id, payload);
          Utils.toast('Class updated', 'success');
        } else {
          await Storage.Classes.create({ ...payload, instructorId: currentUser.id });
          Utils.toast('Class created', 'success');
        }
        closeModal();
        refresh();
      } catch (err) {
        Utils.toast(err.message || 'Could not save class.', 'error', 5000);
      } finally {
        if (submit) { submit.disabled = false; submit.textContent = isEdit ? 'Save changes' : 'Create class'; }
      }
    });
  }

  function closeModal() {
    const m = document.querySelector('.modal-backdrop');
    if (m) m.remove();
  }

  function field(label, name, value, opts = {}) {
    const id = `f_${name}_${Math.random().toString(36).slice(2,7)}`;
    const input = opts.textarea
      ? Utils.el('textarea', { id, name, rows: '2' })
      : Utils.el('input', { id, name, type: opts.type || 'text', value: value ?? '', placeholder: opts.placeholder || '', ...(opts.required ? { required: true } : {}), ...(opts.min ? { min: opts.min } : {}), ...(opts.max ? { max: opts.max } : {}), ...(opts.step ? { step: opts.step } : {}) });
    if (input.tagName === 'INPUT') input.value = value ?? '';
    return Utils.el('div', { class: 'field' },
      Utils.el('label', { for: id }, label),
      input
    );
  }
  function selectDay(value, onChange) {
    const sel = Utils.el('select', { onchange: (e) => onChange(e.target.value) });
    Utils.DAY_ORDER.forEach(d => {
      const o = Utils.el('option', { value: d }, d);
      if (d === value) o.selected = true;
      sel.appendChild(o);
    });
    return Utils.el('div', { class: 'field' }, Utils.el('label', {}, 'Day'), sel);
  }
  function timeInput(label, value, onChange) {
    const id = `t_${Math.random().toString(36).slice(2,7)}`;
    const i = Utils.el('input', { type: 'time', id, value, onchange: (e) => onChange(e.target.value) });
    return Utils.el('div', { class: 'field' }, Utils.el('label', { for: id }, label), i);
  }

  async function useMyLocation(e, form) {
    const btn = e.currentTarget;
    const orig = btn.textContent;
    btn.textContent = 'Locating…';
    btn.disabled = true;
    try {
      const pos = await Geofence.getCurrent();
      form.querySelector('input[name="lat"]').value = pos.lat.toFixed(6);
      form.querySelector('input[name="lng"]').value = pos.lng.toFixed(6);
      Utils.toast('Center set to your current location', 'success');
    } catch (err) {
      Utils.toast(err.message, 'error', 5000);
    } finally {
      btn.textContent = orig;
      btn.disabled = false;
    }
  }

  // -------- Share modal --------
  function openShareModal(cls) {
    const link = `${window.location.origin}${window.location.pathname}#/student?enroll=${cls.enrollCode}`;
    const body = Utils.el('div', {},
      Utils.el('p', { class: 'muted' }, 'Share this link or enrollment code with your students. They can paste it on the Student dashboard to enroll.'),
      Utils.el('div', { class: 'field' },
        Utils.el('label', {}, 'Shareable link'),
        Utils.el('div', { class: 'share-link' },
          Utils.el('code', {}, link),
          Utils.el('button', { type: 'button', class: 'btn btn-sm btn-secondary', onclick: () => { Utils.copyToClipboard(link); Utils.toast('Link copied!', 'success'); } }, 'Copy')
        )
      ),
      Utils.el('div', { class: 'field' },
        Utils.el('label', {}, 'Enrollment code'),
        Utils.el('div', { class: 'share-link' },
          Utils.el('code', { style: 'font-size:18px;letter-spacing:4px;' }, cls.enrollCode),
          Utils.el('button', { type: 'button', class: 'btn btn-sm btn-secondary', onclick: () => { Utils.copyToClipboard(cls.enrollCode); Utils.toast('Code copied!', 'success'); } }, 'Copy')
        )
      ),
      Utils.el('div', { style: 'display:flex;justify-content:flex-end;margin-top:8px;' },
        Utils.el('button', { type: 'button', class: 'btn btn-ghost', onclick: closeModal }, 'Close')
      )
    );
    const { body: modalBody } = Utils.openModal();
    modalBody.previousElementSibling.textContent = `Share · ${cls.name}`;
    modalBody.appendChild(body);
  }

  // -------- Attendance modal --------
  async function openAttendanceModal(cls) {
    const records = Storage.Attend.forClass(cls.id);
    const enrolled = Storage.Enroll.forClass(cls.id);
    // Hydrate the user map for everyone who appears in a record (cache may lag).
    const recordStudentIds = records.map(r => r.studentId);
    const userMap = new Map(Storage.Users.all().map(u => [u.id, u]));
    const missing = recordStudentIds.filter(id => !userMap.has(id));
    if (missing.length > 0) {
      try {
        for (let i = 0; i < missing.length; i += 30) {
          const ch = missing.slice(i, i + 30);
          const snap = await window.fb.db.collection('users')
            .where(firebase.firestore.FieldPath.documentId(), 'in', ch).get();
          snap.forEach(d => { userMap.set(d.id, { id: d.id, ...d.data() }); });
        }
      } catch (e) { /* ignore */ }
    }

    const sorted = [...records].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    const body = Utils.el('div', {},
      Utils.el('div', { class: 'stat-grid' },
        Utils.el('div', { class: 'stat-card' }, Utils.el('span', { class: 'stat-label' }, 'Enrolled'), Utils.el('span', { class: 'stat-value' }, enrolled.length)),
        Utils.el('div', { class: 'stat-card' }, Utils.el('span', { class: 'stat-label' }, 'Records'), Utils.el('span', { class: 'stat-value' }, records.length)),
        Utils.el('div', { class: 'stat-card' }, Utils.el('span', { class: 'stat-label' }, 'Time slots'), Utils.el('span', { class: 'stat-value' }, cls.timeSlots.length))
      ),
      Utils.el('div', { style: 'display:flex;justify-content:flex-end;margin-bottom:10px;' },
        Utils.el('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => { closeModal(); requestAnimationFrame(() => openManualEntryModal(cls)); } }, '+ Add / edit record')
      ),
      sorted.length === 0
        ? Utils.el('p', { class: 'empty-state' }, 'No attendance has been recorded yet.')
        : Utils.el('div', { class: 'history-list with-selfie' },
            ...sorted.map(r => {
              const u = userMap.get(r.studentId);
              const pillCls = r.status === 'late' ? 'pill-late' : (r.status === 'absent' ? 'pill-absent' : 'pill-present');
              const selfieCell = r.selfieData
                ? Utils.el('img', {
                    src: r.selfieData,
                    class: 'selfie-thumb',
                    alt: `Selfie of ${u ? u.name : 'student'}`,
                    title: 'Click to enlarge',
                    onclick: () => openSelfieViewer(r, u),
                  })
                : Utils.el('span', { class: 'muted small' }, '—');
              const statusLabel = r.status === 'late' ? 'Late' : (r.status === 'absent' ? 'Absent' : 'Present');
              return Utils.el('div', { class: 'history-row history-row-selfie' },
                Utils.el('div', { class: 'selfie-cell' }, selfieCell),
                Utils.el('div', {}, u ? u.name : 'Unknown'),
                Utils.el('div', {}, Utils.el('span', { class: `pill ${pillCls}` }, statusLabel)),
                Utils.el('div', {}, Utils.fmtDateTime(r.timestamp)),
                Utils.el('div', { class: 'col-loc' }, `${r.location.distanceM ? Utils.fmtDistance(r.location.distanceM) : '—'} · ±${Math.round(r.location.accuracy)}m`),
                Utils.el('div', { class: 'row-actions' },
                  Utils.el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => { closeModal(); requestAnimationFrame(() => openManualEntryModal(cls, r)); }, title: 'Edit this record' }, 'Edit'),
                  Utils.el('button', { type: 'button', class: 'btn btn-danger btn-sm', onclick: () => { closeModal(); deleteAttendanceRecord(r, () => requestAnimationFrame(() => openAttendanceModal(cls))); }, title: 'Delete this record' }, 'Delete')
                )
              );
            })
          ),
      Utils.el('div', { style: 'display:flex;justify-content:flex-end;margin-top:14px;' },
        Utils.el('button', { type: 'button', class: 'btn btn-ghost', onclick: closeModal }, 'Close')
      )
    );
    const { body: modalBody } = Utils.openModal();
    modalBody.previousElementSibling.textContent = `Attendance · ${cls.name}`;
    modalBody.appendChild(body);
  }

  // -------- Delete class --------
  async function deleteClass(cls) {
    if (!confirm(`Delete "${cls.name}"? This will remove all enrollments and attendance for this class.`)) return;
    const btn = document.activeElement;
    const origText = btn && btn.textContent;
    try {
      if (btn && btn.tagName === 'BUTTON') { btn.disabled = true; btn.textContent = 'Deleting…'; }
      await Storage.Classes.remove(cls.id);
      Utils.toast('Class deleted', 'success');
      refresh();
    } catch (err) {
      console.error('Delete class failed:', err);
      Utils.toast(err.message || 'Could not delete class.', 'error', 6000);
    } finally {
      if (btn && btn.tagName === 'BUTTON' && origText != null) { btn.disabled = false; btn.textContent = origText; }
    }
  }

  // -------- Selfie viewer --------
  function openSelfieViewer(rec, student) {
    const body = Utils.el('div', { class: 'selfie-viewer' },
      Utils.el('img', { src: rec.selfieData, alt: 'Selfie' , class: 'selfie-full'}),
      Utils.el('div', { class: 'selfie-meta' },
        Utils.el('div', {}, Utils.el('strong', {}, student ? student.name : 'Unknown student')),
        Utils.el('div', { class: 'muted small' }, Utils.fmtDateTime(new Date(rec.timestamp))),
        Utils.el('div', { class: 'muted small' }, `${rec.slot.day} ${rec.slot.start}–${rec.slot.end} · ${Utils.fmtCoord(rec.location.lat)}, ${Utils.fmtCoord(rec.location.lng)}`)
      ),
      Utils.el('div', { style: 'display:flex;justify-content:flex-end;margin-top:10px;' },
        Utils.el('button', { type: 'button', class: 'btn btn-ghost', onclick: closeModal }, 'Close')
      )
    );
    const { body: modalBody } = Utils.openModal();
    modalBody.previousElementSibling.textContent = 'Selfie verification';
    modalBody.appendChild(body);
  }

  // -------- Manual entry / edit attendance --------
  // We don't block on the cache: fetch enrollments + user profiles
  // directly from Firestore, falling back to the cache for snappy
  // repeat opens. This means the student dropdown is always populated,
  // even if the subscription hasn't caught up yet.
  async function openManualEntryModal(cls, existing) {
    const isEdit = !!existing;

    // 1) Pull enrollments for the class
    let enrollments = Storage.Enroll.forClass(cls.id);
    try {
      const snap = await window.fb.db.collection('enrollments').where('classId', '==', cls.id).get();
      const fetched = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (fetched.length > 0) enrollments = fetched;
    } catch (e) {
      console.warn('Could not fetch enrollments for manual entry:', e);
    }

    // 2) Hydrate user profiles (cache + Firestore direct)
    const studentIds = Array.from(new Set([
      ...enrollments.map(e => e.studentId),
      existing ? existing.studentId : null,
    ].filter(Boolean)));
    const userMap = {};
    for (const id of studentIds) {
      const u = Storage.Users.findById(id);
      if (u) userMap[id] = u;
    }
    const missing = studentIds.filter(id => !userMap[id]);
    if (missing.length > 0) {
      try {
        for (let i = 0; i < missing.length; i += 30) {
          const ch = missing.slice(i, i + 30);
          const snap = await window.fb.db.collection('users')
            .where(firebase.firestore.FieldPath.documentId(), 'in', ch).get();
          snap.forEach(d => { userMap[d.id] = { id: d.id, ...d.data() }; });
        }
      } catch (e) {
        console.warn('Could not fetch users for manual entry:', e);
      }
    }
    const enrolled = studentIds
      .map(id => userMap[id])
      .filter(Boolean)
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    if (enrolled.length === 0) {
      Utils.toast('No students are enrolled in this class yet.', 'warn');
      return;
    }

    // Resolve initial values
    const initialDate = existing ? new Date(existing.timestamp) : new Date();
    const isoDate = `${initialDate.getFullYear()}-${String(initialDate.getMonth() + 1).padStart(2, '0')}-${String(initialDate.getDate()).padStart(2, '0')}`;
    const initialDay = Utils.DAY_ORDER[initialDate.getDay()];
    const initialSlot = existing
      ? cls.timeSlots.find(s => Utils.slotKey(s) === existing.slotKey) || cls.timeSlots[0]
      : (cls.timeSlots.find(s => s.day === initialDay) || cls.timeSlots[0]);
    const initialStudent = existing
      ? (enrolled.find(s => s.id === existing.studentId) || userMap[existing.studentId] || { id: existing.studentId, name: '', rollNo: '' })
      : enrolled[0];
    const initialStatus = existing ? (existing.status || 'present') : 'present';

    // Build the form
    const dateInput = Utils.el('input', { type: 'date', value: isoDate, required: true });
    const slotSelect = Utils.el('select', { required: true });
    // Free-text student name (with datalist suggestions + any cached user).
    // Lets the instructor type a custom name; on save we look up the user.
    const studentDatalistId = `meStudentList_${Math.random().toString(36).slice(2, 8)}`;
    const studentInput = Utils.el('input', {
      type: 'text',
      list: studentDatalistId,
      id: 'meStudent',
      required: true,
      placeholder: 'Type or pick a student name',
      autocomplete: 'off',
      spellcheck: 'false',
    });
    const studentDatalist = Utils.el('datalist', { id: studentDatalistId });
    const knownNames = new Set();
    function pushSuggestion(name, rollNo) {
      if (!name) return;
      const key = `${name}`.trim();
      if (!key || knownNames.has(key.toLowerCase())) return;
      knownNames.add(key.toLowerCase());
      const value = rollNo ? `${name} (${rollNo})` : name;
      studentDatalist.appendChild(Utils.el('option', { value }));
    }
    for (const s of enrolled) pushSuggestion(s.name, s.rollNo);
    // Also include any other users we know about (instructor's cache).
    for (const u of Storage.Users.all()) {
      if (u.role === 'student' || u.role === undefined) pushSuggestion(u.name, u.rollNo);
    }
    // Always include the existing record's student so the input is pre-fillable.
    if (initialStudent && initialStudent.name) pushSuggestion(initialStudent.name, initialStudent.rollNo);
    if (initialStudent && initialStudent.name) {
      studentInput.value = initialStudent.rollNo
        ? `${initialStudent.name} (${initialStudent.rollNo})`
        : initialStudent.name;
    }
    const statusGroup = Utils.el('div', { class: 'status-pills' });

    const STATUS_OPTS = [
      { value: 'present', label: 'Present', cls: 'pill-present' },
      { value: 'late',    label: 'Late',    cls: 'pill-late' },
      { value: 'absent',  label: 'Absent',  cls: 'pill-absent' },
    ];
    let statusValue = initialStatus;
    function renderStatusPills() {
      Utils.clear(statusGroup);
      for (const opt of STATUS_OPTS) {
        const b = Utils.el('button', {
          type: 'button',
          class: `status-pill ${opt.cls} ${opt.value === statusValue ? 'is-active' : ''}`,
          onclick: () => { statusValue = opt.value; renderStatusPills(); },
        }, opt.label);
        statusGroup.appendChild(b);
      }
    }
    renderStatusPills();

    function refreshSlots() {
      Utils.clear(slotSelect);
      const d = new Date(dateInput.value || isoDate);
      const dayName = Utils.DAY_ORDER[d.getDay()];
      const matching = cls.timeSlots.filter(s => s.day === dayName);
      const list = matching.length > 0 ? matching : cls.timeSlots;
      if (matching.length === 0) {
        const note = Utils.el('option', { value: '', disabled: true, selected: true },
          `No ${dayName} slot — pick another date`);
        slotSelect.appendChild(note);
      }
      for (const s of list) {
        const o = Utils.el('option', { value: Utils.slotKey(s) }, `${s.day} ${s.start}–${s.end}`);
        if (s === initialSlot) o.selected = true;
        slotSelect.appendChild(o);
      }
    }
    dateInput.addEventListener('change', refreshSlots);
    refreshSlots();

    const errorBox = Utils.el('div', { class: 'auth-error', style: 'display:none;' });

    const form = Utils.el('form', { class: 'auth-form', autocomplete: 'off' },
      Utils.el('p', { class: 'muted small', style: 'margin:0;' },
        `Recording attendance for `,
        Utils.el('strong', {}, cls.name),
        cls.code ? ` (${cls.code})` : '',
        `. This will ${isEdit ? 'update the existing' : 'create a new'} record.`
      ),
      Utils.el('div', { class: 'field' },
        Utils.el('label', { for: 'meDate' }, 'Date'),
        dateInput
      ),
      Utils.el('div', { class: 'field' },
        Utils.el('label', { for: 'meSlot' }, 'Time slot'),
        slotSelect
      ),
      Utils.el('div', { class: 'field' },
        Utils.el('label', { for: 'meStudent' }, 'Student'),
        studentInput,
        studentDatalist,
        Utils.el('div', { class: 'muted small', style: 'margin-top:4px;' },
          existing && existing.selfieData
            ? 'A selfie is already attached to this record and will be kept.'
            : 'Pick from the list or type any student name. If the name is not enrolled, we will look it up in the system.')
      ),
      Utils.el('div', { class: 'field' },
        Utils.el('label', {}, 'Status'),
        statusGroup
      ),
      errorBox,
      isEdit
        ? Utils.el('div', { style: 'display:flex;gap:8px;justify-content:space-between;margin-top:8px;' },
            Utils.el('button', { type: 'button', class: 'btn btn-danger', onclick: () => { closeModal(); deleteAttendanceRecord(existing, () => requestAnimationFrame(() => openAttendanceModal(cls))); } }, 'Delete record'),
            Utils.el('div', { style: 'display:flex;gap:8px;' },
              Utils.el('button', { type: 'button', class: 'btn btn-ghost', onclick: closeModal }, 'Cancel'),
              Utils.el('button', { type: 'submit', class: 'btn btn-primary' }, 'Save changes')
            )
          )
        : Utils.el('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:8px;' },
            Utils.el('button', { type: 'button', class: 'btn btn-ghost', onclick: closeModal }, 'Cancel'),
            Utils.el('button', { type: 'submit', class: 'btn btn-primary' }, 'Save record')
          )
    );

    const { body: modalBody, close } = Utils.openModal();
    modalBody.previousElementSibling.textContent = isEdit ? `Edit record · ${cls.name}` : `Add record · ${cls.name}`;
    modalBody.appendChild(form);

    // Resolve a typed name to a user. Matches enrolled first, then the entire
    // users collection (so an instructor can record attendance for a student
    // enrolled in another class). Returns the user id or null.
    async function resolveStudentId(typed) {
      const t = (typed || '').trim();
      if (!t) return null;
      // Strip trailing "(rollNo)" so users typing "John Doe" still match
      // suggestions that read "John Doe (CS2021001)".
      const tNorm = t.replace(/\s*\(([^)]+)\)\s*$/, '').trim();
      const tLower = tNorm.toLowerCase();
      // 1) Exact enrolled match by name
      const enrolledMatch = enrolled.find(s => (s.name || '').trim().toLowerCase() === tLower);
      if (enrolledMatch) return enrolledMatch.id;
      // 2) Existing record's student (preserve id when name is unchanged)
      if (existing && (userMap[existing.studentId] || Storage.Users.findById(existing.studentId))) {
        const u = userMap[existing.studentId] || Storage.Users.findById(existing.studentId);
        if ((u.name || '').trim().toLowerCase() === tLower) return u.id;
      }
      // 3) Direct Firestore lookup by name
      try {
        const snap = await window.fb.db.collection('users').where('name', '==', tNorm).limit(2).get();
        if (!snap.empty) {
          // Prefer a student-role match if there are multiple
          const docs = snap.docs;
          const stu = docs.find(d => (d.data().role || '') === 'student');
          return (stu || docs[0]).id;
        }
      } catch (e) { /* ignore */ }
      // 4) Cache fallback (case-insensitive)
      const cacheMatch = Storage.Users.all().find(u => (u.name || '').trim().toLowerCase() === tLower);
      if (cacheMatch) return cacheMatch.id;
      return null;
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const sk = slotSelect.value;
      const slot = cls.timeSlots.find(s => Utils.slotKey(s) === sk);
      if (!slot) { showError(errorBox, 'Please pick a valid time slot.'); return; }
      const dateVal = dateInput.value;
      if (!dateVal) { showError(errorBox, 'Please pick a date.'); return; }
      const typedName = studentInput.value;
      if (!typedName || !typedName.trim()) { showError(errorBox, 'Please type a student name.'); return; }
      const submit = form.querySelector('button[type="submit"]');
      if (submit) { submit.disabled = true; submit.textContent = 'Saving…'; }
      const studentId = await resolveStudentId(typedName);
      if (!studentId) {
        showError(errorBox, `No student found with the name "${typedName.trim()}". They may need to sign up first, or you can pick from the suggestions.`);
        if (submit) { submit.disabled = false; submit.textContent = isEdit ? 'Save changes' : 'Save record'; }
        return;
      }
      const [y, m, d] = dateVal.split('-').map(Number);
      const ts = new Date(y, m - 1, d, parseInt(slot.start.split(':')[0], 10), parseInt(slot.start.split(':')[1], 10), 0, 0).getTime();
      try {
        // NOTE: do NOT pass `selfie` here. The upsert will preserve the
        // existing record's selfieData unless `clearSelfie: true` is set.
        await Storage.Attend.upsert({
          classId: cls.id,
          studentId,
          slot,
          slotKey: sk,
          status: statusValue,
          location: { lat: 0, lng: 0, accuracy: 0, distanceM: 0 },
          timestamp: ts,
        });
        Utils.toast(isEdit ? 'Record updated' : 'Record added', 'success');
        close();
        refresh();
      } catch (err) {
        showError(errorBox, err.message || 'Could not save record.');
        if (submit) { submit.disabled = false; submit.textContent = isEdit ? 'Save changes' : 'Save record'; }
      }
    });
  }

  function showError(box, msg) {
    box.textContent = msg;
    box.style.display = 'block';
  }

  async function deleteAttendanceRecord(rec, onDone) {
    if (!confirm(`Delete this attendance record for ${rec.slot.day} ${rec.slot.start}–${rec.slot.end}?`)) return;
    try {
      await Storage.Attend.remove(rec.id);
      Utils.toast('Record deleted', 'success');
      if (onDone) onDone();
      else refresh();
    } catch (err) {
      Utils.toast(err.message || 'Could not delete record.', 'error', 5000);
    }
  }

  return { render, refresh };
})();
