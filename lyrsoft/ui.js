// Lyrsoft Work polish that isn't tied to one page: a command palette (Ctrl/⌘ K) to jump anywhere,
// keyboard shortcuts, the light / dark / system theme switch, page-enter animations, numbers that
// count up on stat tiles, and a ripple on buttons. app.js calls afterRender() after every render.

const THEME_KEY = 'lyrsoft.theme';
const THEMES = ['system', 'light', 'dark'];
const THEME_ICONS = { system: '🖥', light: '☀', dark: '🌙' };
const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function storedTheme() {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return THEMES.includes(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(theme = storedTheme()) {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}
applyTheme();

export const themeButton = () => {
  const theme = storedTheme();
  return `<button class="icon-btn theme-btn" data-click="ui-theme" title="Theme: ${theme} (click to change)" aria-label="Theme: ${theme}">${THEME_ICONS[theme]}</button>`;
};

export const searchButton = () =>
  `<button class="palette-btn" data-click="ui-palette" aria-label="Search and jump (Ctrl K)"><span aria-hidden="true">🔎</span><span class="palette-btn-text">Jump to…</span><kbd>${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'} K</kbd></button>`;

// targets(): [{ group, label, hint?, icon, href? , run? }]
export function createUI({ go, targets, toast, rerender }) {
  let lastKey = null;
  let palette = null;
  let pendingG = 0;

  // ---------------------------------------------------------------- palette

  function openPalette() {
    if (palette) return;
    const all = targets();
    const node = document.createElement('div');
    node.className = 'palette-backdrop';
    node.innerHTML = `
      <div class="palette" role="dialog" aria-modal="true" aria-label="Jump to">
        <input class="palette-input" placeholder="Jump to a workspace, board, mailbox or page…" aria-label="Search" autocomplete="off" />
        <ul class="palette-list" role="listbox"></ul>
        <p class="palette-foot"><kbd>↑</kbd><kbd>↓</kbd> move · <kbd>Enter</kbd> open · <kbd>Esc</kbd> close · <kbd>?</kbd> shortcuts</p>
      </div>`;
    document.body.append(node);
    palette = node;
    const input = node.querySelector('input');
    const list = node.querySelector('ul');
    let shown = [];
    let active = 0;
    const score = (t, q) => {
      if (!q) return 1;
      const hay = `${t.label} ${t.hint || ''} ${t.group}`.toLowerCase();
      if (t.label.toLowerCase().startsWith(q)) return 3;
      if (hay.includes(q)) return 2;
      // Letters in order ("mkt" finds "Marketing").
      let i = 0;
      for (const ch of hay) if (ch === q[i]) i += 1;
      return i === q.length ? 1 : 0;
    };
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      shown = all.map((t) => [t, score(t, q)]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([t]) => t).slice(0, 40);
      active = Math.min(active, Math.max(0, shown.length - 1));
      let group = '';
      list.innerHTML = shown.length
        ? shown.map((t, i) => {
            const head = t.group !== group ? `<li class="palette-group" role="presentation">${esc(t.group)}</li>` : '';
            group = t.group;
            return `${head}<li class="palette-item${i === active ? ' active' : ''}" role="option" aria-selected="${i === active}" data-i="${i}"><span class="palette-icon" aria-hidden="true">${t.icon || '•'}</span><span class="palette-label">${esc(t.label)}</span>${t.hint ? `<small>${esc(t.hint)}</small>` : ''}</li>`;
          }).join('')
        : '<li class="palette-empty">Nothing matches.</li>';
      list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
    };
    const choose = (t) => {
      closePalette();
      if (!t) return;
      if (t.run) t.run();
      else if (t.href) go(t.href);
    };
    input.addEventListener('input', () => {
      active = 0;
      draw();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        active = (active + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % Math.max(1, shown.length);
        draw();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        choose(shown[active]);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closePalette();
      }
    });
    list.addEventListener('mousemove', (event) => {
      const item = event.target.closest('[data-i]');
      if (item && Number(item.dataset.i) !== active) {
        active = Number(item.dataset.i);
        list.querySelectorAll('.palette-item').forEach((li) => li.classList.toggle('active', Number(li.dataset.i) === active));
      }
    });
    list.addEventListener('click', (event) => {
      const item = event.target.closest('[data-i]');
      if (item) choose(shown[Number(item.dataset.i)]);
    });
    node.addEventListener('mousedown', (event) => {
      if (event.target === node) closePalette();
    });
    draw();
    requestAnimationFrame(() => input.focus());
  }

  function closePalette() {
    palette?.remove();
    palette = null;
  }

  function shortcutsHelp() {
    const rows = [
      ['Ctrl/⌘ K', 'Jump to anything'],
      ['/', 'Search on this page'],
      ['g then h', 'Home (workspaces)'],
      ['g then m', 'Mail'],
      ['g then k', 'Marketing'],
      ['g then c', 'Contacts'],
      ['g then t', 'Messages (chat)'],
      ['g then p', 'My profile'],
      ['Shift T', 'Switch theme'],
      ['Esc', 'Close menus and panels'],
    ];
    const node = document.createElement('dialog');
    node.className = 'dialog shortcuts-dialog';
    node.innerHTML = `<form method="dialog"><h2>Keyboard shortcuts</h2><table class="shortcuts">${rows.map(([k, v]) => `<tr><td>${k.split(' ').map((p) => (p === 'then' ? '<span class="muted">then</span>' : `<kbd>${esc(p)}</kbd>`)).join(' ')}</td><td>${esc(v)}</td></tr>`).join('')}</table><div class="row end"><button class="btn primary">Got it</button></div></form>`;
    document.body.append(node);
    node.addEventListener('close', () => node.remove());
    node.showModal();
  }

  function cycleTheme() {
    const next = THEMES[(THEMES.indexOf(storedTheme()) + 1) % THEMES.length];
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* private mode: still switch for this visit */
    }
    applyTheme(next);
    toast(`Theme: ${next === 'system' ? 'match my device' : next}`);
    rerender();
  }

  const typing = (target) => target.closest?.('input, textarea, select, [contenteditable="true"]');

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (palette) closePalette();
      else openPalette();
      return;
    }
    if (palette || event.ctrlKey || event.metaKey || event.altKey || typing(event.target) || document.querySelector('dialog[open]')) return;
    if (event.key === '/') {
      const search = document.querySelector('main input[type="search"], main .search');
      if (search) {
        event.preventDefault();
        search.focus();
        search.select?.();
      }
    } else if (event.key === '?') {
      shortcutsHelp();
    } else if (event.key === 'T' && event.shiftKey) {
      cycleTheme();
    } else if (event.key === 'g') {
      pendingG = Date.now();
    } else if (Date.now() - pendingG < 1200) {
      pendingG = 0;
      const jump = { h: '#/', m: '#/mail', k: 'marketing', c: '#/contacts', t: '#/chat', p: '#/profile' }[event.key];
      if (jump === 'marketing') {
        const t = targets().find((x) => x.marketing);
        if (t) go(t.href);
      } else if (jump) go(jump);
    }
  });

  // ---------------------------------------------------------------- after each render

  function countUp(root) {
    if (reduceMotion()) return;
    for (const node of root.querySelectorAll('.stat b')) {
      const text = node.textContent.trim();
      const match = text.match(/^([\d,]+(?:\.\d+)?)(%?)$/);
      if (!match) continue;
      const target = Number(match[1].replace(/,/g, ''));
      if (!target) continue;
      const decimals = (match[1].split('.')[1] || '').length;
      const start = performance.now();
      const duration = 700;
      const step = (now) => {
        const p = Math.min(1, (now - start) / duration);
        const eased = 1 - (1 - p) ** 3;
        const value = target * eased;
        node.textContent = `${decimals ? value.toFixed(decimals) : Math.round(value).toLocaleString()}${match[2]}`;
        if (p < 1 && node.isConnected) requestAnimationFrame(step);
        else node.textContent = text;
      };
      requestAnimationFrame(step);
    }
  }

  function afterRender(routeKey) {
    const main = document.querySelector('main.content');
    if (!main) return;
    if (routeKey !== lastKey) {
      lastKey = routeKey;
      if (!reduceMotion()) {
        main.classList.remove('page-enter');
        void main.offsetWidth; // restart the animation
        main.classList.add('page-enter');
      }
      countUp(main);
    }
    // Keep the current tab visible in scrolling tab strips.
    document.querySelectorAll('[data-scroll-tabs] [aria-current="page"]').forEach((tab) => tab.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  }

  // Ripple where a button is pressed.
  document.addEventListener('pointerdown', (event) => {
    const button = event.target.closest?.('.btn, .palette-btn');
    if (!button || button.disabled || reduceMotion()) return;
    const rect = button.getBoundingClientRect();
    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    const size = Math.max(rect.width, rect.height) * 2;
    Object.assign(ripple.style, { width: `${size}px`, height: `${size}px`, left: `${event.clientX - rect.left - size / 2}px`, top: `${event.clientY - rect.top - size / 2}px` });
    button.append(ripple);
    setTimeout(() => ripple.remove(), 600);
  });

  return {
    afterRender,
    openPalette,
    clickActions: {
      'ui-palette': () => openPalette(),
      'ui-theme': () => cycleTheme(),
      'ui-shortcuts': () => shortcutsHelp(),
    },
  };
}
