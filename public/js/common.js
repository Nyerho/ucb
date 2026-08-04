const JIVO_WIDGET_ID = 'f76XwJf0YP';

function getJivoScriptSelector() {
  return `script[src*="code.jivosite.com/widget/${JIVO_WIDGET_ID}"]`;
}

function ensureJivoWidgetLoaded() {
  if (document.querySelector(getJivoScriptSelector())) {
    return;
  }

  const script = document.createElement('script');
  script.src = `https://code.jivosite.com/widget/${JIVO_WIDGET_ID}`;
  script.async = true;
  script.setAttribute('data-jivo-managed', 'true');
  document.body.appendChild(script);
}

function openJivoWidget() {
  if (window.jivo_api && typeof window.jivo_api.open === 'function') {
    window.jivo_api.open();
    return true;
  }
  return false;
}

function initJivoChatLauncher() {
  if (!document.body || document.getElementById('jivoChatLauncher')) {
    return;
  }

  ensureJivoWidgetLoaded();

  const launcher = document.createElement('button');
  launcher.type = 'button';
  launcher.id = 'jivoChatLauncher';
  launcher.className = 'jivo-chat-launcher';
  launcher.setAttribute('aria-label', 'Open live chat');
  launcher.innerHTML = `
    <span class="jivo-chat-launcher__icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" focusable="false">
        <path d="M12 3C6.477 3 2 7.03 2 12c0 2.054.765 3.947 2.047 5.467L3 21l4.01-1.61A10.43 10.43 0 0 0 12 21c5.523 0 10-4.03 10-9s-4.477-9-10-9Zm-4 8.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm4 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm4 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z"/>
      </svg>
    </span>
    <span class="jivo-chat-launcher__label">Live Chat</span>
  `;

  launcher.addEventListener('click', () => {
    ensureJivoWidgetLoaded();
    if (openJivoWidget()) {
      return;
    }

    launcher.classList.add('is-loading');
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      if (openJivoWidget()) {
        launcher.classList.remove('is-loading');
        window.clearInterval(timer);
        return;
      }

      if (Date.now() - startedAt >= 5000) {
        launcher.classList.remove('is-loading');
        window.clearInterval(timer);
        window.location.href = '/contact';
      }
    }, 250);
  });

  document.body.appendChild(launcher);
}

document.addEventListener('DOMContentLoaded', () => {
  try {
    const errorToast = document.getElementById('toast-error');
    const successToast = document.getElementById('toast-success');

    [errorToast, successToast].forEach(t => {
      if (t) {
        setTimeout(() => {
          t.style.transition = 'all 0.4s ease';
          t.style.opacity = '0';
          t.style.transform = 'translateX(100px)';
          setTimeout(() => { try { t.remove(); } catch (_) {} }, 400);
        }, 5000);
      }
    });

    const userDropBtn = document.getElementById('userDropBtn');
    const userDropMenu = document.getElementById('userDropMenu');
    if (userDropBtn && userDropMenu) {
      userDropBtn.addEventListener('click', e => {
        e.stopPropagation();
        userDropMenu.classList.toggle('show');
      });
      document.addEventListener('click', () => userDropMenu.classList.remove('show'));
    }

    const notifBtn = document.getElementById('notifBtn');
    if (notifBtn) {
      fetch('/api/user/notifications')
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          const dot = document.getElementById('notifDot');
          if (dot && data && data.unread > 0) dot.style.display = 'block';
        })
        .catch(() => {});
    }

    const appSidebar = document.getElementById('appSidebar');
    if (appSidebar) {
      const resetMobileSidebarState = () => {
        if (window.innerWidth >= 992) return;
        appSidebar.classList.remove('show', 'showing');
        document.body.classList.remove('offcanvas-open', 'overflow-hidden');
        document.querySelectorAll('.offcanvas-backdrop').forEach(el => el.remove());
      };

      const closeSidebarIfMobile = () => {
        try {
          if (window.innerWidth >= 992) return;
          if (window.bootstrap?.Offcanvas) {
            const inst = bootstrap.Offcanvas.getOrCreateInstance(appSidebar);
            if (inst && appSidebar.classList.contains('show')) {
              inst.hide();
            }
          } else {
            resetMobileSidebarState();
          }
        } catch (e) {
          console.warn('sidebar close fallback failed:', e);
        }
      };

      resetMobileSidebarState();
      window.addEventListener('pageshow', resetMobileSidebarState);
      window.addEventListener('resize', resetMobileSidebarState);

      appSidebar.querySelectorAll('a.sidebar-link, .sidebar-brand a').forEach(link => {
        link.addEventListener('click', _ev => {
          closeSidebarIfMobile();
        });
      });
    }

    initJivoChatLauncher();
  } catch (initErr) {
    console.error('[common.js DOMContentLoaded] INIT ERROR:', initErr);
  }
});

function formatCurrency(amount, currency = 'AUD') {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency }).format(amount || 0);
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePhoneAus(phone) {
  return /^(\+?61|0)[2-478](\s?\d){7,9}$/.test(phone.replace(/\s/g, ''));
}

function validateBSB(bsb) {
  return /^\d{3}-?\d{3}$/.test(bsb);
}

function validateAccNum(num) {
  return /^\d{6,10}$/.test(num);
}

function maskCard(num) {
  const s = String(num).replace(/\D/g, '');
  if (s.length < 4) return s;
  return s.slice(0, 4) + ' ' + '**** '.repeat(Math.max(0, Math.floor((s.length - 8) / 4))) + s.slice(-4);
}

function showModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.add('active');
}

function hideModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.remove('active');
}

document.addEventListener('click', e => {
  if (e.target.classList.contains('modal')) e.target.classList.remove('active');
  const closeBtn = e.target.closest('.modal-close');
  if (closeBtn) { const mod = closeBtn.closest('.modal'); if (mod) mod.classList.remove('active'); }
});

function confirmAction(msg, onConfirm) {
  if (confirm(msg)) {
    try { onConfirm(); } catch (e) { console.error('confirmAction callback failed:', e); }
  }
}

async function apiRequest(url, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('application/json')) return await r.json();
  return await r.text();
}
