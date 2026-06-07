/* =========================================================
   student.js - Student dashboard logic
   ========================================================= */

const Student = (() => {
  let currentUser = null;
  let liveTimer = null;

  function render(user, opts = {}) {
    currentUser = user;
    const tpl = document.getElementById('tpl-student');
    const node = tpl.content.cloneNode(true);
    node.querySelector('[data-bind="userName"]').textContent = user.name;
    node.querySelector('#enrollBtn').addEventListener('click', () => openEnrollModal());

    requestAnimationFrame(() => {
      refresh();
      // If hash has ?enroll=CODE, auto-prompt enrollment
      const m = window.location.hash.match(/enroll=([A-Za-z0-9]+)/);
      if (m) {
        const code = m[1];
        // Pre-fill modal & open
        openEnrollModal(code);
      }
    });
    return node;
  }

  function refresh() {
    const liveList = document.getElementById('liveClassList');
    const liveEmpty = document.getElementById('liveEmpty');
    const historyList = document.getElementById('historyList');
    const historyEmpty = document.getElementById('historyEmpty');
    if (!liveList) return;
    Utils.clear(liveList);
    Utils.clear(historyList);

    const enrolledIds = Storage.Enroll.forStudent(currentUser.id).map(e => e.classId);
    const classes = enrolledIds.map(id => Storage.Classes.findById(id)).filter(Boolean);

    if (classes.length === 0) {
      liveEmpty.classList.remove('hidden');
    } else {
      liveEmpty.classList.add('hidden');
      for (const cls of classes) liveList.appendChild(renderClassCard(cls));
    }

    // History
    const validClassIds = new Set(classes.map(c => c.id));
    const records = Storage.Attend.forStudent(currentUser.id)
      .filter(r => validClassIds.has(r.classId)) // hide records for classes that no longer exist
      .sort((a, b) => b.timestamp - a.timestamp);
    if (records.length === 0) {
      historyEmpty.classList.remove('hidden');
    } else {
      historyEmpty.classList.add('hidden');
      for (const r of records) historyList.appendChild(renderHistoryRow(r));
    }

    // Stats
    // Expected sessions = all sessions across enrolled classes that
    //   (a) fall within the class's [startDate, endDate] window (if set), and
    //   (b) have already happened (so future slots are not counted as absences).
    // If a class has no dates set, we still need a denominator; we treat the
    // class as starting at `createdAt` (or earlier) with no upper bound.
    const now = new Date();
    let expected = 0;
    for (const c of classes) {
      const slots = expandSlotsToDates(c, now);
      for (const s of slots) {
        if (!Utils.inDateRange(s.date, c.startDate, c.endDate)) continue;
        if (s.date.getTime() > now.getTime()) continue; // future
        expected++;
      }
    }
    setStat('enrolledCount', classes.length);
    setStat('presentCount', records.length);
    const pct = expected === 0 ? 0 : Math.round((records.length / expected) * 100);
    setStat('attendancePct', pct + '%');

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
    // Course date range (start/end) — hide the row if neither is set
    const datesEl = node.querySelector('[data-bind="dates"]');
    const dateRange = formatClassDateRange(cls);
    if (datesEl) {
      const li = datesEl.closest('li');
      if (dateRange) { datesEl.textContent = dateRange; if (li) li.classList.remove('hidden'); }
      else { if (li) li.classList.add('hidden'); }
    }

    const actions = node.querySelector('[data-bind="actions"]');
    const markBtn = Utils.el('button', { class: 'btn btn-primary', type: 'button' }, 'Mark attendance');
    markBtn.addEventListener('click', () => markAttendance(cls, markBtn));
    actions.append(markBtn);

    // Live status info (appended after actions)
    const live = Utils.el('div', { class: 'live-status' });
    article.appendChild(live);
    updateLiveStatusFor(cls, live, markBtn);

    // Apply the correct badge for the current time (overrides tpl default "Active")
    const badge = node.querySelector('[data-bind="statusBadge"]');
    applyBadge(badge, cls);

    return article;
  }

  function updateLiveStatuses() {
    document.querySelectorAll('.class-card').forEach(card => {
      const id = card.dataset.bind;
      const cls = Storage.Classes.findById(id);
      if (!cls) return;
      const live = card.querySelector('.live-status');
      const btn = card.querySelector('.btn-primary');
      if (live && btn) updateLiveStatusFor(cls, live, btn);
      const badge = card.querySelector('[data-bind="statusBadge"]');
      if (badge) applyBadge(badge, cls);
    });
  }

  function applyBadge(badge, cls) {
    const now = new Date();
    const statuses = cls.timeSlots.map(s => Utils.statusForSlot(s, now));
    if (statuses.includes('on-time')) { badge.textContent = 'LIVE · On time'; badge.className = 'badge'; }
    else if (statuses.includes('late')) { badge.textContent = 'LIVE · Late window'; badge.className = 'badge badge-soon'; }
    else if (statuses.includes('opening')) { badge.textContent = 'Opens soon'; badge.className = 'badge badge-soon'; }
    else if (statuses.includes('upcoming')) { badge.textContent = 'Upcoming'; badge.className = 'badge badge-locked'; }
    else if (statuses.includes('ended')) { badge.textContent = 'Just ended'; badge.className = 'badge badge-ended'; }
    else { badge.textContent = 'Inactive'; badge.className = 'badge badge-locked'; }
  }

  function updateLiveStatusFor(cls, liveEl, btn) {
    Utils.clear(liveEl);
    const now = new Date();
    const slotsWithStatus = cls.timeSlots.map(s => ({ slot: s, status: Utils.statusForSlot(s, now) }));
    const active = slotsWithStatus.find(x => x.status === 'on-time' || x.status === 'late' || x.status === 'opening');
    const next = slotsWithStatus
      .filter(x => x.status === 'upcoming' || x.status === 'opening')
      .sort((a, b) => {
        const A = Utils.nextSlotDate(a.slot, now).start;
        const B = Utils.nextSlotDate(b.slot, now).start;
        return A - B;
      })[0];

    if (active) {
      const { start, end } = Utils.nextSlotDate(active.slot, now);
      const tip = active.status === 'on-time' ? 'You are on time. Tap to mark attendance.'
                : active.status === 'late' ? 'Late window is open. Tap to mark attendance.'
                : `Opens at ${Utils.fmtTime(start)} — you can mark from 15 min before.`;
      const cls2 = active.status === 'late' ? 'warn' : 'ok';
      liveEl.appendChild(Utils.el('div', { class: cls2 }, tip));
      if (active.status === 'opening') {
        btn.disabled = true;
        btn.textContent = `Opens at ${Utils.fmtTime(start)}`;
      } else {
        btn.disabled = false;
        btn.textContent = active.status === 'late' ? 'Mark attendance (late)' : 'Mark attendance';
      }
    } else if (next) {
      const { start } = Utils.nextSlotDate(next.slot, now);
      liveEl.appendChild(Utils.el('div', { class: 'warn' }, `Next session: ${next.slot.day} ${next.slot.start}–${next.slot.end} (${Utils.fmtDateTime(start)})`));
      btn.disabled = true;
      btn.textContent = 'Not in session';
    } else {
      liveEl.appendChild(Utils.el('div', { class: 'err' }, 'No upcoming sessions this week.'));
      btn.disabled = true;
      btn.textContent = 'No session';
    }
  }

  function renderHistoryRow(r) {
    const cls = Storage.Classes.findById(r.classId);
    const pill = r.status === 'late' ? 'pill-late' : 'pill-present';
    return Utils.el('div', { class: 'history-row' },
      Utils.el('div', {}, cls ? `${cls.name} (${cls.code || '—'})` : '—'),
      Utils.el('div', {}, Utils.el('span', { class: `pill ${pill}` }, r.status === 'late' ? 'Late' : 'Present')),
      Utils.el('div', {}, Utils.fmtDateTime(r.timestamp)),
      Utils.el('div', { class: 'col-loc' }, `${r.slot.day} ${r.slot.start}–${r.slot.end} · ${r.location.distanceM ? Utils.fmtDistance(r.location.distanceM) : '—'} · ±${Math.round(r.location.accuracy)}m`)
    );
  }

  // -------- Enroll modal --------
  function openEnrollModal(prefill = '') {
    const body = Utils.el('div', {},
      Utils.el('p', { class: 'muted' }, 'Paste the enrollment link or 6-character code your instructor shared.'),
      Utils.el('form', { class: 'auth-form', id: 'enrollForm' },
        Utils.el('div', { class: 'field' },
          Utils.el('label', { for: 'enrollInput' }, 'Enrollment code or link'),
          Utils.el('input', { id: 'enrollInput', name: 'code', type: 'text', value: prefill, placeholder: 'e.g. ABC123 or full URL', required: true, autocomplete: 'off' })
        ),
        Utils.el('div', { style: 'display:flex;gap:8px;justify-content:flex-end;' },
          Utils.el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => document.querySelector('.modal-backdrop')?.remove() }, 'Cancel'),
          Utils.el('button', { type: 'submit', class: 'btn btn-primary' }, 'Enroll')
        )
      )
    );

    const { body: modalBody } = Utils.openModal();
    modalBody.previousElementSibling.textContent = 'Enroll in a class';
    modalBody.appendChild(body);

    const form = body.querySelector('#enrollForm');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const raw = form.querySelector('#enrollInput').value;
      const codeMatch = raw.match(/enroll=([A-Za-z0-9]+)/i);
      const code = (codeMatch ? codeMatch[1] : raw).trim().toUpperCase();
      const submit = form.querySelector('button[type="submit"]');
      if (submit) { submit.disabled = true; submit.textContent = 'Enrolling…'; }
      try {
        const cls = await Storage.Classes.findByEnrollCode(code);
        if (!cls) { Utils.toast('Invalid enrollment code.', 'error'); return; }
        if (Storage.Enroll.isEnrolled(cls.id, currentUser.id)) { Utils.toast('You are already enrolled in this class.', 'warn'); return; }
        await Storage.Enroll.enroll(cls.id, currentUser.id);
        Utils.toast(`Enrolled in ${cls.name}`, 'success');
        document.querySelector('.modal-backdrop')?.remove();
        // Clean up hash
        history.replaceState(null, '', window.location.pathname + '#/student');
        refresh();
      } catch (err) {
        Utils.toast(err.message || 'Could not enroll.', 'error', 5000);
      } finally {
        if (submit) { submit.disabled = false; submit.textContent = 'Enroll'; }
      }
    });
  }

  // -------- Mark attendance --------
  async function markAttendance(cls, btn) {
    const now = new Date();
    const active = cls.timeSlots.find(s => {
      const st = Utils.statusForSlot(s, now);
      return st === 'on-time' || st === 'late';
    });
    if (!active) {
      Utils.toast('Attendance is not open right now. Try again during class time.', 'warn');
      return;
    }
    const slotKey = Utils.slotKey(active);
    if (Storage.Attend.findOne(cls.id, currentUser.id, slotKey)) {
      Utils.toast('You have already marked attendance for this slot.', 'info');
      return;
    }

    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Verifying location…';

    let pos, check;
    try {
      pos = await Geofence.getCurrent();
      check = Geofence.isInside(cls.geofence, pos);
      if (!check.inside) {
        Utils.toast(`You are ${Utils.fmtDistance(check.distanceM)} from class — outside the ${cls.geofence.radiusM} m geofence.`, 'error', 5000);
        btn.textContent = orig;
        btn.disabled = false;
        return;
      }
    } catch (err) {
      Utils.toast(err.message, 'error', 5000);
      btn.textContent = orig;
      btn.disabled = false;
      return;
    }

    btn.textContent = 'Taking selfie…';
    let selfie = null;
    try {
      selfie = await Selfie.capture();
    } catch (err) {
      Utils.toast(err.message || 'Selfie required for attendance.', 'warn', 4000);
      btn.textContent = orig;
      btn.disabled = false;
      return;
    }

    try {
      const status = Utils.statusForSlot(active, new Date()) === 'late' ? 'late' : 'present';
      await Storage.Attend.record({
        classId: cls.id,
        studentId: currentUser.id,
        slot: active,
        slotKey,
        location: { ...pos, distanceM: check.distanceM },
        selfie,
        status,
      });
      Utils.toast(`Attendance marked! (${status === 'late' ? 'Late' : 'Present'})`, 'success');
      refresh();
    } catch (err) {
      Utils.toast(err.message, 'error', 5000);
      btn.textContent = orig;
      btn.disabled = false;
    }
  }

  return { render, refresh };

  // -------- shared helpers --------

  // Expand a class's recurring weekly timeSlots into concrete Date instances
  // from the class's createdAt (or 4 weeks ago) up to `now`.
  // Returns [{ date: Date, day, slot, slotKey }].
  function expandSlotsToDates(cls, now) {
    const out = [];
    if (!cls || !cls.timeSlots || cls.timeSlots.length === 0) return out;
    const start = (typeof cls.createdAt === 'number')
      ? new Date(cls.createdAt)
      : new Date(now.getTime() - 28 * 24 * 3600 * 1000);
    // Clamp to the class's [startDate, endDate] window if set, so we don't
    // enumerate thousands of weeks for old classes.
    const winStart = cls.startDate ? new Date(cls.startDate) : start;
    const winEnd = cls.endDate ? new Date(cls.endDate) : now;
    const from = new Date(Math.max(winStart.getTime(), start.getTime()));
    const to = new Date(Math.min(winEnd.getTime(), now.getTime()));
    if (to < from) return out;
    const cursor = new Date(from);
    cursor.setHours(12, 0, 0, 0);
    while (cursor <= to) {
      const dayName = Utils.DAY_ORDER[cursor.getDay()];
      for (const slot of cls.timeSlots) {
        if (slot.day !== dayName) continue;
        const d = new Date(cursor);
        const [sh, sm] = slot.start.split(':').map(Number);
        d.setHours(sh, sm, 0, 0);
        if (d > now) continue;
        out.push({ date: d, day: dayName, slot, slotKey: Utils.slotKey(slot) });
      }
      cursor.setDate(cursor.getDate() + 1);
      // safety: don't enumerate more than ~365 days
      if (out.length > 365) break;
    }
    return out;
  }

  // Human-friendly course date range, e.g. "Jan 1 – May 30, 2026".
  // Returns '' when neither start nor end is set.
  function formatClassDateRange(cls) {
    const s = cls && cls.startDate;
    const e = cls && cls.endDate;
    if (!s && !e) return '';
    const sFmt = Utils.fmtDateStr(s);
    const eFmt = Utils.fmtDateStr(e);
    if (sFmt && eFmt) {
      if (s && e && s.slice(0, 4) === e.slice(0, 4)) {
        const sShort = sFmt.replace(/,?\s*\d{4}$/, '');
        return `${sShort} – ${eFmt}`;
      }
      return `${sFmt} – ${eFmt}`;
    }
    if (sFmt) return `From ${sFmt}`;
    return `Until ${eFmt}`;
  }
})();
