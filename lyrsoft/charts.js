// Small, dependency-free charts for Lyrsoft Work (used by finance.js). Each function returns HTML;
// call mountCharts(root) after rendering to wire the hover layer. Marks follow one spec everywhere:
// bars ≤ 24px with a 4px rounded data end and a square baseline, 2px lines, ≥ 8px end dots with a
// surface ring, 2px surface gaps between stacked segments, solid hairline grid, one y-axis per chart.
// Colours come from CSS custom properties (--viz-1 … --viz-7, --viz-pos, --viz-neg, --viz-muted),
// so light and dark mode each use their own validated steps. Every chart carries a table view.
const specs = new Map();
let seq = 0;

// Which x labels to print: about eight, always the last, never one crowding the last.
// On phones only every other one of those ("mid" labels hide under 640px).
const fits = (i, n, count) => {
  const step = Math.ceil(n / count);
  const last = n - 1;
  return i === last || (i % step === 0 && last - i >= Math.max(step, 2));
};
const labelClass = (i, n) => (fits(i, n, 4) ? '' : fits(i, n, 8) ? ' class="mid"' : ' class="minor"');
const escape = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Clean axis ticks from 0 (or a negative minimum) to max.
function ticks(min, max, count = 4) {
  if (max === min) max = min + 1;
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}
// Axis labels: in full under 10,000, compact once the axis reaches it; one style per axis.
function axisFormat(ticksList) {
  const big = Math.max(...ticksList.map(Math.abs)) >= 10000;
  const f = big ? new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }) : new Intl.NumberFormat();
  return (v) => f.format(v);
}

function frame(id, { title, sub, legend = [], legendKind = 'rect', body, table, height }) {
  return `<figure class="viz" data-viz="${id}">
    ${title ? `<figcaption class="viz-head"><b>${escape(title)}</b>${sub ? `<span>${escape(sub)}</span>` : ''}</figcaption>` : ''}
    ${legend.length > 1 ? `<ul class="viz-legend">${legend.map((l) => `<li><i class="viz-key ${legendKind}" style="--c:${l.color}"></i>${escape(l.name)}</li>`).join('')}</ul>` : ''}
    <div class="viz-body" style="${height ? `height:${height}px` : ''}">${body}<div class="viz-tip" role="status" hidden></div></div>
    ${table ? `<details class="viz-table"><summary>Show as table</summary><div class="table-scroll">${table}</div></details>` : ''}
  </figure>`;
}

function tableHtml(head, rows) {
  return `<table class="data-table"><thead><tr>${head.map((h, i) => `<th${i ? ' class="num"' : ''}>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="num"' : ''}>${escape(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function yAxis(tk, toPct, fmt) {
  return `<div class="viz-grid">${tk.map((t) => `<span class="viz-gl${t === 0 ? ' zero' : ''}" style="bottom:${toPct(t)}%"><em>${escape(fmt(t))}</em></span>`).join('')}</div>`;
}

// ------------------------------------------------------------------ line chart (with crosshair)

// series: [{ name, color, values: [number|null], dashed? }], labels: x labels. One y-axis.
export function lineChart({ title, sub, labels, series, format = (v) => v, height = 240, area = false, endLabels = true }) {
  const id = `viz${++seq}`;
  const all = series.flatMap((s) => s.values).filter((v) => v != null);
  const tk = ticks(Math.min(0, ...all), Math.max(0, ...all));
  const lo = tk[0];
  const hi = tk.at(-1);
  const toPct = (v) => ((v - lo) / (hi - lo)) * 100;
  const x = (i) => (labels.length === 1 ? 50 : (i / (labels.length - 1)) * 100);
  const fmt = axisFormat(tk);
  const paths = series.map((s) => {
    const pts = s.values.map((v, i) => (v == null ? null : `${x(i).toFixed(3)},${(100 - toPct(v)).toFixed(3)}`));
    const d = pts.reduce((acc, p, i) => (p ? `${acc}${acc && pts[i - 1] ? 'L' : 'M'}${p}` : acc), '');
    const fill = area && pts.every(Boolean) ? `<path d="${d}L100,${100 - toPct(Math.max(lo, 0))}L0,${100 - toPct(Math.max(lo, 0))}Z" class="viz-area" style="--c:${s.color}"/>` : '';
    return `${fill}<path d="${d}" class="viz-line${s.dashed ? ' dashed' : ''}" style="--c:${s.color}" vector-effect="non-scaling-stroke"/>`;
  }).join('');
  const last = labels.length - 1;
  const ends = series.map((s) => {
    const i = s.values.findLastIndex((v) => v != null);
    return i < 0 ? '' : `<span class="viz-dot" style="left:${x(i)}%;bottom:${toPct(s.values[i])}%;--c:${s.color}"></span>${endLabels && series.length <= 4 && i === last ? `<span class="viz-end" style="bottom:${toPct(s.values[i])}%">${escape(format(s.values[i]))}</span>` : ''}`;
  }).join('');
  specs.set(id, { kind: 'line', labels, series, format, x });
  const body = `${yAxis(tk, toPct, fmt)}<div class="viz-plot line" data-viz-plot="${id}" tabindex="0" aria-label="${escape(title || 'Chart')}: use arrow keys to read values">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${paths}</svg>${ends}<span class="viz-cross" hidden></span></div>
    <div class="viz-x">${labels.map((l, i) => `<span style="left:${x(i)}%"${labelClass(i, labels.length)}>${escape(l)}</span>`).join('')}</div>`;
  return frame(id, {
    title,
    sub,
    legend: series.map((s) => ({ name: s.name, color: s.color })),
    legendKind: 'line',
    body,
    height,
    table: tableHtml(['', ...series.map((s) => s.name)], labels.map((l, i) => [l, ...series.map((s) => (s.values[i] == null ? '—' : format(s.values[i])))])),
  });
}

// ------------------------------------------------------------------ columns (stacked or signed)

// stacks: [{ name, color }], columns: [{ label, values: [number per stack] }]. Negative totals hang
// below the zero line (profit/loss): use one stack with colorOf(value) for a signed series.
export function columnChart({ title, sub, columns, stacks, format = (v) => v, height = 240, colorOf = null, legend = null }) {
  const id = `viz${++seq}`;
  const totals = columns.map((c) => c.values.reduce((s, v) => s + (v || 0), 0));
  const tk = ticks(Math.min(0, ...totals), Math.max(0, ...totals));
  const lo = tk[0];
  const hi = tk.at(-1);
  const toPct = (v) => ((v - lo) / (hi - lo)) * 100;
  const zero = toPct(0);
  const fmt = axisFormat(tk);
  specs.set(id, { kind: 'col', columns, stacks, format });
  const cols = columns.map((c, ci) => {
    const total = totals[ci];
    const neg = total < 0;
    const segs = c.values.map((v, si) => (v ? `<i class="viz-seg" style="flex:${Math.abs(v)};--c:${colorOf ? colorOf(v) : stacks[si].color}"></i>` : '')).join('');
    const h = Math.abs(toPct(total) - zero);
    return `<button type="button" class="viz-col" data-i="${ci}" style="left:${((ci + 0.5) / columns.length) * 100}%;width:${100 / columns.length}%" aria-label="${escape(c.label)}: ${escape(format(total))}">
      <span class="viz-stack${neg ? ' neg' : ''}" style="${neg ? `top:${100 - zero}%` : `bottom:${zero}%`};height:${h}%">${segs}</span></button>`;
  }).join('');
  const body = `${yAxis(tk, toPct, fmt)}<div class="viz-plot cols" data-viz-plot="${id}">${cols}</div>
    <div class="viz-x">${columns.map((c, i) => `<span style="left:${((i + 0.5) / columns.length) * 100}%"${labelClass(i, columns.length)}>${escape(c.label)}</span>`).join('')}</div>`;
  return frame(id, {
    title,
    sub,
    legend: legend || stacks.map((s) => ({ name: s.name, color: s.color })),
    body,
    height,
    table: tableHtml(['', ...stacks.map((s) => s.name), ...(stacks.length > 1 ? ['Total'] : [])], columns.map((c, i) => [c.label, ...c.values.map((v) => format(v || 0)), ...(stacks.length > 1 ? [format(totals[i])] : [])])),
  });
}

// ------------------------------------------------------------------ horizontal bars (ranked)

// rows: [{ name, value, target?, note?, flag? }] — one series, one colour; an optional target tick
// (a budget) on each bar; `flag` marks a row (over budget) with an icon and text, never colour alone.
export function barList({ title, sub, rows, format = (v) => v, color = 'var(--viz-1)', targetLabel = 'Budget' }) {
  const id = `viz${++seq}`;
  const max = Math.max(1, ...rows.map((r) => Math.max(r.value, r.target || 0)));
  specs.set(id, { kind: 'bars', rows, format, targetLabel });
  const body = `<ul class="viz-bars" data-viz-plot="${id}">${rows.map((r, i) => `<li data-i="${i}" tabindex="0">
      <span class="viz-bar-name">${escape(r.name)}${r.flag ? ` <span class="viz-flag">⚠ ${escape(r.flag)}</span>` : ''}</span>
      <span class="viz-bar-track"><i class="viz-bar" style="width:${(r.value / max) * 100}%;--c:${color}"></i>${r.target ? `<b class="viz-target" style="left:${(r.target / max) * 100}%" title="${escape(targetLabel)}"></b>` : ''}</span>
      <span class="viz-bar-val">${escape(format(r.value))}${r.note ? `<small>${escape(r.note)}</small>` : ''}</span></li>`).join('')}</ul>`;
  return frame(id, {
    title,
    sub,
    body,
    table: tableHtml(['', 'Amount', ...(rows.some((r) => r.target) ? [targetLabel] : [])], rows.map((r) => [r.name, format(r.value), ...(rows.some((x) => x.target) ? [r.target ? format(r.target) : '—'] : [])])),
  });
}

// ------------------------------------------------------------------ segmented bar (part of a whole)

export function segmentedBar({ title, sub, parts, format = (v) => v }) {
  const id = `viz${++seq}`;
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  specs.set(id, { kind: 'seg', parts, format, total });
  const body = `<div class="viz-segbar" data-viz-plot="${id}" role="img" aria-label="${escape(parts.map((p) => `${p.name} ${Math.round((p.value / total) * 100)}%`).join(', '))}">${parts.filter((p) => p.value > 0).map((p) => {
    const pct = (p.value / total) * 100;
    return `<span class="viz-part" data-i="${parts.indexOf(p)}" tabindex="0" style="flex:${p.value};--c:${p.color}${p.dark ? ';--ink:#0b0b0b' : ''}">${pct >= 9 ? `${Math.round(pct)}%` : ''}</span>`;
  }).join('')}</div>`;
  return frame(id, {
    title,
    sub,
    legend: parts.length > 1 ? parts.map((p) => ({ name: p.name, color: p.color })) : [],
    body,
    table: tableHtml(['', 'Amount', 'Share'], parts.map((p) => [p.name, format(p.value), `${Math.round((p.value / total) * 1000) / 10}%`])),
  });
}

// ------------------------------------------------------------------ hover layer

function tip(fig, rows, heading, anchorX) {
  const box = fig.querySelector('.viz-tip');
  box.replaceChildren();
  const h = document.createElement('b');
  h.textContent = heading;
  box.append(h);
  for (const r of rows) {
    const line = document.createElement('span');
    if (r.color) {
      const key = document.createElement('i');
      key.className = 'viz-key line';
      key.style.setProperty('--c', r.color);
      line.append(key);
    }
    const val = document.createElement('strong');
    val.textContent = r.value;
    const name = document.createElement('small');
    name.textContent = r.name;
    line.append(val, name);
    box.append(line);
  }
  box.hidden = false;
  const bodyRect = fig.querySelector('.viz-body').getBoundingClientRect();
  const left = Math.min(Math.max(anchorX - bodyRect.left + 12, 0), bodyRect.width - box.offsetWidth - 4);
  box.style.left = `${left < anchorX - bodyRect.left - 10 ? anchorX - bodyRect.left - box.offsetWidth - 12 : left}px`;
}
const hideTip = (fig) => {
  fig.querySelector('.viz-tip').hidden = true;
  const cross = fig.querySelector('.viz-cross');
  if (cross) cross.hidden = true;
  fig.querySelectorAll('.is-hot').forEach((n) => n.classList.remove('is-hot'));
};

export function mountCharts(root = document) {
  for (const plot of root.querySelectorAll('[data-viz-plot]:not([data-mounted])')) {
    plot.dataset.mounted = '1';
    const spec = specs.get(plot.dataset.vizPlot);
    const fig = plot.closest('.viz');
    if (!spec) continue;
    if (spec.kind === 'line') {
      const cross = plot.querySelector('.viz-cross');
      let at = spec.labels.length - 1;
      const show = (i) => {
        at = Math.max(0, Math.min(spec.labels.length - 1, i));
        const r = plot.getBoundingClientRect();
        cross.hidden = false;
        cross.style.left = `${spec.x(at)}%`;
        tip(fig, spec.series.map((s) => ({ color: s.color, name: s.name, value: s.values[at] == null ? '—' : spec.format(s.values[at]) })), spec.labels[at], r.left + (spec.x(at) / 100) * r.width);
      };
      plot.addEventListener('pointermove', (e) => {
        const r = plot.getBoundingClientRect();
        show(Math.round(((e.clientX - r.left) / r.width) * (spec.labels.length - 1)));
      });
      plot.addEventListener('pointerleave', () => hideTip(fig));
      plot.addEventListener('focus', () => show(at));
      plot.addEventListener('blur', () => hideTip(fig));
      plot.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          show(at + (e.key === 'ArrowRight' ? 1 : -1));
        }
      });
    } else if (spec.kind === 'col') {
      const show = (btn) => {
        const c = spec.columns[Number(btn.dataset.i)];
        hideTip(fig);
        btn.classList.add('is-hot');
        const rows = spec.stacks.length > 1
          ? [...c.values.map((v, i) => ({ v, i })).filter((x) => x.v).reverse().map(({ v, i }) => ({ color: spec.stacks[i].color, name: spec.stacks[i].name, value: spec.format(v) })), { name: 'Total', value: spec.format(c.values.reduce((s, v) => s + (v || 0), 0)) }]
          : [{ name: spec.stacks[0].name, value: spec.format(c.values[0] || 0) }];
        const r = btn.getBoundingClientRect();
        tip(fig, rows, c.label, r.left + r.width / 2);
      };
      plot.addEventListener('pointerover', (e) => e.target.closest('.viz-col') && show(e.target.closest('.viz-col')));
      plot.addEventListener('focusin', (e) => e.target.closest('.viz-col') && show(e.target.closest('.viz-col')));
      plot.addEventListener('pointerleave', () => hideTip(fig));
      plot.addEventListener('focusout', () => hideTip(fig));
    } else if (spec.kind === 'seg' || spec.kind === 'bars') {
      const show = (el) => {
        hideTip(fig);
        el.classList.add('is-hot');
        const i = Number(el.dataset.i);
        const r = el.getBoundingClientRect();
        if (spec.kind === 'seg') {
          const p = spec.parts[i];
          tip(fig, [{ color: p.color, name: p.name, value: `${spec.format(p.value)} · ${Math.round((p.value / spec.total) * 1000) / 10}%` }], 'Share of costs', r.left + r.width / 2);
        } else {
          const row = spec.rows[i];
          tip(fig, [{ name: 'Spent', value: spec.format(row.value) }, ...(row.target ? [{ name: spec.targetLabel, value: spec.format(row.target) }] : []), ...(row.note ? [{ name: '', value: row.note }] : [])], row.name, r.left + Math.min(r.width, 260));
        }
      };
      const sel = spec.kind === 'seg' ? '.viz-part' : 'li';
      plot.addEventListener('pointerover', (e) => e.target.closest(sel) && show(e.target.closest(sel)));
      plot.addEventListener('focusin', (e) => e.target.closest(sel) && show(e.target.closest(sel)));
      plot.addEventListener('pointerleave', () => hideTip(fig));
      plot.addEventListener('focusout', () => hideTip(fig));
    }
  }
  // Forget specs whose charts are gone.
  if (specs.size > 200) for (const id of specs.keys()) if (!document.querySelector(`[data-viz="${id}"]`)) specs.delete(id);
}
