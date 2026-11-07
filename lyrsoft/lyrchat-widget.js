// Lyrbot's Lyr Chat button for sites that don't run their own Lyrbot (Lyrpay, mrshihab.com, …).
// One script tag adds a floating Lyrbot button whose panel opens a Lyr Chat conversation with Lyrsoft
// Support (lyrsoft.com/chat/#/new?to=support&site=<site>), or WhatsApp / email:
//
//   <script src="https://lyrsoft.com/lyrchat-widget.js" data-site="Lyrpay" defer></script>
//
// Optional: data-whatsapp="16615809465" data-email="support@lyrsoft.com" data-color="#6247ea"
// data-greeting="…". Everything renders in a shadow root, so the site's CSS can't affect it (or the reverse).
(() => {
  if (window.__lyrchatWidget) return;
  window.__lyrchatWidget = true;
  const script = document.currentScript;
  const opt = (name, fallback) => script?.dataset?.[name] || fallback;
  const site = opt('site', location.hostname.replace(/^www\./, ''));
  const whatsapp = opt('whatsapp', '16615809465').replace(/\D/g, '');
  const email = opt('email', 'support@lyrsoft.com');
  const color = /^#[0-9a-f]{3,8}$/i.test(opt('color', '')) ? opt('color') : '#6247ea';
  const greeting = opt('greeting', `Hi, I'm Lyrbot 👋 Questions about ${site}? Chat with our team on Lyr Chat: free messages, voice and video calls.`);
  const chatUrl = `https://lyrsoft.com/chat/#/new?to=support&site=${encodeURIComponent(site)}`;
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const robot = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a1.5 1.5 0 0 1 .75 2.8V6H17a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3h4.25V4.8A1.5 1.5 0 0 1 12 2Zm-3 9a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm6 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm-6 5.25a.75.75 0 0 0 0 1.5h6a.75.75 0 0 0 0-1.5Zm-7.5-6.5a1 1 0 0 1 1 1v3.5a1 1 0 1 1-2 0v-3.5a1 1 0 0 1 1-1Zm21 0a1 1 0 0 1 1 1v3.5a1 1 0 1 1-2 0v-3.5a1 1 0 0 1 1-1Z"/></svg>';

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483000';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
      .fab { display: grid; place-items: center; width: 58px; height: 58px; border: 0; border-radius: 50%; background: ${color}; color: #fff; box-shadow: 0 10px 28px rgba(20, 16, 60, .35); cursor: pointer; }
      .fab svg { width: 30px; height: 30px; }
      .panel { position: absolute; right: 0; bottom: 72px; width: min(340px, calc(100vw - 36px)); border-radius: 18px; background: #fff; color: #161a2e; box-shadow: 0 18px 50px rgba(20, 16, 60, .3); overflow: hidden; }
      .panel[hidden] { display: none; }
      header { display: flex; align-items: center; gap: 10px; padding: 14px 16px; background: linear-gradient(135deg, ${color}, #8b5cf6); color: #fff; }
      header .icon { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 50%; background: rgba(255, 255, 255, .2); }
      header .icon svg { width: 22px; height: 22px; }
      header b { display: block; font-size: 16px; }
      header small { opacity: .85; font-size: 12px; }
      header button { margin-left: auto; width: 32px; height: 32px; border: 0; border-radius: 50%; background: rgba(255, 255, 255, .2); color: #fff; font-size: 18px; cursor: pointer; }
      .body { padding: 16px; }
      .bubble { margin: 0 0 14px; padding: 12px 14px; border: 1px solid #e3e5f0; border-radius: 14px; background: #f6f7fb; font-size: 14px; line-height: 1.45; }
      a.btn { display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 8px; padding: 11px 14px; border-radius: 12px; font-size: 14px; font-weight: 700; text-decoration: none; }
      a.primary { background: ${color}; color: #fff; }
      a.wa { background: #e7f7ee; color: #0b8a4a; }
      a.mail { background: #f0f1f8; color: #3b3f58; }
      .foot { padding: 0 16px 12px; color: #8a8fa6; font-size: 11px; text-align: center; }
      @media (prefers-color-scheme: dark) {
        .panel { background: #161925; color: #eceef7; }
        .bubble { border-color: #2a2f43; background: #1d2131; }
        a.mail { background: #1d2131; color: #cfd3e6; }
        a.wa { background: #12301f; color: #4ade80; }
      }
    </style>
    <div class="panel" hidden role="dialog" aria-label="Lyrbot">
      <header><span class="icon">${robot}</span><span><b>Lyrbot</b><small>${esc(site)} · usually replies within hours</small></span><button type="button" aria-label="Close">×</button></header>
      <div class="body">
        <p class="bubble">${esc(greeting)}</p>
        <a class="btn primary" href="${esc(chatUrl)}" target="_blank" rel="noopener">💬 Chat on Lyr Chat</a>
        ${whatsapp ? `<a class="btn wa" href="https://wa.me/${whatsapp}" target="_blank" rel="noopener">🟢 WhatsApp</a>` : ''}
        ${email ? `<a class="btn mail" href="mailto:${esc(email)}">✉ ${esc(email)}</a>` : ''}
      </div>
      <p class="foot">Lyr Chat by Lyrsoft · sign in with Google or email</p>
    </div>
    <button class="fab" type="button" aria-label="Chat with us">${robot}</button>`;
  const panel = root.querySelector('.panel');
  root.querySelector('.fab').addEventListener('click', () => (panel.hidden = !panel.hidden));
  root.querySelector('header button').addEventListener('click', () => (panel.hidden = true));
  const mount = () => document.body.append(host);
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
