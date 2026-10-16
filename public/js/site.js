document.getElementById('year').textContent = new Date().getFullYear();

const toggle = document.querySelector('.nav-toggle');
const links = document.querySelector('.nav-links');
toggle.addEventListener('click', () => {
  const open = links.classList.toggle('open');
  toggle.setAttribute('aria-expanded', String(open));
});
links.addEventListener('click', (e) => { if (e.target.tagName === 'A') links.classList.remove('open'); });

const form = document.getElementById('contact-form');
const status = form.querySelector('.form-status');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!form.reportValidity()) return;
  const button = form.querySelector('button');
  button.disabled = true;
  status.className = 'form-status';
  status.textContent = 'Sending…';
  try {
    const res = await fetch('/api/public/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-lyrsoft': '1' },
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Could not send your message');
    form.reset();
    status.classList.add('ok');
    status.textContent = 'Thanks! Your message is in. Check your inbox for a confirmation.';
  } catch (err) {
    status.classList.add('err');
    status.textContent = err.message;
  } finally {
    button.disabled = false;
  }
});
