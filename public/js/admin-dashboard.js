document.addEventListener('DOMContentLoaded', () => {
  loadStatsNotifications();
  setupUserSearch();
});

function loadStatsNotifications() {
  const dot = document.getElementById('notifDot');
  if (!dot) return;
  fetch('/api/user/notifications')
    .then(response => response.ok ? response.json() : null)
    .then(data => {
      if (data && data.unread > 0) dot.style.display = 'block';
    });
}

function setupUserSearch() {
  const bar = document.getElementById('topbarSearch');
  if (bar && window.location.pathname.startsWith('/admin/users')) {
    bar.placeholder = 'Search users by name, email, phone...';
    let timer;
    bar.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const query = bar.value.trim();
        if (!query) {
          window.location.search = '';
          return;
        }
        window.location.href = `/admin/users?search=${encodeURIComponent(query)}`;
      }, 500);
    });
  }
}

document.addEventListener('click', event => {
  const button = event.target.closest('.toggle-user-accounts');
  if (button) {
    const section = document.getElementById(button.dataset.target);
    if (section) section.style.display = section.style.display === 'none' ? '' : 'none';
  }
});
