/* =========================================================
   profile.js - Profile management page
   - Edit name (and roll number for students)
   - Change password (with reauth if session is too old)
   ========================================================= */

const Profile = (() => {
  let currentUser = null;

  function render(user) {
    currentUser = user;
    const tpl = document.getElementById('tpl-profile');
    const node = tpl.content.cloneNode(true);

    // Pre-fill the form
    const nameIn = node.querySelector('#profileName');
    const rollIn = node.querySelector('#profileRoll');
    const emailIn = node.querySelector('#profileEmail');
    const roleIn = node.querySelector('#profileRole');
    const joinedIn = node.querySelector('#profileJoined');
    const rollField = node.querySelector('#profileRollField');

    nameIn.value = user.name || '';
    rollIn.value = user.rollNo || '';
    emailIn.value = user.email || '';
    roleIn.value = user.role ? (user.role.charAt(0).toUpperCase() + user.role.slice(1)) : '';
    joinedIn.value = user.createdAt ? Utils.fmtDateTime(new Date(user.createdAt)) : '—';

    // Roll number is only relevant for students
    if (user.role !== 'student') {
      rollField.classList.add('hidden');
      rollIn.disabled = true;
      rollIn.value = '';
    }

    // Wire up the forms
    node.querySelector('#profileForm').addEventListener('submit', (e) => onSaveProfile(e, nameIn, rollIn));
    node.querySelector('#passwordForm').addEventListener('submit', (e) => onChangePassword(e));

    return node;
  }

  function showMsg(el, msg, kind) {
    el.textContent = msg;
    el.classList.remove('hidden');
    el.classList.toggle('auth-error', kind === 'error');
    el.classList.toggle('auth-ok', kind === 'ok');
  }
  function clearMsg(el) {
    el.textContent = '';
    el.classList.add('hidden');
  }

  async function onSaveProfile(e, nameIn, rollIn) {
    e.preventDefault();
    const errEl = document.getElementById('profileError');
    const okEl = document.getElementById('profileOk');
    clearMsg(errEl);
    clearMsg(okEl);

    const name = (nameIn.value || '').trim();
    const roll = (rollIn.value || '').trim();

    if (!name) {
      showMsg(errEl, 'Please enter your name.', 'error');
      nameIn.focus();
      return;
    }
    if (currentUser.role === 'student' && !roll) {
      showMsg(errEl, 'Please enter your roll number.', 'error');
      rollIn.focus();
      return;
    }

    const submit = e.target.querySelector('button[type="submit"]');
    submit.disabled = true;
    const orig = submit.textContent;
    submit.textContent = 'Saving…';
    try {
      await Storage.Users.ensureProfile({
        name,
        email: currentUser.email,
        role: currentUser.role,
        rollNo: roll,
      });
      showMsg(okEl, 'Profile updated.', 'ok');
      Utils.toast('Profile saved', 'success');
    } catch (err) {
      showMsg(errEl, err.message || 'Could not save profile.', 'error');
    } finally {
      submit.disabled = false;
      submit.textContent = orig;
    }
  }

  async function onChangePassword(e) {
    e.preventDefault();
    const errEl = document.getElementById('passwordError');
    const okEl = document.getElementById('passwordOk');
    clearMsg(errEl);
    clearMsg(okEl);

    const current = document.getElementById('pwCurrent').value;
    const next = document.getElementById('pwNew').value;
    const confirm = document.getElementById('pwConfirm').value;

    if (!current) { showMsg(errEl, 'Enter your current password to confirm.', 'error'); return; }
    if (next.length < 6) { showMsg(errEl, 'New password must be at least 6 characters.', 'error'); return; }
    if (next !== confirm) { showMsg(errEl, 'New password and confirmation do not match.', 'error'); return; }
    if (next === current) { showMsg(errEl, 'New password must be different from the current one.', 'error'); return; }

    const submit = e.target.querySelector('button[type="submit"]');
    submit.disabled = true;
    const orig = submit.textContent;
    submit.textContent = 'Updating…';
    try {
      try {
        await window.fb.updatePassword(next);
      } catch (err) {
        if (err && err.code === 'auth/requires-recent-login') {
          // Re-authenticate, then retry once
          await window.fb.reauthenticate(currentUser.email, current);
          await window.fb.updatePassword(next);
        } else {
          throw err;
        }
      }
      showMsg(okEl, 'Password updated. Use it the next time you sign in.', 'ok');
      Utils.toast('Password changed', 'success');
      e.target.reset();
    } catch (err) {
      showMsg(errEl, humanPasswordError(err), 'error');
    } finally {
      submit.disabled = false;
      submit.textContent = orig;
    }
  }

  function humanPasswordError(err) {
    if (!err) return 'Could not change password.';
    switch (err.code) {
      case 'auth/wrong-password':
      case 'auth/invalid-credential':   return 'Current password is incorrect.';
      case 'auth/weak-password':        return 'New password is too weak (use 6+ characters).';
      case 'auth/requires-recent-login':return 'Please sign out and sign back in, then try again.';
      case 'auth/too-many-requests':    return 'Too many attempts. Please wait a moment and try again.';
      case 'auth/network-request-failed': return 'Network error. Check your connection.';
      default: return err.message || 'Could not change password.';
    }
  }

  return { render };
})();
