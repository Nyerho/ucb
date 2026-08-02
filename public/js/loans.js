document.addEventListener('DOMContentLoaded', () => {
  const applyForm = document.getElementById('loanApplyForm');
  if (applyForm) setupLoanApply(applyForm);
  setupPaymentForms();
});

function setupLoanApply(form) {
  const amount = form.querySelector('[name=loan_amount]');
  const rate = form.querySelector('[name=interest_rate]');
  const term = form.querySelector('[name=loan_term_months]');
  const type = form.querySelector('[name=loan_type]');

  const types = JSON.parse(form.dataset.types || '{}');

  const populateFromType = () => {
    const t = types[type.value];
    if (!t) return;
    if (!amount.value || parseFloat(amount.value) < t.min || parseFloat(amount.value) > t.max) {
      amount.value = Math.min(t.max, Math.max(t.min, 10000));
    }
    if (!rate.value || parseFloat(rate.value) < t.rate_min || parseFloat(rate.value) > t.rate_max) {
      rate.value = ((t.rate_min + t.rate_max) / 2).toFixed(2);
    }
    amount.min = t.min;
    amount.max = t.max;
    term.min = t.term_min;
    term.max = t.term_max;
    if (!term.value || parseInt(term.value) < t.term_min || parseInt(term.value) > t.term_max) {
      term.value = Math.min(t.term_max, Math.max(t.term_min, 36));
    }
    recalc();
  };

  type && type.addEventListener('change', populateFromType);

  const recalc = async () => {
    const emiResult = document.getElementById('emiResult');
    if (!emiResult) return;
    const p = parseFloat(amount.value);
    const r = parseFloat(rate.value);
    const n = parseInt(term.value);
    if (!p || !r || !n) return;
    try {
      const data = await apiRequest('/api/loans/calculate', 'POST', { principal: p, rate: r, term: n });
      emiResult.innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-top:12px;">
          <div style="padding:12px;background:var(--bg-gray);border-radius:var(--radius-sm);text-align:center;">
            <div style="font-size:0.75rem;color:var(--text-light);text-transform:uppercase;">Monthly Repayment</div>
            <div style="font-size:1.2rem;font-weight:800;color:var(--primary);">$${parseFloat(data.emi).toLocaleString('en-AU', { minimumFractionDigits: 2 })}</div>
          </div>
          <div style="padding:12px;background:var(--bg-gray);border-radius:var(--radius-sm);text-align:center;">
            <div style="font-size:0.75rem;color:var(--text-light);text-transform:uppercase;">Total Interest</div>
            <div style="font-size:1.2rem;font-weight:800;color:var(--warning);">$${parseFloat(data.interest).toLocaleString('en-AU', { minimumFractionDigits: 2 })}</div>
          </div>
          <div style="padding:12px;background:var(--bg-gray);border-radius:var(--radius-sm);text-align:center;">
            <div style="font-size:0.75rem;color:var(--text-light);text-transform:uppercase;">Total Repayable</div>
            <div style="font-size:1.2rem;font-weight:800;color:var(--text-dark);">$${parseFloat(data.total).toLocaleString('en-AU', { minimumFractionDigits: 2 })}</div>
          </div>
        </div>
      `;
    } catch (e) {}
  };

  [amount, rate, term].forEach(el => el && el.addEventListener('input', recalc));

  populateFromType();

  form.addEventListener('submit', e => {
    if (!form.querySelector('[name=loan_type]').value) { e.preventDefault(); alert('Select loan type.'); return; }
    if (parseFloat(amount.value) <= 0) { e.preventDefault(); alert('Enter valid loan amount.'); return; }
  });
}

function setupPaymentForms() {
  const loanPaymentForm = document.getElementById('loanPaymentForm');
  if (loanPaymentForm) {
    loanPaymentForm.addEventListener('submit', e => {
      const amt = parseFloat(loanPaymentForm.querySelector('[name=amount]').value);
      if (amt <= 0) { e.preventDefault(); alert('Enter valid payment amount.'); return; }
      if (!confirm(`Confirm loan payment of $${amt.toLocaleString('en-AU')}?`)) e.preventDefault();
    });
  }
}
