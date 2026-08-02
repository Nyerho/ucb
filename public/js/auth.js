document.addEventListener('DOMContentLoaded', () => {
  const loginForm = document.getElementById('loginForm');
  if (loginForm) {
    loginForm.addEventListener('submit', e => {
      const email = loginForm.querySelector('[name=email]').value;
      const password = loginForm.querySelector('[name=password]').value;

      if (!validateEmail(email)) {
        e.preventDefault();
        alert('Please enter a valid email address.');
        return false;
      }
      if (password.length < 6) {
        e.preventDefault();
        alert('Password must be at least 6 characters.');
        return false;
      }
    });
  }

  const regForm = document.getElementById('registerForm');
  if (regForm) {
    const pwd = document.getElementById('regPwd');
    const pwdC = document.getElementById('regPwdConfirm');
    const matchDiv = document.getElementById('pwdMatch');

    const checkMatch = () => {
      if (!pwdC.value) { matchDiv.innerHTML = ''; return; }
      if (pwd.value === pwdC.value) {
        matchDiv.innerHTML = '<span class="form-hint" style="color:var(--success);">✓ Passwords match</span>';
      } else {
        matchDiv.innerHTML = '<span class="form-error">✗ Passwords do not match</span>';
      }
    };

    pwd && pwd.addEventListener('input', checkMatch);
    pwdC && pwdC.addEventListener('input', checkMatch);

    regForm.addEventListener('submit', e => {
      const pwdVal = pwd.value;
      if (pwdVal.length < 8) {
        e.preventDefault();
        alert('Password must be at least 8 characters long.');
        return false;
      }
      if (pwdVal !== pwdC.value) {
        e.preventDefault();
        alert('Passwords do not match.');
        return false;
      }
    });
  }
});
