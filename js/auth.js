/* =========================================================
   auth.js - Firebase Auth sign-in / sign-up flow
   - New email -> create account, write profile
   - Existing email -> sign in
   - Role and (for students) roll number captured at sign-in
   ========================================================= */

const Auth = (() => {
  function render(role) {
    const tpl = document.getElementById('tpl-auth');
    const node = tpl.content.cloneNode(true);
    const title = node.querySelector('[data-bind="title"]');
    const sub = node.querySelector('[data-bind="subtitle"]');
    const roleSelect = node.querySelector('#authRole');
    const nameField = node.querySelector('#authName').closest('.field');
    const rollField = node.querySelector('#rollNoField');
    const pwField = node.querySelector('#pwField');
    const pwLabel = node.querySelector('[data-bind="pwLabel"]');
    const submitBtn = node.querySelector('#authSubmit');
    const errEl = node.querySelector('#authError');
    const toggleBtn = node.querySelector('#authToggleMode');

    let mode = 'signin'; // or 'signup'

    const forgotBtn = node.querySelector('#authForgot');
    const isInstructor = role === 'instructor';
    title.textContent = isInstructor ? 'Instructor sign-in' : 'Student sign-in';
    sub.textContent = isInstructor
      ? 'Sign in to create classes and track attendance.'
      : 'Sign in to enroll in classes and mark attendance.';

    if (role) roleSelect.value = role;
    const toggleRoll = () => {
      rollField.classList.toggle('hidden', roleSelect.value !== 'student');
    };
    roleSelect.addEventListener('change', toggleRoll);
    toggleRoll();

    function paintMode() {
      if (mode === 'signin') {
        submitBtn.textContent = 'Sign in';
        pwLabel.textContent = 'Password';
        toggleBtn.textContent = 'New here? Create an account';
        nameField.classList.add('hidden');
        node.querySelector('#authName').required = false;
        forgotBtn.classList.remove('hidden');
      } else {
        submitBtn.textContent = 'Create account';
        pwLabel.textContent = 'Choose a password (6+ chars)';
        toggleBtn.textContent = 'Already have an account? Sign in';
        nameField.classList.remove('hidden');
        node.querySelector('#authName').required = true;
        forgotBtn.classList.add('hidden');
      }
      errEl.textContent = '';
      errEl.classList.add('hidden');
      errEl.classList.remove('auth-error', 'auth-ok');
    }
    paintMode();
    toggleBtn.addEventListener('click', (e) => {
      e.preventDefault();
      mode = (mode === 'signin') ? 'signup' : 'signin';
      paintMode();
    });

    forgotBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      errEl.classList.add('hidden');
      const email = (node.querySelector('#authEmail').value || '').toString().trim();
      if (!email) {
        showErr('Enter your MTU email above, then tap "Forgot password?".');
        node.querySelector('#authEmail').focus();
        return;
      }
      const orig = forgotBtn.textContent;
      forgotBtn.disabled = true;
      forgotBtn.textContent = 'Sending reset link…';
      try {
        await window.fb.resetPassword(email);
        Utils.toast(`Password reset link sent to ${email}`, 'success', 5000);
        errEl.textContent = `Reset link sent. Check the inbox for ${email}.`;
        errEl.classList.remove('hidden');
        errEl.classList.add('auth-ok');
        errEl.classList.remove('auth-error');
      } catch (err) {
        errEl.classList.remove('auth-ok');
        errEl.classList.add('auth-error');
        showErr(humanResetError(err));
      } finally {
        forgotBtn.disabled = false;
        forgotBtn.textContent = orig;
      }
    });

    const form = node.querySelector('#authForm');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errEl.classList.add('hidden');
      const fd = new FormData(form);
      const nameIn = (fd.get('name') || '').toString().trim();
      const email = (fd.get('email') || '').toString().trim();
      const password = (fd.get('password') || '').toString();
      const r = (fd.get('role') || '').toString();
      const roll = (fd.get('roll') || '').toString().trim();
      if (mode === 'signup' && !nameIn) return showErr('Please enter your name.');
      if (!email || !r || !password) return showErr('Please fill all fields.');
      if (password.length < 6) return showErr('Password must be at least 6 characters.');

      submitBtn.disabled = true;
      submitBtn.textContent = mode === 'signin' ? 'Signing in…' : 'Creating account…';
      try {
        // Stash role/roll for Storage.init to consume after auth
        window.__pendingRole = r;
        window.__pendingRoll = roll;

        if (mode === 'signup') {
          try {
            await window.fb.signUp({ email, password });
          } catch (err) {
            if (err && err.code === 'auth/email-already-in-use') {
              // Switch to sign-in mode and retry
              mode = 'signin';
              paintMode();
              await window.fb.signIn({ email, password });
            } else { throw err; }
          }
        } else {
          await window.fb.signIn({ email, password });
        }

        // Make sure the profile exists/has the latest name & role
        const fbUser = window.fb.currentUser();
        const existing = Storage.Session.current();
        const name = (mode === 'signin' && existing && existing.name) ? existing.name : nameIn;
        await Storage.Users.ensureProfile({ name, email, role: r, rollNo: roll });

        Utils.toast(`Welcome, ${name}!`, 'success');
        const target = r === 'instructor' ? '#/instructor' : '#/student';
        if (window.App && window.App.navigate) window.App.navigate(target);
        else window.location.hash = target;
      } catch (err) {
        showErr(humanAuthError(err));
        window.__pendingRole = null;
        window.__pendingRoll = null;
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = mode === 'signin' ? 'Sign in' : 'Create account';
      }
    });

    function showErr(msg) {
      errEl.textContent = msg;
      errEl.classList.remove('hidden');
      errEl.classList.add('auth-error');
      errEl.classList.remove('auth-ok');
    }

    return node;
  }

  function humanAuthError(err) {
    if (!err) return 'Something went wrong.';
    switch (err.code) {
      case 'auth/invalid-email':        return 'That email address looks invalid.';
      case 'auth/user-not-found':
      case 'auth/wrong-password':
      case 'auth/invalid-credential':   return 'Email or password is incorrect.';
      case 'auth/email-already-in-use': return 'An account with that email already exists. Sign in instead.';
      case 'auth/weak-password':        return 'Password is too weak (use 6+ characters).';
      case 'auth/too-many-requests':    return 'Too many attempts. Please wait a moment and try again.';
      case 'auth/network-request-failed': return 'Network error. Check your connection.';
      default: return err.message || 'Could not authenticate.';
    }
  }

  function humanResetError(err) {
    if (!err) return 'Could not send the reset email.';
    switch (err.code) {
      case 'auth/invalid-email':          return 'That email address looks invalid.';
      case 'auth/user-not-found':         return 'No account exists for that email.';
      case 'auth/missing-email':          return 'Enter your email address first.';
      case 'auth/too-many-requests':      return 'Too many requests. Please wait a moment and try again.';
      case 'auth/network-request-failed': return 'Network error. Check your connection.';
      default: return err.message || 'Could not send the reset email.';
    }
  }

  function logout() {
    Storage.Session.signOut().then(() => {
      Utils.toast('Logged out', 'info');
      if (window.App && window.App.navigate) window.App.navigate('#/');
      else window.location.hash = '#/';
    });
  }

  function current() { return Storage.Session.current(); }

  function requireRole(role) {
    const user = current();
    if (!user) {
      window.location.hash = '#/' + role;
      return null;
    }
    if (user.role !== role) {
      Utils.toast(`Please sign in as a ${role}.`, 'warn');
      window.location.hash = '#/' + role;
      return null;
    }
    return user;
  }

  return { render, logout, current, requireRole };
})();
