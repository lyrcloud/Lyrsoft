import { exchangeCodeForTokens, takeReturnPath } from './auth.js';

const statusEl = document.getElementById('callback-status');
const homeLink = document.getElementById('callback-home-link');
const params = new URLSearchParams(location.search);
const error = params.get('error');
const code = params.get('code');

const fail = (message) => {
  statusEl.textContent = message;
  homeLink.hidden = false;
};

if (error) {
  fail(`Sign-in was cancelled (${error}).`);
} else if (!code) {
  fail('Missing sign-in code.');
} else {
  exchangeCodeForTokens(code)
    .then(() => location.replace(takeReturnPath('/app/')))
    .catch((err) => {
      console.error(err);
      fail('Sign-in failed. Please try again.');
    });
}
