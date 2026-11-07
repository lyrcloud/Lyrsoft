// Lyrsoft Marketing: turns a campaign (subject, preheader and a simply formatted body) into the
// email people receive. Shared by the app's live preview (lyrsoft/marketing.js) and the API that
// sends it (api/work/marketing.mjs), so what you preview is what goes out. No dependencies.
//
// Body format, one block per paragraph (blank line between blocks):
//   # Heading            ## Smaller heading         > Quote           ---  (divider)
//   - item / * item      1. numbered item
//   ![Alt text](https://example.com/photo.jpg)         an image on its own line
//   [button: Shop now](https://example.com)            a button on its own line
//   Inline: **bold**, *italic*, [link text](https://…), bare https:// links.
// Merge tags: {{first_name}}, {{last_name}}, {{name}}, {{email}}, with a fallback: {{first_name|there}}.

export const MERGE_TAGS = ['first_name', 'last_name', 'name', 'email'];
export const DEFAULT_COLOR = '#5034ff';

const URL_RE = /^(https?:\/\/[^\s<>"']+|mailto:[^\s<>"']+|tel:[+\d][\d\s().-]*)$/i;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

export const escapeHtml = (text) =>
  String(text ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export const safeUrl = (url) => (URL_RE.test(String(url || '').trim()) ? String(url).trim() : '');

// {{first_name|friend}} → the subscriber's value, or the fallback.
export function merge(text, recipient = {}) {
  const [given = '', ...rest] = String(recipient.name || '').trim().split(/\s+/);
  const values = {
    first_name: recipient.firstName || given,
    last_name: recipient.lastName || rest.join(' '),
    name: recipient.name || '',
    email: recipient.email || '',
  };
  return String(text ?? '').replace(/\{\{\s*([a-z_]+)\s*(?:\|([^}]*))?\}\}/gi, (whole, key, fallback) => {
    const k = key.toLowerCase();
    if (!MERGE_TAGS.includes(k)) return whole;
    return values[k] || (fallback ?? '').trim();
  });
}

const BUTTON_RE = /^\[button:\s*([^\]]+)\]\(([^)\s]+)\)$/i;
const IMAGE_RE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;

// Every link in the body, in order of first appearance: the click tracker numbers them.
export function extractLinks(body) {
  const links = [];
  const add = (url) => {
    const clean = safeUrl(url);
    if (clean && /^https?:/i.test(clean) && !links.includes(clean)) links.push(clean);
  };
  const source = String(body ?? '');
  for (const m of source.matchAll(/\[button:\s*[^\]]+\]\(([^)\s]+)\)/gi)) add(m[1]);
  for (const m of source.matchAll(/(?<!!)\[[^\]]+\]\(([^)\s]+)\)/g)) add(m[1]);
  for (const m of source.replace(/\]\([^)]*\)/g, ']').matchAll(/https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/g)) add(m[0]);
  // Keep the order they appear in the text.
  return links.sort((a, b) => source.indexOf(a) - source.indexOf(b));
}

function blocks(body) {
  return String(body ?? '').replace(/\r\n?/g, '\n').trim().split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
}

// Inline formatting on already-escaped text.
function inline(escaped, color, link) {
  const anchors = [];
  const keep = (html) => `\u0000${anchors.push(html) - 1}\u0000`;
  let out = escaped
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, href) => {
      const url = safeUrl(href.replace(/&amp;/g, '&'));
      return url ? keep(`<a href="${escapeHtml(link(url))}" style="color:${color};text-decoration:underline">${label}</a>`) : whole;
    })
    .replace(/https?:\/\/[^\s<>"]+[^\s<>".,;:!?)]/g, (raw) => {
      const url = safeUrl(raw.replace(/&amp;/g, '&'));
      return url ? keep(`<a href="${escapeHtml(link(url))}" style="color:${color};text-decoration:underline">${raw}</a>`) : raw;
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => anchors[Number(i)]);
  return out.replace(/\n/g, '<br>');
}

// The body as email-safe HTML (inline styles, tables for buttons).
export function bodyToHtml(body, { color = DEFAULT_COLOR, recipient = {}, link = (url) => url } = {}) {
  const c = COLOR_RE.test(color) ? color : DEFAULT_COLOR;
  return blocks(merge(body, recipient)).map((block) => {
    const button = block.match(BUTTON_RE);
    if (button && safeUrl(button[2])) {
      return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px"><tr><td style="border-radius:10px;background:${c}"><a href="${escapeHtml(link(safeUrl(button[2])))}" style="display:inline-block;padding:13px 24px;color:#ffffff;font-weight:600;text-decoration:none;border-radius:10px">${escapeHtml(button[1].trim())}</a></td></tr></table>`;
    }
    const image = block.match(IMAGE_RE);
    if (image && /^https:\/\//i.test(image[2])) {
      return `<p style="margin:0 0 20px"><img src="${escapeHtml(image[2])}" alt="${escapeHtml(image[1])}" width="496" style="display:block;width:100%;max-width:496px;height:auto;border:0;border-radius:10px"></p>`;
    }
    if (/^-{3,}$/.test(block)) return '<hr style="border:0;border-top:1px solid #e4e5ef;margin:24px 0">';
    const heading = block.match(/^(#{1,2})\s+(.+)$/s);
    if (heading) {
      const size = heading[1].length === 1 ? 24 : 19;
      return `<h${heading[1].length + 1} style="margin:0 0 14px;font-size:${size}px;line-height:1.3;color:#15172a">${inline(escapeHtml(heading[2]), c, link)}</h${heading[1].length + 1}>`;
    }
    const lines = block.split('\n');
    if (lines.every((l) => /^[-*]\s+/.test(l))) {
      return `<ul style="margin:0 0 18px;padding-left:22px">${lines.map((l) => `<li style="margin:0 0 6px">${inline(escapeHtml(l.replace(/^[-*]\s+/, '')), c, link)}</li>`).join('')}</ul>`;
    }
    if (lines.every((l) => /^\d+[.)]\s+/.test(l))) {
      return `<ol style="margin:0 0 18px;padding-left:22px">${lines.map((l) => `<li style="margin:0 0 6px">${inline(escapeHtml(l.replace(/^\d+[.)]\s+/, '')), c, link)}</li>`).join('')}</ol>`;
    }
    if (lines.every((l) => /^>\s?/.test(l))) {
      return `<blockquote style="margin:0 0 18px;padding:4px 0 4px 16px;border-left:3px solid ${c};color:#4a4e66">${inline(escapeHtml(lines.map((l) => l.replace(/^>\s?/, '')).join('\n')), c, link)}</blockquote>`;
    }
    return `<p style="margin:0 0 18px">${inline(escapeHtml(block), c, link)}</p>`;
  }).join('\n');
}

// The body as plain text: links become "text (url)", buttons "Label: url".
export function bodyToText(body, { recipient = {} } = {}) {
  return blocks(merge(body, recipient)).map((block) => {
    const button = block.match(BUTTON_RE);
    if (button) return `${button[1].trim()}: ${button[2]}`;
    const image = block.match(IMAGE_RE);
    if (image) return image[1] ? `[${image[1]}]` : '';
    if (/^-{3,}$/.test(block)) return '———';
    return block
      .replace(/^#{1,2}\s+/, '')
      .replace(/^>\s?/gm, '')
      .replace(/^\*\s+/gm, '- ')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => (label === url ? url : `${label} (${url})`))
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1$2');
  }).filter(Boolean).join('\n\n');
}

// The whole email. `settings` is the workspace's marketing settings ({ fromName, color, logoUrl,
// address }); `urls` gives the per-recipient links ({ unsubscribe, pixel, link(url) }); missing ones
// (the preview) render as inert "#" links.
export function renderCampaignEmail(campaign, settings = {}, { recipient = {}, urls = {} } = {}) {
  const color = COLOR_RE.test(settings.color || '') ? settings.color : DEFAULT_COLOR;
  const link = urls.link || ((url) => url);
  const unsubscribe = urls.unsubscribe || '#';
  const fromName = settings.fromName || 'Lyrsoft';
  const subject = merge(campaign.subject || '', recipient).trim() || '(no subject)';
  const preheader = merge(campaign.preheader || '', recipient).trim();
  const logo = /^https:\/\//i.test(settings.logoUrl || '')
    ? `<img src="${escapeHtml(settings.logoUrl)}" alt="${escapeHtml(fromName)}" height="40" style="display:block;height:40px;width:auto;border:0">`
    : `<span style="font-size:20px;font-weight:700;color:#15172a">${escapeHtml(fromName)}</span>`;
  const address = String(settings.address || '').trim();
  const footer = [
    `You’re receiving this email because you subscribed to updates from ${escapeHtml(fromName)}.`,
    address ? escapeHtml(address).replace(/\n/g, ', ') : '',
    `<a href="${escapeHtml(unsubscribe)}" style="color:#5d6178;text-decoration:underline">Unsubscribe</a>`,
  ].filter(Boolean).join('<br>');

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f4fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#15172a;-webkit-text-size-adjust:100%">
${preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(preheader)}${'&#847;&zwnj;&nbsp;'.repeat(30)}</div>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4fa;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="padding:0 4px 16px">${logo}</td></tr>
<tr><td style="background:#ffffff;border-radius:14px;border:1px solid #e4e5ef;border-top:4px solid ${color};padding:28px 32px 12px;font-size:16px;line-height:1.6">
${bodyToHtml(campaign.body, { color, recipient, link })}
</td></tr>
<tr><td style="padding:18px 8px 0;font-size:12px;line-height:1.6;color:#5d6178;text-align:center">${footer}</td></tr>
</table></td></tr></table>${urls.pixel ? `<img src="${escapeHtml(urls.pixel)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0">` : ''}
</body></html>`;

  const text = [
    bodyToText(campaign.body, { recipient }),
    '—',
    `You’re receiving this email because you subscribed to updates from ${fromName}.`,
    address.replace(/\n/g, ', '),
    `Unsubscribe: ${unsubscribe}`,
  ].filter(Boolean).join('\n\n');

  return { subject, html, text };
}
