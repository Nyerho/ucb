document.addEventListener('DOMContentLoaded', () => {
  const accountCards = document.querySelectorAll('.account-card');
  accountCards.forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.tagName.toLowerCase() === 'a' || e.target.tagName.toLowerCase() === 'button') return;
      const link = card.querySelector('a.btn-light');
      if (link) link.click();
    });
  });

  loadNotifications();
});

async function loadNotifications() {
  try {
    const dot = document.getElementById('notifDot');
    if (!dot) return;
    const data = await apiRequest('/api/user/notifications');
    if (data.unread > 0) dot.style.display = 'block';
  } catch (e) {}
}

function freezeAccount(id) {
  confirmAction('Are you sure you want to freeze/unfreeze this card?', () => {
    fetch(`/cards/${id}/freeze`, { method: 'POST' })
      .then(r => r.json ? r.json() : {})
      .then(() => location.reload());
  });
}

function cancelTransaction(id) {
  confirmAction('Cancel this transaction? Any held funds will be released.', () => {
    fetch(`/transfers/${id}/cancel`, { method: 'POST' })
      .then(() => location.reload());
  });
}

document.addEventListener('click', e => {
  const notifyBtn = e.target.closest('.mark-notif');
  if (notifyBtn) {
    e.preventDefault();
    const id = notifyBtn.dataset.id;
    fetch(`/api/user/notifications/${id}/read`, { method: 'POST' })
      .then(() => {
        const row = notifyBtn.closest('tr');
        if (row) row.style.opacity = '0.6';
      });
  }
});
