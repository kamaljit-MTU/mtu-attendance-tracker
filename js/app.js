/* =========================================================
   app.js - Main router & app bootstrap
   ========================================================= */

(function () {
  const appEl = document.getElementById('app');
  const yearEl = document.getElementById('year');
  const logoutBtn = document.getElementById('logoutBtn');
  const navLinks = document.querySelectorAll('.nav-link');
  const profileNavLink = document.getElementById('profileNavLink');
  const reportsNavLink = document.getElementById('reportsNavLink');
  const myReportNavLink = document.getElementById('myReportNavLink');

  yearEl.textContent = new Date().getFullYear();

  // -------- Setup-required screen (when Firebase is not yet configured) --------
  function renderSetupRequired() {
    Utils.clear(appEl);
    const wrap = Utils.el('section', { class: 'auth-wrap' },
      Utils.el('div', { class: 'auth-card' },
        Utils.el('h2', { class: 'auth-title' }, 'Firebase not configured'),
        Utils.el('p', { class: 'auth-sub' },
          'Edit ',
          Utils.el('code', {}, 'js/firebase-config.js'),
          ' and paste your Firebase web app config, then reload.'
        ),
        Utils.el('ol', { class: 'muted', style: 'line-height:1.7;' },
          Utils.el('li', {}, 'Create a project at ', Utils.el('strong', {}, 'console.firebase.google.com')),
          Utils.el('li', {}, 'Enable ', Utils.el('strong', {}, 'Authentication → Email/Password')),
          Utils.el('li', {}, 'Create a ', Utils.el('strong', {}, 'Firestore database'), ' (production mode)'),
          Utils.el('li', {}, 'In Project settings → General → Your apps, register a Web app and copy the config object'),
          Utils.el('li', {}, 'Paste it into ', Utils.el('code', {}, 'js/firebase-config.js'), ' and reload')
        )
      )
    );
    appEl.appendChild(wrap);
  }

  // -------- Router --------
  function getRoute() {
    const hash = window.location.hash || '#/';
    const [path] = hash.replace(/^#/, '').split('?');
    return path || '/';
  }

  function setActiveNav(route) {
    navLinks.forEach(l => l.classList.toggle('active', l.dataset.route === routeKey(route)));
  }
  function routeKey(r) {
    if (r === '/' || r === '') return 'home';
    if (r.startsWith('/instructor')) return 'instructor';
    if (r.startsWith('/student')) return 'student';
    if (r.startsWith('/profile')) return 'profile';
    if (r.startsWith('/reports')) return 'reports';
    if (r.startsWith('/my-report')) return 'my-report';
    return 'home';
  }

  async function render() {
    if (window.fb && window.fb.needsConfig) { renderSetupRequired(); return; }
    if (!window.fb || !window.fb.ready) {
      Utils.clear(appEl);
      appEl.appendChild(Utils.el('p', { class: 'muted center', style: 'padding:40px;' }, 'Loading…'));
      return;
    }

    const route = getRoute();
    setActiveNav(route);
    const user = Storage.Session.current();
    logoutBtn.classList.toggle('hidden', !user);
    if (profileNavLink) profileNavLink.classList.toggle('hidden', !user);
    if (reportsNavLink) reportsNavLink.classList.toggle('hidden', !(user && user.role === 'instructor'));
    if (myReportNavLink) myReportNavLink.classList.toggle('hidden', !(user && user.role === 'student'));

    Utils.clear(appEl);

    if (route === '/' || route === '') {
      const tpl = document.getElementById('tpl-home');
      appEl.appendChild(tpl.content.cloneNode(true));
      return;
    }
    if (route === '/instructor' || route.startsWith('/instructor')) {
      if (!user || user.role !== 'instructor') {
        appEl.appendChild(Auth.render('instructor'));
        return;
      }
      // Render the dashboard immediately. The Firestore subscriptions will
      // fire and trigger a re-render when data arrives. This avoids a
      // "stuck on Loading…" state if `Storage.ready()` is briefly false
      // (e.g. when `ensureProfile` set the user before `init` finished).
      appEl.appendChild(Instructor.render(user));
      return;
    }
    if (route === '/student' || route.startsWith('/student')) {
      if (!user || user.role !== 'student') {
        appEl.appendChild(Auth.render('student'));
        return;
      }
      appEl.appendChild(Student.render(user));
      return;
    }
    if (route === '/profile' || route.startsWith('/profile')) {
      if (!user) {
        // If someone hits /profile while signed out, send them to the home page
        window.location.hash = '#/';
        return;
      }
      appEl.appendChild(Profile.render(user));
      return;
    }
    if (route === '/reports' || route.startsWith('/reports')) {
      if (!user || user.role !== 'instructor') {
        window.location.hash = '#/';
        return;
      }
      const node = await Reports.render(user);
      appEl.appendChild(node);
      return;
    }
    if (route === '/my-report' || route.startsWith('/my-report')) {
      if (!user || user.role !== 'student') {
        window.location.hash = '#/';
        return;
      }
      const node = await Reports.renderStudent(user);
      appEl.appendChild(node);
      return;
    }

    window.location.hash = '#/';
  }

  window.App = { render, navigate };
  function navigate(hash) {
    if (window.location.hash === hash) render();
    else window.location.hash = hash;
  }

  // -------- Wire up events --------
  window.addEventListener('hashchange', render);
  logoutBtn.addEventListener('click', () => Auth.logout());

  // Re-render whenever Storage cache updates (e.g. new class appears, attendance arrives)
  Storage.onChange(render);

  // -------- Auth state -> hydrate Storage --------
  if (window.fb && !window.fb.needsConfig) {
    window.fb.onAuthChange(async (fbUser) => {
      if (fbUser) {
        await Storage.init(fbUser);
      } else {
        Storage.dispose();
      }
      // If we are on a protected route but the user is gone, kick to home
      if (!fbUser && (getRoute().startsWith('/instructor')
                   || getRoute().startsWith('/student')
                   || getRoute().startsWith('/profile'))) {
        window.location.hash = '#/';
      } else {
        render();
      }
    });
  }

  if (!window.location.hash) window.location.hash = '#/';
  render();

  // Test/dev hook: ?open=newClass | enroll | attendance auto-opens a modal after render
  const params = new URLSearchParams(window.location.search);
  const open = params.get('open');
  if (open) {
    setTimeout(() => {
      if (open === 'newClass') document.getElementById('newClassBtn')?.click();
      else if (open === 'enroll') document.getElementById('enrollBtn')?.click();
      else if (open === 'attendance') {
        const card = document.querySelector('.class-card');
        if (card) Array.from(card.querySelectorAll('button')).find(b => b.textContent === 'Attendance')?.click();
      }
    }, 400);
  }
})();
