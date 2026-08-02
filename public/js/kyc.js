document.addEventListener('DOMContentLoaded', () => {
  const kycForm = document.getElementById('kycForm');
  if (kycForm) {
    kycForm.addEventListener('submit', e => {
      const docType = kycForm.querySelector('[name=document_type]').value;
      const docNum = kycForm.querySelector('[name=document_number]').value;

      if (!docType) { e.preventDefault(); alert('Please select your ID document type.'); return; }
      if (docNum.trim().length < 4) { e.preventDefault(); alert('Please enter a valid document number.'); return; }

      if (!confirm('Submit these details for KYC review?\nYou will be able to use all features once approved within 24 hours.')) {
        e.preventDefault();
      }
    });
  }

  const resubmitBtn = document.getElementById('resubmitKycBtn');
  if (resubmitBtn) {
    resubmitBtn.addEventListener('click', () => window.location.href = '/kyc/submit');
  }
});
