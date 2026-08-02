document.addEventListener('DOMContentLoaded', () => {
  const payForm = document.getElementById('billPayForm');
  if (payForm) setupBillPay(payForm);
  const depositForm = document.getElementById('depositForm');
  if (depositForm) setupDeposit(depositForm);
  const withdrawForm = document.getElementById('withdrawForm');
  if (withdrawForm) setupWithdraw(withdrawForm);
  setupBillerSelect();
});

function setupBillPay(form) {
  const biller = form.querySelector('[name=biller_code]');
  const billerName = form.querySelector('[name=biller_name]');
  const amount = form.querySelector('[name=amount]');
  const reference = form.querySelector('[name=reference_number]');

  const BILLERS = JSON.parse(form.dataset.billers || '[]');

  biller && biller.addEventListener('change', () => {
    const b = BILLERS.find(x => x.code === biller.value);
    if (b) {
      billerName.value = b.name;
    }
  });

  form.addEventListener('submit', e => {
    if (!billerName.value.trim()) { e.preventDefault(); alert('Select or enter a biller name.'); return; }
    if (!reference.value.trim()) { e.preventDefault(); alert('Enter biller reference number.'); return; }
    const amt = parseFloat(amount.value);
    if (amt <= 0) { e.preventDefault(); alert('Enter valid amount.'); return; }
    if (amt >= 3000) {
      if (!confirm(`Amount over $3,000 will require admin approval. Continue?`)) e.preventDefault();
    }
  });
}

function setupDeposit(form) {
  const amount = form.querySelector('[name=amount]');
  form.addEventListener('submit', e => {
    const amt = parseFloat(amount.value);
    if (amt <= 0) { e.preventDefault(); alert('Enter valid deposit amount.'); return; }
    if (amt >= 10000) {
      if (!confirm(`Deposits over $10,000 will be reviewed by our team. Continue?`)) e.preventDefault();
    }
  });
}

function setupWithdraw(form) {
  const amount = form.querySelector('[name=amount]');
  const maxAmt = parseFloat(form.dataset.maxBalance || 0);
  form.addEventListener('submit', e => {
    const amt = parseFloat(amount.value);
    if (amt <= 0) { e.preventDefault(); alert('Enter valid amount.'); return; }
    if (amt > maxAmt) { e.preventDefault(); alert(`Insufficient balance. Max available: $${maxAmt.toLocaleString('en-AU', { minimumFractionDigits: 2 })}`); return; }
    if (amt >= 5000) {
      if (!confirm(`Withdrawals over $5,000 require admin approval. Continue?`)) e.preventDefault();
    }
  });
}

function setupBillerSelect() {
  const btns = document.querySelectorAll('[data-biller-code]');
  btns.forEach(b => {
    b.addEventListener('click', () => {
      window.location.href = `/billpay/pay?biller=${b.dataset.billerCode}`;
    });
  });
}
