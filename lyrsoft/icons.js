// Line icons for Lyr Chat and calls (24×24, drawn with the current text colour), and a press ripple
// for buttons. icon('phone') returns the SVG markup; ripples(root) turns the ripple on once.
const P = {
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-12.3 7.4L3 21l2.1-5.4A8.4 8.4 0 1 1 21 11.5z"/><path d="M8.5 11.5h.01M12.5 11.5h.01M16.5 11.5h.01" stroke-width="2.6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14a6.5 6.5 0 0 1 3.5 6"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>',
  hangup: '<path d="M3.7 14.6 2.3 13.2a1.6 1.6 0 0 1 0-2.3 13.6 13.6 0 0 1 19.4 0 1.6 1.6 0 0 1 0 2.3l-1.4 1.4a1.6 1.6 0 0 1-2 .2l-2.2-1.4a1.6 1.6 0 0 1-.7-1.4v-1.6a11 11 0 0 0-6.8 0V12a1.6 1.6 0 0 1-.7 1.4L5.7 14.8a1.6 1.6 0 0 1-2-.2z"/>',
  video: '<rect x="2" y="6" width="13" height="12" rx="2.5"/><path d="m15 10.5 6-3.5v10l-6-3.5z"/>',
  videoOff: '<path d="M15 13.5 21 17V7l-6 3.5M10.7 6H12.5A2.5 2.5 0 0 1 15 8.5v1.8M15 15.5a2.5 2.5 0 0 1-2.5 2.5h-8A2.5 2.5 0 0 1 2 15.5v-7A2.5 2.5 0 0 1 4 6"/><path d="m2 2 20 20"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8"/>',
  micOff: '<path d="M15 9.3V5a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 5.1 2.1M19 10a7 7 0 0 1-1.2 3.9M5 10a7 7 0 0 0 11.2 5.6M12 17v5M8 22h8"/><path d="m2 2 20 20"/>',
  speaker: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
  speakerLow: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>',
  screen: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4M9 10l3-3 3 3M12 7v6"/>',
  record: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4" fill="currentColor"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="3" fill="currentColor"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  flip: '<path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.8l1.5-2h6.4l1.5 2h1.8A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/><path d="M8.6 12.2a3.4 3.4 0 0 1 5.9-2.3M15.4 13.8a3.4 3.4 0 0 1-5.9 2.3"/><path d="M14.9 8.2v2h-2M9.1 17.8v-2h2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2.5"/><path d="m3 6.5 9 6.5 9-6.5"/>',
  back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
  more: '<circle cx="12" cy="5" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="19" r="1.4" fill="currentColor"/>',
  contacts: '<rect x="4" y="2" width="16" height="20" rx="2.5"/><circle cx="12" cy="10" r="3"/><path d="M7.5 18a4.5 4.5 0 0 1 9 0M2 7h2M2 12h2M2 17h2"/>',
  minimize: '<path d="M5 18h14"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  play: '<path d="M7 4.5v15l12.5-7.5z" fill="currentColor"/>',
};

export const icon = (name, cls = '') =>
  `<svg class="ico${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${P[name] || ''}</svg>`;

// A soft ripple from where the button was pressed (Material-style), for buttons matching `selector`.
let rippling = false;
export function ripples(selector = '.lc-icon, .lc-tab, .call-btn, .tile-flip, .btn, .lc-fab') {
  if (rippling || typeof document === 'undefined') return;
  rippling = true;
  const reduced = matchMedia?.('(prefers-reduced-motion: reduce)');
  document.addEventListener('pointerdown', (event) => {
    if (reduced?.matches || event.button > 0) return;
    const el = event.target.closest?.(selector);
    if (!el || el.disabled) return;
    const box = el.getBoundingClientRect();
    const size = Math.max(box.width, box.height) * 2;
    const dot = document.createElement('span');
    dot.className = 'ripple';
    dot.style.cssText = `width:${size}px;height:${size}px;left:${event.clientX - box.left - size / 2}px;top:${event.clientY - box.top - size / 2}px`;
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    el.style.overflow = 'hidden';
    el.append(dot);
    dot.addEventListener('animationend', () => dot.remove(), { once: true });
    setTimeout(() => dot.remove(), 900);
  }, { passive: true });
}
