/* =========================================================
   utils.js - Generic helpers (DOM, time, formatting, toast, modal)
   ========================================================= */

const Utils = (() => {
  // DOM helpers
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'data') for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = dv;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) node.setAttribute(k, '');
      else if (v !== false && v != null) node.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      if (c instanceof Node) node.appendChild(c);
      else node.appendChild(document.createTextNode(String(c)));
    }
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // Time helpers
  const DAY_ORDER = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function pad2(n) { return String(n).padStart(2, '0'); }

  // Convert "HH:MM" + day-of-week to a Date for the upcoming occurrence.
  // - Returns today's slot if it has not yet ended.
  // - Returns today's slot if it ended less than 1 hour ago (so the "ended" status is reachable).
  // - Otherwise returns next week's slot.
  function nextSlotDate(slot, now = new Date()) {
    const target = DAY_ORDER.indexOf(slot.day);
    const [sh, sm] = slot.start.split(':').map(Number);
    const [eh, em] = slot.end.split(':').map(Number);
    const cur = now.getDay();
    let delta = (target - cur + 7) % 7;
    const candidate = new Date(now);
    candidate.setHours(sh, sm, 0, 0);
    const candidateEnd = new Date(candidate);
    candidateEnd.setHours(eh, em, 0, 0);
    if (delta === 0) {
      const graceEnd = new Date(candidateEnd.getTime() + 60 * 60 * 1000);
      if (now > graceEnd) delta = 7; // fully past -> next week
    }
    candidate.setDate(candidate.getDate() + delta);
    const end = new Date(candidate);
    end.setHours(eh, em, 0, 0);
    return { start: candidate, end };
  }

  function slotKey(slot) {
    return `${slot.day}-${slot.start}-${slot.end}`;
  }

  function fmtTime(d) {
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  function fmtDateTime(d) {
    if (d == null) return '—';
    if (typeof d === 'number') d = new Date(d);
    else if (typeof d === 'object' && typeof d.toDate === 'function') d = d.toDate();
    if (!(d instanceof Date) || isNaN(d.getTime())) return '—';
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
  function fmtDistance(m) {
    if (m < 1000) return `${Math.round(m)} m`;
    return `${(m / 1000).toFixed(2)} km`;
  }
  function fmtCoord(n) {
    const v = Number(n);
    return Number.isFinite(v) ? v.toFixed(4) : '—';
  }

  function statusForSlot(slot, now = new Date()) {
    const { start, end } = nextSlotDate(slot, now);
    const startEarly = new Date(start.getTime() - 15 * 60 * 1000); // open 15 min before
    const lateCutoff = new Date(start.getTime() + 10 * 60 * 1000);
    if (now < startEarly) return 'upcoming';
    if (now >= startEarly && now < start) return 'opening';
    if (now >= start && now < lateCutoff) return 'on-time';
    if (now >= lateCutoff && now < end) return 'late';
    if (now >= end && now < new Date(end.getTime() + 60 * 60 * 1000)) return 'ended';
    return 'closed';
  }

  // -------- Date range helpers (course start/end) --------
  // Normalize a date input to a 'YYYY-MM-DD' string, or null if empty/invalid.
  // Accepts: 'YYYY-MM-DD', a Date, an ISO string, or ''/null/undefined.
  function normalizeDateStr(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'string') {
      // Already a YYYY-MM-DD string? Keep as-is.
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
      // Try parsing as a Date string (e.g. from toLocaleDateString)
      const d = new Date(v);
      if (!isNaN(d.getTime())) return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      return null;
    }
    if (v instanceof Date && !isNaN(v.getTime())) {
      return `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}`;
    }
    return null;
  }
  // Format a 'YYYY-MM-DD' string for display (e.g. "Jan 1, 2026"). Returns '' for null.
  function fmtDateStr(s) {
    if (!s) return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return s;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (isNaN(d.getTime())) return s;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  // Test whether a given Date (default now) is within [startStr, endStr].
  // Either bound may be null for "open ended".
  function inDateRange(d, startStr, endStr) {
    const t = d.getTime();
    if (startStr) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startStr);
      if (m) {
        const s = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
        if (t < s) return false;
      }
    }
    if (endStr) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(endStr);
      if (m) {
        // Inclusive: end of the endDate day
        const e = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999).getTime();
        if (t > e) return false;
      }
    }
    return true;
  }

  // Toasts
  const toastContainer = () => document.getElementById('toastContainer');
  function toast(message, type = 'info', duration = 3200) {
    const t = el('div', { class: `toast ${type}` }, message);
    toastContainer().appendChild(t);
    setTimeout(() => {
      t.style.opacity = '0';
      t.style.transform = 'translateX(8px)';
      setTimeout(() => t.remove(), 220);
    }, duration);
  }

  // Modal
  const modalRoot = () => document.getElementById('modalRoot');
  function openModal(content) {
    const close = () => {
      const m = modalRoot().querySelector('.modal-backdrop');
      if (m) m.remove();
    };
    const backdrop = el('div', {
      class: 'modal-backdrop',
      onclick: (e) => { if (e.target === backdrop) close(); },
    },
      el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
        el('div', { class: 'modal-head' },
          el('div', { class: 'modal-title', id: 'modalTitle' }),
          el('button', { class: 'modal-close', type: 'button', onclick: close, 'aria-label': 'Close' }, '×')
        ),
        el('div', { id: 'modalBody' }, content)
      )
    );
    modalRoot().appendChild(backdrop);
    document.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); }
    });
    return { close, body: backdrop.querySelector('#modalBody') };
  }

  function copyToClipboard(text) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }
  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove();
  }

  return {
    el, clear,
    DAY_ORDER, nextSlotDate, slotKey, fmtTime, fmtDateTime, fmtDistance, fmtCoord, statusForSlot,
    normalizeDateStr, fmtDateStr, inDateRange,
    toast, openModal, copyToClipboard, pad2,
  };
})();
