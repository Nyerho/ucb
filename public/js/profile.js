document.addEventListener('DOMContentLoaded', () => {
  const forms = {
    pwdForm: document.getElementById('changePwdForm'),
    profileForm: document.getElementById('profileForm')
  };

  if (forms.pwdForm) {
    forms.pwdForm.addEventListener('submit', e => {
      const np = forms.pwdForm.querySelector('[name=new_password]').value;
      const cp = forms.pwdForm.querySelector('[name=confirm_password]').value;
      if (np.length < 8) { e.preventDefault(); alert('Password must be at least 8 characters.'); return; }
      if (np !== cp) { e.preventDefault(); alert('Passwords do not match.'); return; }
    });
  }

  if (forms.profileForm) {
    forms.profileForm.addEventListener('submit', e => {
      const email = forms.profileForm.querySelector('[name=email]').value;
      if (!validateEmail(email)) { e.preventDefault(); alert('Invalid email.'); return; }
    });
  }

  document.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        const orig = btn.textContent;
        btn.textContent = 'Copied ✓';
        setTimeout(() => btn.textContent = orig, 1500);
      } catch (e) { alert('Unable to copy'); }
    });
  });
});
