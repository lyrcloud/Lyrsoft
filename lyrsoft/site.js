// The lyrsoft.com company website: mobile menu, Google sign-in and the contact form (POST /public/contact
// on the work API, which files the enquiry on the Website leads board and in the hello@lyrsoft.com inbox).
import { isLoggedIn, redirectToLogin } from './auth.js';
import { WORK_API_BASE } from './config.js';

// Lyrsoft Work used to live at the root; send old links like /#/w/... to the app.
if (location.hash.startsWith('#/')) location.replace(`/app/${location.hash}`);

document.getElementById('year').textContent = new Date().getFullYear();

const toggle = document.querySelector('.nav-toggle');
const links = document.querySelector('.nav-links');
toggle.addEventListener('click', () => {
  const open = links.classList.toggle('open');
  toggle.setAttribute('aria-expanded', String(open));
});
links.addEventListener('click', (event) => {
  if (event.target.tagName === 'A') links.classList.remove('open');
});

// "Sign in" goes straight to Google (the app's own welcome page is skipped); already signed in, it opens the app.
document.querySelectorAll('[data-sign-in]').forEach((link) =>
  link.addEventListener('click', (event) => {
    if (isLoggedIn() || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    redirectToLogin('/app/', 'google');
  }),
);

const form = document.getElementById('contact-form');
const status = form.querySelector('.form-status');
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  const button = form.querySelector('button');
  button.disabled = true;
  status.className = 'form-status';
  status.textContent = 'Sending…';
  try {
    const response = await fetch(`${WORK_API_BASE}/public/contact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || body.message || 'Couldn’t send your message. Please try again.');
    form.reset();
    status.classList.add('ok');
    status.textContent = 'Thanks! Your message reached the Lyrsoft team. We’ll reply within one business day.';
  } catch (error) {
    status.classList.add('err');
    status.textContent = error instanceof TypeError ? 'Can’t reach Lyrsoft. Check your connection and try again.' : error.message;
  } finally {
    button.disabled = false;
  }
});
