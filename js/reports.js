/* =========================================================
   reports.js - Monthly attendance sheets (Jibble-style)
   - Instructor view: pick a class + month, see a table with
     students as rows and session dates as columns, plus an
     overall % per student.
   - Student view: pick a month, see a table with classes as
     rows and dates as columns, plus an overall %.
   ========================================================= */

const Reports = (() => {
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
                       'July', 'August', 'September', 'October', 'November', 'December'];
  const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                       'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // ---------- shared helpers ----------

  // All scheduled sessions for a class in a given (year, month).
  // Returns [{ date: Date, day: 'Mon'..'Sun', slot: {day,start,end}, slotKey, label }]
  // Sessions outside the class's [startDate, endDate] window (if set) are
  // excluded so the percentage reflects the official course window only.
  function sessionsInMonth(classData, year, month /* 1-12 */) {
    const out = [];
    if (!classData || !classData.timeSlots) return out;
    const daysInMonth = new Date(year, month, 0).getDate();
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(year, month - 1, d, 12, 0, 0, 0);
      // Bound by the class's date range
      if (!Utils.inDateRange(date, classData.startDate, classData.endDate)) continue;
      const dayName = DAY_SHORT[date.getDay()];
      const matching = classData.timeSlots.filter(s => s.day === dayName);
      for (const slot of matching) {
        out.push({
          date,
          day: dayName,
          slot,
          slotKey: Utils.slotKey(slot),
          label: `${date.getDate()} ${DAY_SHORT[date.getDay()]} ${slot.start}`,
        });
      }
    }
    return out;
  }

  // Group raw attendance records (from Firestore, with .toMillis()) by
  // `${studentId}__${slotKey}__${dateKey}` for fast lookup. The date
  // component is critical: a slot's slotKey is the same for every
  // occurrence in the month (e.g. "Sat-23:00-23:30"), so without the date
  // a single record would falsely match every column of that slot.
  function dateKeyOf(d) {
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }
  function indexRecords(records) {
    const idx = {};
    for (const r of records) {
      const t = new Date(r.timestamp);
      const k = `${r.studentId}__${r.slotKey}__${dateKeyOf(t)}`;
      idx[k] = r;
    }
    return idx;
  }

  // Read 'YYYY-MM' from hash query, default to current month.
  function getMonthFromHash() {
    const m = (window.location.hash || '').match(/month=(\d{4}-\d{2})/);
    if (m) return m[1];
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }
  function getClassFromHash() {
    const m = (window.location.hash || '').match(/classId=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  // Fetch attendance records for a class within a month, from Firestore.
  // We deliberately do NOT use a server-side `timestamp` range, because that
  // would require a composite `(classId, timestamp)` index. Instead we query
  // by classId only and filter to the requested month client-side.
  async function fetchClassAttendance(classId, year, month) {
    const db = window.fb && window.fb.db;
    if (!db) return [];
    try {
      const snap = await db.collection('attendance')
        .where('classId', '==', classId)
        .get();
      return snap.docs
        .map(d => {
          const data = d.data();
          return {
            id: d.id,
            classId: data.classId,
            studentId: data.studentId,
            slot: data.slot,
            slotKey: data.slotKey,
            status: data.status || 'present',
            timestamp: data.timestamp && data.timestamp.toMillis ? data.timestamp.toMillis() : (data.timestamp || Date.now()),
          };
        })
        .filter(r => {
          const t = new Date(r.timestamp);
          return t.getFullYear() === year && t.getMonth() === month - 1;
        });
    } catch (err) {
      console.error('Failed to fetch attendance:', err);
      Utils.toast('Could not load attendance: ' + (err.message || err.code || 'unknown error'), 'error', 6000);
      return [];
    }
  }

  // Fetch attendance records for a student within a month, across all classes.
  // Same approach as fetchClassAttendance -- no composite index needed.
  async function fetchStudentAttendance(studentId, year, month) {
    const db = window.fb && window.fb.db;
    if (!db) return [];
    try {
      const snap = await db.collection('attendance')
        .where('studentId', '==', studentId)
        .get();
      return snap.docs
        .map(d => {
          const data = d.data();
          return {
            id: d.id,
            classId: data.classId,
            studentId: data.studentId,
            slot: data.slot,
            slotKey: data.slotKey,
            status: data.status || 'present',
            timestamp: data.timestamp && data.timestamp.toMillis ? data.timestamp.toMillis() : (data.timestamp || Date.now()),
          };
        })
        .filter(r => {
          const t = new Date(r.timestamp);
          return t.getFullYear() === year && t.getMonth() === month - 1;
        });
    } catch (err) {
      console.error('Failed to fetch student attendance:', err);
      Utils.toast('Could not load attendance: ' + (err.message || err.code || 'unknown error'), 'error', 6000);
      return [];
    }
  }

  // Direct fetch: enrollments for a class. The cache-based lookup
  // (Storage.Enroll.forClass) can lag behind in the UI right after a
  // subscription fires, so we hit Firestore directly for the report view.
  async function fetchClassEnrollments(classId) {
    const db = window.fb && window.fb.db;
    if (!db) return [];
    try {
      const snap = await db.collection('enrollments').where('classId', '==', classId).get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (err) {
      console.error('Failed to fetch enrollments:', err);
      return Storage.Enroll.forClass(classId) || [];
    }
  }

  // Direct fetch: user profiles for the given ids. Hydrates the cache
  // for any newly-discovered users.
  async function fetchUsers(ids) {
    const db = window.fb && window.fb.db;
    const out = {};
    if (!db || ids.length === 0) return out;
    // Start with anything already in the cache
    for (const id of ids) {
      const u = Storage.Users.findById(id);
      if (u) out[id] = u;
    }
    const missing = ids.filter(id => !out[id]);
    if (missing.length === 0) return out;
    const chunks = [];
    for (let i = 0; i < missing.length; i += 30) chunks.push(missing.slice(i, i + 30));
    for (const ch of chunks) {
      try {
        const snap = await db.collection('users')
          .where(firebase.firestore.FieldPath.documentId(), 'in', ch)
          .get();
        snap.forEach(d => { out[d.id] = { id: d.id, ...d.data() }; });
      } catch (err) {
        console.error('Failed to fetch users:', err);
      }
    }
    return out;
  }

  // ---------- instructor view ----------

  async function render(user) {
    const tpl = document.getElementById('tpl-reports');
    const node = tpl.content.cloneNode(true);
    const classSelect = node.querySelector('#reportsClass');
    const monthInput = node.querySelector('#reportsMonth');
    const tableWrap = node.querySelector('[data-bind="tableWrap"]');
    const summaryEl = node.querySelector('[data-bind="summary"]');

    // Attach export click handler NOW so the buttons are always responsive,
    // even before the data is ready. See attachExportDelegate for details.
    attachExportDelegate(node, 'instructor');

    // Populate class selector
    const classes = Storage.Classes.byInstructor(user.id).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    if (classes.length === 0) {
      Utils.clear(tableWrap);
      tableWrap.appendChild(Utils.el('p', { class: 'empty-state' }, 'No classes yet. Create a class first.'));
      classSelect.appendChild(Utils.el('option', { value: '' }, 'No classes'));
      classSelect.disabled = true;
      monthInput.disabled = true;
      Utils.clear(summaryEl);
      return node;
    }
    for (const c of classes) {
      const o = Utils.el('option', { value: c.id }, `${c.name}${c.code ? ' (' + c.code + ')' : ''}`);
      classSelect.appendChild(o);
    }

    // Initial class + month from URL or defaults
    const initialClassId = getClassFromHash() || (classes[0] && classes[0].id);
    if (initialClassId) classSelect.value = initialClassId;
    const initialMonth = getMonthFromHash();
    monthInput.value = initialMonth;

    // Render handler
    let renderToken = 0;
    const rerender = async () => {
      const myToken = ++renderToken;
      const classId = classSelect.value;
      const monthVal = monthInput.value; // YYYY-MM
      if (!classId || !monthVal) return;
      const [y, m] = monthVal.split('-').map(Number);

      // Update URL hash (preserve other params)
      updateHashParams({ classId, month: monthVal });

      Utils.clear(tableWrap);
      tableWrap.appendChild(Utils.el('p', { class: 'muted small' }, 'Loading…'));

      const cls = Storage.Classes.findById(classId);
      if (!cls) {
        Utils.clear(tableWrap);
        tableWrap.appendChild(Utils.el('p', { class: 'empty-state' }, 'Class not found.'));
        return;
      }
      const [records, sessions, enrollments] = await Promise.all([
        fetchClassAttendance(classId, y, m),
        Promise.resolve(sessionsInMonth(cls, y, m)),
        fetchClassEnrollments(classId),
      ]);
      if (myToken !== renderToken) return; // a newer render started

      // Hydrate the student profiles directly so the rows always show
      // names even if the cache hasn't caught up yet. Include students
      // from records too, so manually-added students who aren't enrolled
      // still appear in the report.
      const studentIdSet = new Set([
        ...enrollments.map(e => e.studentId),
        ...records.map(r => r.studentId),
      ]);
      const userMap = await fetchUsers(Array.from(studentIdSet));
      if (myToken !== renderToken) return;

      const recIdx = indexRecords(records);
      const students = Array.from(studentIdSet)
        .map(id => userMap[id] || Storage.Users.findById(id))
        .filter(Boolean)
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

      renderSheet({
        tableWrap, summaryEl, cls, sessions, students, recIdx, myToken, renderToken,
        columnLabel: s => `${s.date.getDate()}\n${s.day}\n${s.slot.start}`,
        onClickCell: null,
      });
      // Cache for export buttons
      setInstructorExport(node, cls, y, m, sessions, students, recIdx);
    };

    classSelect.addEventListener('change', rerender);
    monthInput.addEventListener('change', rerender);

    requestAnimationFrame(rerender);
    return node;
  }

  // ---------- student view ----------

  async function renderStudent(user) {
    const tpl = document.getElementById('tpl-my-report');
    const node = tpl.content.cloneNode(true);
    const monthInput = node.querySelector('#myReportMonth');
    const tableWrap = node.querySelector('[data-bind="tableWrap"]');
    const summaryEl = node.querySelector('[data-bind="summary"]');

    // Attach export click handler NOW so the buttons are always responsive.
    attachExportDelegate(node, 'student');

    const monthVal = getMonthFromHash();
    monthInput.value = monthVal;

    let renderToken = 0;
    const rerender = async () => {
      const myToken = ++renderToken;
      const mv = monthInput.value;
      if (!mv) return;
      const [y, m] = mv.split('-').map(Number);

      updateHashParams({ month: mv });

      Utils.clear(tableWrap);
      tableWrap.appendChild(Utils.el('p', { class: 'muted small' }, 'Loading…'));

      const enrollments = Storage.Enroll.forStudent(user.id);
      const classes = enrollments
        .map(e => Storage.Classes.findById(e.classId))
        .filter(Boolean);

      if (classes.length === 0) {
        Utils.clear(tableWrap);
        tableWrap.appendChild(Utils.el('p', { class: 'empty-state' }, 'You are not enrolled in any class.'));
        Utils.clear(summaryEl);
        return;
      }

      const [records] = await Promise.all([
        fetchStudentAttendance(user.id, y, m),
      ]);
      if (myToken !== renderToken) return;

      const recIdx = indexRecords(records);
      // For each class, compute its sessions in the month
      const classSessions = classes.map(c => ({
        cls: c,
        sessions: sessionsInMonth(c, y, m),
      }));

      renderStudentSheet({
        tableWrap, summaryEl, classSessions, recIdx, studentId: user.id, myToken, renderToken,
      });
      // Cache for export buttons
      setStudentExport(node, user, y, m, classSessions, recIdx);
    };

    monthInput.addEventListener('change', rerender);
    requestAnimationFrame(rerender);
    return node;
  }

  // ---------- shared sheet renderer ----------

  // Jibble-style sheet: rows = students, columns = sessions, last col = %.
  // Used by the instructor view.
  function renderSheet({ tableWrap, summaryEl, cls, sessions, students, recIdx, myToken, renderToken, columnLabel }) {
    Utils.clear(tableWrap);
    Utils.clear(summaryEl);

    if (sessions.length === 0) {
      tableWrap.appendChild(Utils.el('p', { class: 'empty-state' },
        'No scheduled sessions in this month for this class.'));
      return;
    }

    // Build the table
    const table = Utils.el('table', { class: 'sheet-table' });
    const thead = Utils.el('thead');
    const headRow = Utils.el('tr');
    headRow.appendChild(Utils.el('th', { class: 'sheet-th-name' },
      Utils.el('div', {}, 'Student'),
      Utils.el('div', { class: 'muted small' }, `${cls.name} · ${cls.code || '—'}`),
      (cls.startDate || cls.endDate)
        ? Utils.el('div', { class: 'muted small', style: 'margin-top:2px;color:var(--accent,#2563eb);' },
            `Period: ${classPeriodLabel(cls)}`)
        : null
    ));
    for (const s of sessions) {
      const th = Utils.el('th', { class: 'sheet-th-date' });
      th.appendChild(Utils.el('div', { class: 'sheet-date-num' }, String(s.date.getDate())));
      th.appendChild(Utils.el('div', { class: 'sheet-date-day' }, s.day));
      th.appendChild(Utils.el('div', { class: 'sheet-date-time' }, s.slot.start));
      headRow.appendChild(th);
    }
    headRow.appendChild(Utils.el('th', { class: 'sheet-th-pct' }, '%'));
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = Utils.el('tbody');
    let classPresent = 0, classLate = 0, classAbsent = 0, classTotal = 0;

    if (students.length === 0) {
      const tr = Utils.el('tr');
      tr.appendChild(Utils.el('td', { colspan: String(sessions.length + 2), class: 'sheet-empty' },
        'No students enrolled in this class yet.'));
      tbody.appendChild(tr);
    } else {
      for (const stu of students) {
        const tr = Utils.el('tr');
        const nameTd = Utils.el('td', { class: 'sheet-td-name' },
          Utils.el('div', { class: 'sheet-stu-name' }, stu.name || '—'),
          stu.rollNo ? Utils.el('div', { class: 'sheet-stu-roll muted small' }, stu.rollNo) : null
        );
        tr.appendChild(nameTd);
        let pres = 0, late = 0, abs = 0;
        for (const s of sessions) {
          const r = recIdx[`${stu.id}__${s.slotKey}__${dateKeyOf(s.date)}`];
          let cls2 = 'cell-na', tip = 'No record', txt = '·';
          if (r) {
            if (r.status === 'late') { cls2 = 'cell-late'; tip = 'Late'; late++; pres++; txt = 'L'; }
            else if (r.status === 'absent') { cls2 = 'cell-absent'; tip = 'Absent (manual)'; abs++; txt = 'A'; }
            else { cls2 = 'cell-present'; tip = 'Present'; pres++; txt = 'P'; }
          } else {
            // The session is in the past (or today) but no record -> absent
            if (s.date.getTime() < Date.now() - 12 * 3600 * 1000) { cls2 = 'cell-absent'; tip = 'Absent'; abs++; txt = 'A'; }
            else { cls2 = 'cell-future'; tip = 'Upcoming'; txt = '·'; }
          }
          const td = Utils.el('td', { class: `sheet-td ${cls2}`, title: tip });
          td.textContent = txt;
          tr.appendChild(td);
        }
        const total = pres + abs;
        const pct = total === 0 ? '—' : Math.round((pres / total) * 100) + '%';
        tr.appendChild(Utils.el('td', { class: `sheet-td-pct ${pctCellClass(pct)}` }, pct));
        tbody.appendChild(tr);
        classPresent += pres; classLate += late; classAbsent += abs; classTotal += total;
      }
    }
    table.appendChild(tbody);

    // Footer (class average)
    const tfoot = Utils.el('tfoot');
    const footRow = Utils.el('tr', { class: 'sheet-foot' });
    footRow.appendChild(Utils.el('td', { class: 'sheet-td-name' },
      Utils.el('strong', {}, 'Class average')));
    for (let i = 0; i < sessions.length; i++) {
      footRow.appendChild(Utils.el('td', { class: 'sheet-td sheet-foot-cell' }, ''));
    }
    const classTotal2 = classPresent + classAbsent;
    const classPct = classTotal2 === 0 ? '—' : Math.round((classPresent / classTotal2) * 100) + '%';
    footRow.appendChild(Utils.el('td', { class: `sheet-td-pct ${pctCellClass(classPct)}` },
      Utils.el('strong', {}, classPct)));
    tfoot.appendChild(footRow);
    table.appendChild(tfoot);

    tableWrap.appendChild(table);

    // Summary
    summaryEl.appendChild(Utils.el('div', { class: 'reports-pill' },
      Utils.el('strong', {}, `${students.length}`), ' students'));
    summaryEl.appendChild(Utils.el('div', { class: 'reports-pill pill-present' },
      Utils.el('strong', {}, `${classPresent}`), ' present'));
    summaryEl.appendChild(Utils.el('div', { class: 'reports-pill pill-late' },
      Utils.el('strong', {}, `${classLate}`), ' late'));
    summaryEl.appendChild(Utils.el('div', { class: 'reports-pill pill-absent' },
      Utils.el('strong', {}, `${classAbsent}`), ' absent'));
    summaryEl.appendChild(Utils.el('div', { class: 'reports-pill' },
      Utils.el('strong', {}, classPct), ' overall'));
  }

  // Student sheet: rows = classes, columns = session dates, last col = %.
  function renderStudentSheet({ tableWrap, summaryEl, classSessions, recIdx, studentId, myToken, renderToken }) {
    Utils.clear(tableWrap);
    Utils.clear(summaryEl);

    // Collect all unique session dates across the student's classes
    const allDates = new Set();
    for (const cs of classSessions) {
      for (const s of cs.sessions) {
        allDates.add(s.date.toDateString());
      }
    }
    const dates = Array.from(allDates)
      .map(d => new Date(d))
      .sort((a, b) => a - b);

    if (dates.length === 0) {
      tableWrap.appendChild(Utils.el('p', { class: 'empty-state' },
        'No scheduled sessions in this month.'));
      return;
    }

    const table = Utils.el('table', { class: 'sheet-table' });
    const thead = Utils.el('thead');
    const headRow = Utils.el('tr');
    headRow.appendChild(Utils.el('th', { class: 'sheet-th-name' }, 'Class'));
    for (const d of dates) {
      const th = Utils.el('th', { class: 'sheet-th-date' });
      th.appendChild(Utils.el('div', { class: 'sheet-date-num' }, String(d.getDate())));
      th.appendChild(Utils.el('div', { class: 'sheet-date-day' }, DAY_SHORT[d.getDay()]));
      headRow.appendChild(th);
    }
    headRow.appendChild(Utils.el('th', { class: 'sheet-th-pct' }, '%'));
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = Utils.el('tbody');
    let grandPres = 0, grandLate = 0, grandAbs = 0, grandTotal = 0;

    for (const cs of classSessions) {
      const tr = Utils.el('tr');
      tr.appendChild(Utils.el('td', { class: 'sheet-td-name' },
        Utils.el('div', { class: 'sheet-stu-name' }, cs.cls.name || '—'),
        Utils.el('div', { class: 'muted small' }, cs.cls.code || '')
      ));
      let pres = 0, late = 0, abs = 0;
      for (const d of dates) {
        // Find any session of this class on this date
        const dayName = DAY_SHORT[d.getDay()];
        const matchingSessions = cs.sessions.filter(s => s.date.toDateString() === d.toDateString());
        if (matchingSessions.length === 0) {
          tr.appendChild(Utils.el('td', { class: 'sheet-td cell-na' }, '·'));
          continue;
        }
        // Show combined status: P if any present, L if any late, A if absent, · if future
        let anyLate = false, anyPres = false, anyAbsent = false, anyFuture = false;
        for (const s of matchingSessions) {
          const r = recIdx[`${studentId}__${s.slotKey}__${dateKeyOf(s.date)}`];
          if (r) {
            if (r.status === 'late') anyLate = true;
            else if (r.status === 'absent') anyAbsent = true;
            else anyPres = true;
          } else if (s.date.getTime() < Date.now() - 12 * 3600 * 1000) {
            anyAbsent = true;
          } else {
            anyFuture = true;
          }
        }
        let cls2 = 'cell-na', txt = '·';
        if (anyLate) { cls2 = 'cell-late'; txt = 'L'; late++; pres++; }
        else if (anyPres) { cls2 = 'cell-present'; txt = 'P'; pres++; }
        else if (anyAbsent) { cls2 = 'cell-absent'; txt = 'A'; abs++; }
        else if (anyFuture) { cls2 = 'cell-future'; txt = '·'; }
        tr.appendChild(Utils.el('td', { class: `sheet-td ${cls2}` }, txt));
      }
      const total = pres + abs;
      const pct = total === 0 ? '—' : Math.round((pres / total) * 100) + '%';
      tr.appendChild(Utils.el('td', { class: `sheet-td-pct ${pctCellClass(pct)}` }, pct));
      tbody.appendChild(tr);
      grandPres += pres; grandLate += late; grandAbs += abs; grandTotal += total;
    }
    table.appendChild(tbody);

    // Footer
    const tfoot = Utils.el('tfoot');
    const footRow = Utils.el('tr', { class: 'sheet-foot' });
    footRow.appendChild(Utils.el('td', { class: 'sheet-td-name' },
      Utils.el('strong', {}, 'Overall')));
    for (let i = 0; i < dates.length; i++) {
      footRow.appendChild(Utils.el('td', { class: 'sheet-td sheet-foot-cell' }, ''));
    }
    const grandTotal2 = grandPres + grandAbs;
    const grandPct = grandTotal2 === 0 ? '—' : Math.round((grandPres / grandTotal2) * 100) + '%';
    footRow.appendChild(Utils.el('td', { class: `sheet-td-pct ${pctCellClass(grandPct)}` },
      Utils.el('strong', {}, grandPct)));
    tfoot.appendChild(footRow);
    table.appendChild(tfoot);

    tableWrap.appendChild(table);

    // Summary
    summaryEl.appendChild(Utils.el('div', { class: 'reports-pill' },
      Utils.el('strong', {}, `${classSessions.length}`), ' classes'));
    summaryEl.appendChild(Utils.el('div', { class: 'reports-pill pill-present' },
      Utils.el('strong', {}, `${grandPres}`), ' present'));
    summaryEl.appendChild(Utils.el('div', { class: 'reports-pill pill-late' },
      Utils.el('strong', {}, `${grandLate}`), ' late'));
    summaryEl.appendChild(Utils.el('div', { class: 'reports-pill pill-absent' },
      Utils.el('strong', {}, `${grandAbs}`), ' absent'));
    summaryEl.appendChild(Utils.el('div', { class: 'reports-pill' },
      Utils.el('strong', {}, grandPct), ' overall'));
  }

  function pctCellClass(pct) {
    if (pct === '—') return 'pct-na';
    const n = parseInt(pct, 10);
    if (n >= 85) return 'pct-good';
    if (n >= 75) return 'pct-warn';
    return 'pct-bad';
  }

  // Human-friendly class period, e.g. "Jan 1 – May 30, 2026" or "Jan 1, 2026 –".
  function classPeriodLabel(cls) {
    if (!cls) return '';
    const s = cls.startDate, e = cls.endDate;
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
    if (sFmt) return `${sFmt} –`;
    return `– ${eFmt}`;
  }

  // Update query string in hash without triggering a navigation
  function updateHashParams(params) {
    const hash = window.location.hash || '#/';
    const [path, query] = hash.split('?');
    const sp = new URLSearchParams(query || '');
    for (const [k, v] of Object.entries(params)) {
      if (v == null) sp.delete(k); else sp.set(k, v);
    }
    const newQuery = sp.toString();
    const newHash = path + (newQuery ? '?' + newQuery : '');
    if (newHash !== hash) {
      history.replaceState(null, '', newHash);
    }
  }

  // ---------- Export ----------
  // Cached report payloads. The render functions set these when they
  // finish a render; the export buttons read from them.
  let lastInstructor = null;  // { cls, year, month, sessions, students, recIdx, classStats }
  let lastStudent = null;     // { student, year, month, classSessions, recIdx, grandStats }

  // Click handler is delegated on the export container so the listener is
  // attached as soon as the node is created (NOT after data loads). This
  // means the button is always responsive: if data isn't ready yet, the
  // user gets a friendly "Loading…" toast instead of a silent failure.
  function attachExportDelegate(node, kind /* 'instructor' | 'student' */) {
    const exportEl = node.querySelector('[data-bind="export"]');
    if (!exportEl) return;
    exportEl.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-export]');
      if (!btn) return;
      e.preventDefault();
      const fmt = btn.getAttribute('data-export');
      try {
        if (kind === 'instructor') {
          if (!lastInstructor) {
            Utils.toast('Report is still loading. Please try again in a moment.', 'warn', 3000);
            return;
          }
          if (fmt === 'csv') downloadInstructorCSV();
          else if (fmt === 'xlsx') downloadInstructorXLSX();
          else Utils.toast('Unknown export format: ' + fmt, 'error');
        } else {
          if (!lastStudent) {
            Utils.toast('Report is still loading. Please try again in a moment.', 'warn', 3000);
            return;
          }
          if (fmt === 'csv') downloadStudentCSV();
          else if (fmt === 'xlsx') downloadStudentXLSX();
          else Utils.toast('Unknown export format: ' + fmt, 'error');
        }
      } catch (err) {
        console.error('Export error:', err);
        Utils.toast('Export failed: ' + (err.message || err), 'error', 5000);
      }
    });
  }

  function setInstructorExport(node, cls, year, month, sessions, students, recIdx) {
    lastInstructor = { cls, year, month, sessions, students, recIdx };
  }

  function setStudentExport(node, student, year, month, classSessions, recIdx) {
    lastStudent = { student, year, month, classSessions, recIdx };
  }

  // Build the AOA (array-of-arrays) for the instructor report
  function buildInstructorAOA() {
    if (!lastInstructor) return null;
    const { cls, year, month, sessions, students, recIdx } = lastInstructor;
    const monthLabel = `${MONTH_NAMES[month - 1]} ${year}`;
    const aoa = [];
    aoa.push([`Class: ${cls.name}${cls.code ? ' (' + cls.code + ')' : ''}`]);
    aoa.push([`Month: ${monthLabel}`]);
    aoa.push([`Exported: ${new Date().toLocaleString()}`]);
    aoa.push([]);
    // Header
    const header = ['Student'];
    for (const s of sessions) header.push(`${s.date.getDate()} ${DAY_SHORT[s.date.getDay()]} ${s.slot.start}–${s.slot.end}`);
    header.push('Present', 'Late', 'Absent', 'Sessions', 'Attendance %');
    aoa.push(header);
    // Body
    let totP = 0, totL = 0, totA = 0, totT = 0;
    for (const stu of students) {
      let p = 0, l = 0, a = 0;
      const row = [`${stu.name || '—'}${stu.rollNo ? ' (' + stu.rollNo + ')' : ''}`];
      for (const s of sessions) {
        const r = recIdx[`${stu.id}__${s.slotKey}__${dateKeyOf(s.date)}`];
        let cell;
        if (r) {
          if (r.status === 'late') { cell = 'Late'; l++; p++; }
          else if (r.status === 'absent') { cell = 'Absent'; a++; }
          else { cell = 'Present'; p++; }
        } else {
          if (s.date.getTime() < Date.now() - 12 * 3600 * 1000) { cell = 'Absent'; a++; }
          else { cell = '—'; }
        }
        row.push(cell);
      }
      const total = p + a;
      const pct = total === 0 ? '—' : Math.round((p / total) * 100) + '%';
      row.push(p - l, l, a, total, pct);
      aoa.push(row);
      totP += p; totL += l; totA += a; totT += total;
    }
    // Footer
    const totP2 = totP - totL;
    const totT2 = totP + totA;
    const classPct = totT2 === 0 ? '—' : Math.round((totP / totT2) * 100) + '%';
    const foot = ['Class average'];
    for (let i = 0; i < sessions.length; i++) foot.push('');
    foot.push(totP2, totL, totA, totT2, classPct);
    aoa.push(foot);
    return { aoa, fileBase: `${cls.name || 'class'}-${year}-${String(month).padStart(2,'0')}` };
  }

  function buildStudentAOA() {
    if (!lastStudent) return null;
    const { student, year, month, classSessions, recIdx } = lastStudent;
    const monthLabel = `${MONTH_NAMES[month - 1]} ${year}`;
    // Collect all unique dates
    const allDates = new Set();
    for (const cs of classSessions) {
      for (const s of cs.sessions) allDates.add(dateKeyOf(s.date));
    }
    const dates = Array.from(allDates)
      .map(k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m, d, 12); })
      .sort((a, b) => a - b);
    const aoa = [];
    aoa.push([`Student: ${student.name || '—'}`]);
    aoa.push([`Month: ${monthLabel}`]);
    aoa.push([`Exported: ${new Date().toLocaleString()}`]);
    aoa.push([]);
    const header = ['Class'];
    for (const d of dates) header.push(`${d.getDate()} ${DAY_SHORT[d.getDay()]}`);
    header.push('Present', 'Late', 'Absent', 'Sessions', 'Attendance %');
    aoa.push(header);
    let gP = 0, gL = 0, gA = 0, gT = 0;
    for (const cs of classSessions) {
      let p = 0, l = 0, a = 0;
      const row = [`${cs.cls.name || '—'}${cs.cls.code ? ' (' + cs.cls.code + ')' : ''}`];
      for (const d of dates) {
        const dayName = DAY_SHORT[d.getDay()];
        const matching = cs.sessions.filter(s => dateKeyOf(s.date) === dateKeyOf(d));
        if (matching.length === 0) { row.push('—'); continue; }
        let anyLate = false, anyPres = false, anyAbsent = false, anyFuture = false;
        for (const s of matching) {
          const r = recIdx[`${student.id}__${s.slotKey}__${dateKeyOf(s.date)}`];
          if (r) {
            if (r.status === 'late') anyLate = true;
            else if (r.status === 'absent') anyAbsent = true;
            else anyPres = true;
          } else if (s.date.getTime() < Date.now() - 12 * 3600 * 1000) {
            anyAbsent = true;
          } else {
            anyFuture = true;
          }
        }
        let cell;
        if (anyLate) { cell = 'Late'; l++; p++; }
        else if (anyPres) { cell = 'Present'; p++; }
        else if (anyAbsent) { cell = 'Absent'; a++; }
        else { cell = '—'; }
        row.push(cell);
      }
      const total = p + a;
      const pct = total === 0 ? '—' : Math.round((p / total) * 100) + '%';
      row.push(p - l, l, a, total, pct);
      aoa.push(row);
      gP += p; gL += l; gA += a; gT += total;
    }
    const gP2 = gP - gL;
    const gT2 = gP + gA;
    const overall = gT2 === 0 ? '—' : Math.round((gP / gT2) * 100) + '%';
    const foot = ['Overall'];
    for (let i = 0; i < dates.length; i++) foot.push('');
    foot.push(gP2, gL, gA, gT2, overall);
    aoa.push(foot);
    return { aoa, fileBase: `my-attendance-${year}-${String(month).padStart(2,'0')}` };
  }

  // CSV escaping
  function csvCell(v) {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function aoaToCSV(aoa) {
    return aoa.map(row => row.map(csvCell).join(',')).join('\r\n');
  }
  function downloadBlob(content, filename, mime) {
    try {
      const blob = (content instanceof Blob) ? content : new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 200);
    } catch (err) {
      Utils.toast('Browser blocked the download: ' + (err.message || err), 'error', 5000);
      throw err;
    }
  }
  function downloadInstructorCSV() {
    const built = buildInstructorAOA();
    if (!built) { Utils.toast('Nothing to export yet.', 'warn'); return; }
    if (!built.aoa || built.aoa.length === 0) { Utils.toast('No data to export.', 'warn'); return; }
    const csv = aoaToCSV(built.aoa);
    // Prefix with UTF-8 BOM so Excel opens it correctly.
    downloadBlob('\ufeff' + csv, `${built.fileBase}.csv`, 'text/csv;charset=utf-8;');
    Utils.toast('CSV downloaded: ' + `${built.fileBase}.csv`, 'success', 2500);
  }
  function downloadStudentCSV() {
    const built = buildStudentAOA();
    if (!built) { Utils.toast('Nothing to export yet.', 'warn'); return; }
    if (!built.aoa || built.aoa.length === 0) { Utils.toast('No data to export.', 'warn'); return; }
    const csv = aoaToCSV(built.aoa);
    downloadBlob('\ufeff' + csv, `${built.fileBase}.csv`, 'text/csv;charset=utf-8;');
    Utils.toast('CSV downloaded: ' + `${built.fileBase}.csv`, 'success', 2500);
  }
  function downloadInstructorXLSX() {
    if (typeof XLSX === 'undefined') {
      Utils.toast('Excel library not loaded. Falling back to CSV.', 'warn', 3500);
      return downloadInstructorCSV();
    }
    const built = buildInstructorAOA();
    if (!built) { Utils.toast('Nothing to export yet.', 'warn'); return; }
    if (!built.aoa || built.aoa.length === 0) { Utils.toast('No data to export.', 'warn'); return; }
    try {
      const ws = XLSX.utils.aoa_to_sheet(built.aoa);
      // Set column widths
      ws['!cols'] = [{ wch: 26 }, ...Array((built.aoa[4] && built.aoa[4].length - 1) || 0).fill(0).map(() => ({ wch: 14 }))];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Attendance');
      XLSX.writeFile(wb, `${built.fileBase}.xlsx`);
      Utils.toast('XLSX downloaded: ' + `${built.fileBase}.xlsx`, 'success', 2500);
    } catch (err) {
      console.error('XLSX error:', err);
      Utils.toast('Excel export failed, falling back to CSV.', 'warn', 3500);
      return downloadInstructorCSV();
    }
  }
  function downloadStudentXLSX() {
    if (typeof XLSX === 'undefined') {
      Utils.toast('Excel library not loaded. Falling back to CSV.', 'warn', 3500);
      return downloadStudentCSV();
    }
    const built = buildStudentAOA();
    if (!built) { Utils.toast('Nothing to export yet.', 'warn'); return; }
    if (!built.aoa || built.aoa.length === 0) { Utils.toast('No data to export.', 'warn'); return; }
    try {
      const ws = XLSX.utils.aoa_to_sheet(built.aoa);
      ws['!cols'] = [{ wch: 26 }, ...Array((built.aoa[4] && built.aoa[4].length - 1) || 0).fill(0).map(() => ({ wch: 14 }))];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'My Attendance');
      XLSX.writeFile(wb, `${built.fileBase}.xlsx`);
      Utils.toast('XLSX downloaded: ' + `${built.fileBase}.xlsx`, 'success', 2500);
    } catch (err) {
      console.error('XLSX error:', err);
      Utils.toast('Excel export failed, falling back to CSV.', 'warn', 3500);
      return downloadStudentCSV();
    }
  }

  return { render, renderStudent };
})();
