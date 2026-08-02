document.addEventListener('DOMContentLoaded', () => {
  loadStatsNotifications();
  setupApprovalActions();
  setupUserSearch();
  setupFreezeButtons();
});

function loadStatsNotifications() {
  const dot = document.getElementById('notifDot');
  if (!dot) return;
  fetch('/api/user/notifications')
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (data && data.unread > 0) dot.style.display = 'block';
    });
}

function setupApprovalActions() {
  document.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      const form = btn.closest('form');
      const action = btn.dataset.action;
      const isReject = action.includes('reject') || action.includes('Reject');

      const doIt = () => form.submit();

      if (isReject) {
        const reason = prompt(`Please enter rejection reason:`);
        if (reason === null) return;
        const reasonField = document.createElement('input');
        reasonField.type = 'hidden';
        reasonField.name = 'reason';
        reasonField.value = reason || 'No reason provided';
        form.appendChild(reasonField);
        doIt();
      } else {
        confirmAction('Confirm this approval?', doIt);
      }
    });
  });
}

function setupUserSearch() {
  const bar = document.getElementById('topbarSearch');
  if (bar && window.location.pathname.startsWith('/admin/users')) {
    bar.placeholder = 'Search users by name, email, phone...';
    let t;
    bar.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const q = bar.value.trim();
        if (!q) {
          window.location.search = '';
          return;
        }
        window.location.href = `/admin/users?search=${encodeURIComponent(q)}`;
      }, 500);
    });
  }
}

function setupFreezeButtons() {
  document.querySelectorAll('[data-freeze-user]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.freezeUser;
      if (!confirm('Toggle freeze status for this user?')) return;
      try {
        const r = await fetch(`/admin/users/${id}/freeze`, { method: 'POST' });
        const data = await r.json();
        if (data.success) location.reload();
      } catch (e) { alert('Error toggling freeze'); }
    });
  });
}

function deleteUser(id, name) {
  if (!confirm(`DELETE user "${name}"?\nThis action cannot be undone and will remove ALL their data.`)) return;
  const f = document.createElement('form');
  f.method = 'POST';
  f.action = `/admin/users/${id}/delete`;
  document.body.appendChild(f);
  f.submit();
}

function resetUserPwd(id, name) {
  const pwd = prompt(`Enter NEW password for ${name}:`, 'TempPass2026!');
  if (!pwd || pwd.length < 8) { alert('Password must be at least 8 chars'); return; }
  const f = document.createElement('form');
  f.method = 'POST';
  f.action = `/admin/users/${id}/reset-password`;
  const p = document.createElement('input');
  p.type = 'hidden';
  p.name = 'password';
  p.value = pwd;
  f.appendChild(p);
  document.body.appendChild(f);
  f.submit();
}

document.addEventListener('click', e => {
  const btn = e.target.closest('.toggle-user-accounts');
  if (btn) {
    const sec = document.getElementById(btn.dataset.target);
    if (sec) sec.style.display = sec.style.display === 'none' ? '' : 'none';
  }
});
