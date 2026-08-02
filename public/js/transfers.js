document.addEventListener('DOMContentLoaded', () => {
  const localForm = document.getElementById('localTransferForm');
  if (localForm) setupLocalTransfer(localForm);

  const intForm = document.getElementById('intlTransferForm');
  if (intForm) setupIntlTransfer(intForm);

  setupBeneficiarySelect();
  setupHistoryFilters();
});

function setupLocalTransfer(form) {
  const amount = form.querySelector('[name=amount]');
  const account = form.querySelector('[name=from_account]');
  const feeDisplay = document.getElementById('feeDisplay');
  const totalDisplay = document.getElementById('totalDisplay');

  const updateTotals = () => {
    if (!amount || !feeDisplay) return;
    const amt = parseFloat(amount.value) || 0;
    const fee = amt > 10000 ? 15 : 0;
    if (feeDisplay) feeDisplay.textContent = formatCurrency(fee);
    if (totalDisplay) totalDisplay.textContent = formatCurrency(amt + fee);
    if (amt >= 5000) {
      document.getElementById('approvalNotice')?.classList.remove('d-none');
    } else {
      document.getElementById('approvalNotice')?.classList.add('d-none');
    }
  };

  amount && amount.addEventListener('input', updateTotals);
  updateTotals();

  form.addEventListener('submit', e => {
    const amt = parseFloat(amount.value);
    if (amt <= 0) { e.preventDefault(); alert('Please enter a valid amount.'); return; }
    const destAccount = form.querySelector('[name=to_account]').value;
    if (!validateAccNum(destAccount)) {
      e.preventDefault();
      alert('Please enter a valid destination account number (6-10 digits).');
    }
  });
}

function setupIntlTransfer(form) {
  const amountAud = form.querySelector('[name=amount_aud]');
  const amountForeign = form.querySelector('[name=amount_foreign]');
  const rate = form.querySelector('[name=exchange_rate]');
  const feeDisplay = document.getElementById('feeDisplay');
  const totalDisplay = document.getElementById('totalDisplay');
  const currency = form.querySelector('[name=currency]');

  const AUD_TO_FOREIGN = {
    AUD: 1, USD: 0.66, GBP: 0.52, EUR: 0.60, NZD: 1.10, JPY: 99.50,
    SGD: 0.88, HKD: 5.15, CAD: 0.89, INR: 54.80, CNY: 4.75
  };

  const updateFromAud = () => {
    const aud = parseFloat(amountAud.value) || 0;
    const r = AUD_TO_FOREIGN[currency.value] || 1;
    rate.value = r;
    amountForeign.value = (aud * r).toFixed(2);
    updateTotals();
  };

  const updateFromForeign = () => {
    const foreign = parseFloat(amountForeign.value) || 0;
    const r = AUD_TO_FOREIGN[currency.value] || 1;
    rate.value = r;
    amountAud.value = (foreign / r).toFixed(2);
    updateTotals();
  };

  const updateTotals = () => {
    const aud = parseFloat(amountAud.value) || 0;
    if (feeDisplay) feeDisplay.textContent = formatCurrency(25);
    if (totalDisplay) totalDisplay.textContent = formatCurrency(aud + 25);
  };

  amountAud && amountAud.addEventListener('input', updateFromAud);
  amountForeign && amountForeign.addEventListener('input', updateFromForeign);
  currency && currency.addEventListener('change', updateFromAud);
  updateFromAud();

  form.addEventListener('submit', e => {
    const aud = parseFloat(amountAud.value);
    if (aud < 100) { e.preventDefault(); alert('Minimum international transfer is $100 AUD.'); return; }
    const country = form.querySelector('[name=country]').value;
    if (!country) { e.preventDefault(); alert('Please select destination country.'); return; }
    const swift = form.querySelector('[name=swift_code]').value;
    const iban = form.querySelector('[name=iban]').value;
    if (!swift && !iban) {
      e.preventDefault();
      alert('Please provide SWIFT code or IBAN for international transfer.');
    }
  });
}

function setupBeneficiarySelect() {
  const btn = document.getElementById('useBeneficiaryBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const sel = document.getElementById('beneficiarySelect');
    if (!sel || !sel.value) { alert('Please select a beneficiary first.'); return; }
    fetch(`/api/search/beneficiaries?q=${sel.value}`)
      .then(r => r.json())
      .then(data => {
        if (data.results.length > 0) {
          const b = data.results.find(x => String(x.id) === sel.value) || data.results[0];
          document.querySelector('[name=to_name]').value = b.name;
          document.querySelector('[name=to_account]').value = b.account_number;
          if (b.bsb) document.querySelector('[name=to_bsb]').value = b.bsb;
          if (b.swift_code) document.querySelector('[name=swift_code]').value = b.swift_code;
          if (b.iban) document.querySelector('[name=iban]').value = b.iban;
          if (b.country) document.querySelector('[name=country]').value = b.country;
        }
      });
  });
}

function setupHistoryFilters() {
  const filterForm = document.getElementById('txnFilterForm');
  if (filterForm) return;
}
