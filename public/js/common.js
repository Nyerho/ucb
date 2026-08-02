document.addEventListener('DOMContentLoaded', () => {
  const errorToast = document.getElementById('toast-error');
  const successToast = document.getElementById('toast-success');

  [errorToast, successToast].forEach(t => {
    if (t) {
      setTimeout(() => {
        t.style.transition = 'all 0.4s ease';
        t.style.opacity = '0';
        t.style.transform = 'translateX(100px)';
        setTimeout(() => t.remove(), 400);
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
      .then(r => r.json())
      .then(data => {
        const dot = document.getElementById('notifDot');
        if (dot && data.unread > 0) dot.style.display = 'block';
      })
      .catch(() => {});
  }

  const appSidebar = document.getElementById('appSidebar');
  if (appSidebar && window.bootstrap?.Offcanvas) {
    const sidebarInstance = bootstrap.Offcanvas.getOrCreateInstance(appSidebar);
    const closeSidebarIfMobile = () => {
      if (window.innerWidth < 992 && appSidebar.classList.contains('show')) {
        sidebarInstance.hide();
      }
    };

    appSidebar.querySelectorAll('.sidebar-link, .sidebar-brand a').forEach(link => {
      link.addEventListener('click', () => {
        closeSidebarIfMobile();
      });
    });
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
  return s.slice(0, 4) + ' ' + '•••• '.repeat(Math.max(0, Math.floor((s.length - 8) / 4))) + s.slice(-4);
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
  if (e.target.classList.contains('modal-close')) e.target.closest('.modal')?.classList.remove('active');
});

function confirmAction(msg, onConfirm) {
  if (confirm(msg)) {
    onConfirm();
  }
}

async function apiRequest(url, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  return await r.json();
}
