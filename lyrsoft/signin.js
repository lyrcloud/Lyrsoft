// The Lyrsoft Work sign-in screen: "Continue with Google" (Cognito Hosted UI) or an email and
// password. New email accounts confirm their address with a 6-digit code that Cognito emails; the
// same code flow resets a forgotten password. Calls onSignedIn() once tokens are stored.
import { CLIENT_ID, passwordSignIn, redirectToLogin } from './auth.js';
import { confirmForgotPassword, confirmSignUp, CognitoError, forgotPassword, resendCode, signUp } from './cognito.js';

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

const PASSWORD_HINT = 'At least 8 characters, with upper and lower case letters, a number and a symbol.';

export function showSignIn(root, onSignedIn) {
  const state = { mode: 'signin', email: '', name: '', error: '', notice: '', busy: false };

  const field = (name, label, type = 'text', extra = '') =>
    `<label class="auth-field">${label}<input name="${name}" type="${type}" ${extra} /></label>`;

  const forms = {
    signin: () => `
      <h2>Sign in with email</h2>
      ${field('email', 'Email', 'email', `required autocomplete="email" value="${esc(state.email)}"`)}
      ${field('password', 'Password', 'password', 'required autocomplete="current-password"')}
      <button class="btn primary big" type="submit">Sign in</button>
      <p class="auth-links"><button type="button" class="link" data-mode="forgot">Forgot password?</button> · <button type="button" class="link" data-mode="signup">Create an account</button></p>`,
    signup: () => `
      <h2>Create your account</h2>
      ${field('name', 'Your name', 'text', `required maxlength="120" autocomplete="name" value="${esc(state.name)}"`)}
      ${field('email', 'Email', 'email', `required autocomplete="email" value="${esc(state.email)}"`)}
      ${field('password', 'Password', 'password', 'required minlength="8" autocomplete="new-password"')}
      <p class="muted small">${PASSWORD_HINT}</p>
      <button class="btn primary big" type="submit">Create account</button>
      <p class="auth-links">Have an account? <button type="button" class="link" data-mode="signin">Sign in</button></p>`,
    confirm: () => `
      <h2>Verify your email</h2>
      <p class="muted">We’ve emailed a 6-digit code to <b>${esc(state.email)}</b>. Enter it to confirm your address.</p>
      ${field('code', 'Verification code', 'text', 'required inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" class="code-input"')}
      ${field('password', 'Password', 'password', 'required autocomplete="current-password"')}
      <button class="btn primary big" type="submit">Verify and sign in</button>
      <p class="auth-links"><button type="button" class="link" data-action="resend">Send a new code</button> · <button type="button" class="link" data-mode="signin">Back</button></p>`,
    forgot: () => `
      <h2>Reset your password</h2>
      <p class="muted">We’ll email you a code to set a new password.</p>
      ${field('email', 'Email', 'email', `required autocomplete="email" value="${esc(state.email)}"`)}
      <button class="btn primary big" type="submit">Send code</button>
      <p class="auth-links"><button type="button" class="link" data-mode="signin">Back to sign in</button></p>`,
    reset: () => `
      <h2>Set a new password</h2>
      <p class="muted">Enter the code we emailed to <b>${esc(state.email)}</b>.</p>
      ${field('code', 'Code', 'text', 'required inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" class="code-input"')}
      ${field('password', 'New password', 'password', 'required minlength="8" autocomplete="new-password"')}
      <p class="muted small">${PASSWORD_HINT}</p>
      <button class="btn primary big" type="submit">Save and sign in</button>
      <p class="auth-links"><button type="button" class="link" data-mode="signin">Back to sign in</button></p>`,
  };

  function render() {
    root.innerHTML = `
      <div class="welcome auth">
        <img class="brand-mark big" src="/brand/lyrsoft-mark.svg" alt="" />
        <h1>Lyrsoft <b>Work</b></h1>
        <p>Plan, track and deliver work with your team and your clients: boards, owners, due dates and updates in one place.</p>
        <div class="auth-card">
          <button class="btn google big" type="button" data-action="google">
            <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
            Continue with Google
          </button>
          <div class="auth-or"><span>or</span></div>
          <form class="auth-form" novalidate>
            ${state.notice ? `<p class="auth-notice" role="status">${esc(state.notice)}</p>` : ''}
            ${state.error ? `<p class="auth-error" role="alert">${esc(state.error)}</p>` : ''}
            ${forms[state.mode]()}
          </form>
        </div>
        <p class="muted small">A <a href="https://www.lyrcloud.com">Lyrcloud</a> product. One account works across Lyrcloud and Lyrsoft.</p>
      </div>`;
    root.querySelector('.auth-form input')?.focus();
  }

  const setMode = (mode, notice = '') => {
    Object.assign(state, { mode, error: '', notice });
    render();
  };

  async function finishSignIn(password) {
    await passwordSignIn(state.email, password);
    onSignedIn();
  }

  const submit = {
    async signin(data) {
      state.email = data.email;
      try {
        await finishSignIn(data.password);
      } catch (error) {
        // Accounts that never confirmed their email get a fresh code and the confirm step.
        if (error instanceof CognitoError && error.type === 'UserNotConfirmedException') {
          await resendCode(CLIENT_ID, state.email).catch(() => {});
          return setMode('confirm', 'Confirm your email first. We’ve sent you a new code.');
        }
        throw error;
      }
    },
    async signup(data) {
      Object.assign(state, { email: data.email, name: data.name.trim() });
      if (!state.name) throw new Error('Enter your name.');
      await signUp(CLIENT_ID, { email: data.email, password: data.password, name: state.name });
      setMode('confirm');
      root.querySelector('input[name="password"]').value = data.password;
    },
    async confirm(data) {
      await confirmSignUp(CLIENT_ID, state.email, data.code).catch((error) => {
        if (!(error instanceof CognitoError && /already confirmed/i.test(error.message))) throw error;
      });
      await finishSignIn(data.password);
    },
    async forgot(data) {
      state.email = data.email;
      await forgotPassword(CLIENT_ID, data.email);
      setMode('reset');
    },
    async reset(data) {
      await confirmForgotPassword(CLIENT_ID, state.email, data.code, data.password);
      await finishSignIn(data.password);
    },
  };

  root.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-mode], [data-action]');
    if (!target) return;
    if (target.dataset.mode) return setMode(target.dataset.mode);
    // The Lyr Chat phone app signs in with Google in the phone's browser (Google refuses app web views).
    if (target.dataset.action === 'google') return window.lyrNativeSignIn ? window.lyrNativeSignIn() : redirectToLogin(location.pathname + location.hash, 'google');
    if (target.dataset.action === 'resend') {
      try {
        await resendCode(CLIENT_ID, state.email);
        setMode('confirm', 'We’ve sent a new code.');
      } catch (error) {
        state.error = error.message;
        render();
      }
    }
  });

  root.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.busy) return;
    const form = event.target;
    if (!form.reportValidity()) return;
    const data = Object.fromEntries(new FormData(form));
    const button = form.querySelector('[type="submit"]');
    state.busy = true;
    state.error = '';
    button.disabled = true;
    try {
      await submit[state.mode](data);
    } catch (error) {
      state.error = error.message || 'Something went wrong. Please try again.';
      state.notice = '';
      render();
      // Keep what was typed (except passwords) after an error.
      for (const [key, value] of Object.entries(data)) {
        const input = root.querySelector(`input[name="${key}"]`);
        if (input && input.type !== 'password') input.value = value;
      }
    } finally {
      state.busy = false;
      const current = root.querySelector('.auth-form [type="submit"]');
      if (current) current.disabled = false;
    }
  });

  render();
}
