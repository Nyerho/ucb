document.addEventListener('DOMContentLoaded', () => {
  const applyForm = document.getElementById('cardApplyForm');
  if (applyForm) setupCardApply(applyForm);
  setupCardActions();
  setupPinForm();
});

function setupCardApply(form) {
  const types = form.querySelectorAll('[name=card_type]');
  const selectedInfo = document.getElementById('selectedCardInfo');
  const cards = JSON.parse(form.dataset.types || '{}');

  types.forEach(r => {
    r.addEventListener('change', () => {
      const ct = cards[r.value];
      if (ct && selectedInfo) {
        selectedInfo.innerHTML = `
          <div style="padding:16px;background:var(--primary-alpha);border-radius:var(--radius);border:1px solid rgba(200,16,46,0.2);">
            <div style="font-weight:700;margin-bottom:4px;">${ct.name} ${ct.image}</div>
            <div style="font-size:0.85rem;color:var(--text-gray);margin-bottom:8px;">${ct.features?.slice(0,3).join(' • ') || ''}</div>
            <div style="display:flex;gap:16px;font-size:0.85rem;">
              <div>Annual Fee: <strong>$${ct.annual_fee || 0}</strong></div>
              ${ct.credit_limit ? `<div>Credit Limit: <strong>$${(ct.credit_limit || 0).toLocaleString()}</strong></div>` : `<div>Daily Limit: <strong>$${(ct.daily_limit || 0).toLocaleString()}</strong></div>`}
            </div>
          </div>
        `;
      }
    });
  });

  form.addEventListener('submit', e => {
    const checked = form.querySelector('[name=card_type]:checked');
    if (!checked) { e.preventDefault(); alert('Please select a card type.'); return; }
    const accId = form.querySelector('[name=account_id]').value;
    if (!accId) { e.preventDefault(); alert('Please select an account to link.'); return; }
  });
}

function setupCardActions() {
  document.querySelectorAll('[data-activate-card]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!confirm('Activate this card now? You will need to set a PIN at an ATM or online after activation.')) return;
      fetch(`/cards/${btn.dataset.activateCard}/activate`, { method: 'POST' })
        .then(() => location.reload());
    });
  });

  document.querySelectorAll('[data-freeze-card]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!confirm('Toggle freeze status for this card?')) return;
      fetch(`/cards/${btn.dataset.freezeCard}/freeze`, { method: 'POST' })
        .then(() => location.reload());
    });
  });

  document.querySelectorAll('[data-lost-card]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!confirm('REPORT this card as LOST/STOLEN?\nThis will immediately block all transactions and issue a replacement.')) return;
      fetch(`/cards/${btn.dataset.lostCard}/report-lost`, { method: 'POST' })
        .then(() => location.reload());
    });
  });

  document.querySelectorAll('[data-replace-card]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!confirm('Request a replacement card?\nA new card will be mailed to your address.')) return;
      fetch(`/cards/${btn.dataset.replaceCard}/replace`, { method: 'POST' })
        .then(() => location.reload());
    });
  });
}

function setupPinForm() {
  const pinForm = document.getElementById('setPinForm');
  if (pinForm) {
    pinForm.addEventListener('submit', e => {
      const pin = pinForm.querySelector('[name=pin]').value;
      if (!/^\d{4}$/.test(pin)) {
        e.preventDefault();
        alert('PIN must be exactly 4 digits (numbers only).');
      }
    });
  }
}
