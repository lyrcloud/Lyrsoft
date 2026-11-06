// Contact import and export formats for Lyrsoft Contacts (contacts.js). Pure functions with no DOM,
// so they run in the browser and in Node tests (api/work/contacts.test.mjs).
//
// Import: vCard 2.1/3.0/4.0 (.vcf: Android and iPhone exports, Google, iCloud, Outlook), CSV (Google
// Contacts, Outlook, Yahoo, LinkedIn Connections.csv and any spreadsheet with recognisable headers) and
// JSON (Lyrsoft backups, Facebook / Messenger / Instagram "Download your information", Telegram
// exports, Google People API results). Export: vCard 3.0, Google CSV, Outlook CSV and Lyrsoft JSON.
//
// A parsed contact looks like the server's (api/work/contacts-model.mjs):
//   { name, given, family, nickname, company, title, emails: [{ value, label }], phones: [{ value, label }],
//     addresses: [{ value, label }], websites: [url], socials: [{ network, value }], birthday, notes,
//     tags: [text], favorite, source }

export const SOCIAL_NETWORKS = {
  whatsapp: { label: 'WhatsApp', icon: '🟢', url: (h) => `https://wa.me/${h.replace(/\D/g, '')}` },
  facebook: { label: 'Facebook', icon: 'ⓕ', url: (h) => `https://facebook.com/${h}` },
  messenger: { label: 'Messenger', icon: '💬', url: (h) => `https://m.me/${h}` },
  instagram: { label: 'Instagram', icon: '📷', url: (h) => `https://instagram.com/${h}` },
  threads: { label: 'Threads', icon: '@', url: (h) => `https://threads.net/@${h}` },
  x: { label: 'X (Twitter)', icon: '𝕏', url: (h) => `https://x.com/${h}` },
  linkedin: { label: 'LinkedIn', icon: 'in', url: (h) => `https://linkedin.com/in/${h}` },
  telegram: { label: 'Telegram', icon: '✈', url: (h) => `https://t.me/${h}` },
  tiktok: { label: 'TikTok', icon: '♪', url: (h) => `https://tiktok.com/@${h}` },
  youtube: { label: 'YouTube', icon: '▶', url: (h) => `https://youtube.com/@${h}` },
  snapchat: { label: 'Snapchat', icon: '👻', url: (h) => `https://snapchat.com/add/${h}` },
  github: { label: 'GitHub', icon: '⌥', url: (h) => `https://github.com/${h}` },
  viber: { label: 'Viber', icon: '📞', url: null },
  signal: { label: 'Signal', icon: '🔵', url: null },
  wechat: { label: 'WeChat', icon: '💚', url: null },
  skype: { label: 'Skype', icon: 'S', url: (h) => `skype:${h}?chat` },
  discord: { label: 'Discord', icon: '🎮', url: null },
  other: { label: 'Other', icon: '🔗', url: null },
};

// Profile URLs are recognised as social profiles rather than plain websites.
const URL_NETWORKS = [
  [/(^|\.)(facebook\.com|fb\.com|fb\.me)$/, 'facebook'],
  [/(^|\.)(m\.me|messenger\.com)$/, 'messenger'],
  [/(^|\.)instagram\.com$/, 'instagram'],
  [/(^|\.)threads\.(net|com)$/, 'threads'],
  [/(^|\.)(twitter\.com|x\.com)$/, 'x'],
  [/(^|\.)linkedin\.com$/, 'linkedin'],
  [/(^|\.)(t\.me|telegram\.me)$/, 'telegram'],
  [/(^|\.)(wa\.me|whatsapp\.com)$/, 'whatsapp'],
  [/(^|\.)tiktok\.com$/, 'tiktok'],
  [/(^|\.)(youtube\.com|youtu\.be)$/, 'youtube'],
  [/(^|\.)snapchat\.com$/, 'snapchat'],
  [/(^|\.)github\.com$/, 'github'],
];

export function networkOfUrl(url) {
  try {
    const host = new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase();
    return URL_NETWORKS.find(([re]) => re.test(host))?.[1] || null;
  } catch {
    return null;
  }
}

// A link for a social profile: full URLs as they are, handles turned into the network's profile URL.
export function socialUrl({ network, value }) {
  const v = String(value || '').trim();
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[\w.-]+\.[a-z]{2,}\//i.test(v)) return `https://${v}`;
  const make = SOCIAL_NETWORKS[network]?.url;
  const handle = v.replace(/^@/, '');
  if (network === 'whatsapp' && handle.replace(/\D/g, '').length < 7) return null;
  return make && v ? make(network === 'whatsapp' ? handle : encodeURIComponent(handle)) : null;
}

const NETWORK_ALIASES = {
  twitter: 'x', 'x.com': 'x', fb: 'facebook', ig: 'instagram', wa: 'whatsapp', tg: 'telegram', 'linked in': 'linkedin', yt: 'youtube',
};
export function networkOf(name) {
  const key = String(name || '').toLowerCase().replace(/^x-/, '').replace(/[^a-z. ]/g, '').trim();
  if (SOCIAL_NETWORKS[key]) return key;
  if (NETWORK_ALIASES[key]) return NETWORK_ALIASES[key];
  return Object.keys(SOCIAL_NETWORKS).find((n) => n !== 'other' && n !== 'x' && key.includes(n)) || (/\btwitter\b/.test(key) ? 'x' : null);
}

// ------------------------------------------------------------------ helpers

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

// Facebook's JSON exports write UTF-8 text as if it were Latin-1 ("JosÃ©"); this undoes that.
export function fixMojibake(text) {
  const s = String(text ?? '');
  if (!/[\u00c0-\u00ff][\u0080-\u00bf]/.test(s) || /[^\u0000-\u00ff]/.test(s)) return s;
  try {
    const out = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(s, (c) => c.charCodeAt(0)));
    return out;
  } catch {
    return s;
  }
}

function blank(source) {
  return { name: '', given: '', family: '', nickname: '', company: '', title: '', emails: [], phones: [], addresses: [], websites: [], socials: [], birthday: '', notes: '', tags: [], favorite: false, source };
}

function addEmail(c, value, label = '') {
  for (const part of String(value || '').split(/\s*(?::::|[,;])\s*/)) {
    const email = clean(part).replace(/^mailto:/i, '').toLowerCase();
    if (EMAIL_RE.test(email) && !c.emails.some((e) => e.value === email)) c.emails.push({ value: email, label: cleanLabel(label) });
  }
}

function addPhone(c, value, label = '') {
  for (const part of String(value || '').split(/\s*:::\s*/)) {
    const phone = clean(part).replace(/^tel:/i, '');
    const digits = phone.replace(/\D/g, '');
    if (digits.length >= 3 && !c.phones.some((p) => p.value.replace(/\D/g, '') === digits)) c.phones.push({ value: phone, label: cleanLabel(label) });
  }
}

function addUrl(c, value, label = '') {
  for (const part of String(value || '').split(/\s*:::\s*/)) {
    const url = clean(part);
    if (!url) continue;
    const network = networkOf(label) || networkOfUrl(url);
    if (network) addSocial(c, network, url);
    else if (!c.websites.includes(url)) c.websites.push(url);
  }
}

function addSocial(c, network, value) {
  const v = clean(value);
  if (v && !c.socials.some((s) => s.network === network && s.value.toLowerCase() === v.toLowerCase())) c.socials.push({ network, value: v });
}

function addAddress(c, value, label = '') {
  const v = String(value || '').split(/\n|\r/).map(clean).filter(Boolean).join(', ');
  if (v && !c.addresses.some((a) => a.value === v)) c.addresses.push({ value: v, label: cleanLabel(label) });
}

function addTags(c, value) {
  for (const part of String(value || '').split(/\s*(?::::|[,;])\s*/)) {
    const tag = clean(part);
    if (!tag) continue;
    if (/^\*\s*starred$/i.test(tag)) c.favorite = true;
    else if (!/^\*\s*mycontacts$|^system group/i.test(tag) && !c.tags.includes(tag)) c.tags.push(tag);
  }
}

// "CELL", "x-mobile", "_$!<Mobile>!$_" (Apple), "pref" … → "mobile", "home", "work" or a short label.
export function cleanLabel(label) {
  const words = String(label || '').toLowerCase().replace(/_\$!<|>!\$_/g, '').replace(/^x-/, '').split(/[\s,;=]+/).filter((w) => w && !['pref', 'internet', 'voice', 'type', 'x400', 'value', 'uri', 'text'].includes(w));
  const w = words.join(' ');
  if (/cell|mobile|iphone/.test(w)) return 'mobile';
  if (/work|business|office/.test(w)) return w.includes('fax') ? 'work fax' : 'work';
  if (/home|personal/.test(w)) return w.includes('fax') ? 'home fax' : 'home';
  if (/fax/.test(w)) return 'fax';
  if (/main/.test(w)) return 'main';
  if (/other/.test(w)) return 'other';
  return w.slice(0, 30);
}

export function normalizeBirthday(value) {
  const v = clean(value);
  let m;
  if ((m = v.match(/^(\d{4})-?(\d{2})-?(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = v.match(/^--(\d{2})-?(\d{2})$/))) return `--${m[1]}-${m[2]}`;
  if ((m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; // US m/d/yyyy (Outlook)
  return '';
}

function finish(c) {
  c.name = clean(c.name) || clean(`${c.given} ${c.family}`) || clean(c.nickname) || clean(c.company) || c.emails[0]?.value || c.phones[0]?.value || '';
  c.notes = String(c.notes || '').trim();
  return c.name || c.emails.length || c.phones.length ? c : null;
}

// ------------------------------------------------------------------ vCard

const unescapeV = (v) => v.replace(/\\n/gi, '\n').replace(/\\([,;:\\])/g, '$1');
// Splits on unescaped `sep`.
function splitV(value, sep) {
  const out = [''];
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === '\\' && i + 1 < value.length) out[out.length - 1] += value[i] + value[++i];
    else if (value[i] === sep) out.push('');
    else out[out.length - 1] += value[i];
  }
  return out.map(unescapeV);
}

function decodeQuotedPrintable(value, charset = 'utf-8') {
  const bytes = [];
  const s = value.replace(/=\r?\n/g, '');
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '=' && /^[0-9a-f]{2}$/i.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(...new TextEncoder().encode(s[i]));
  }
  try {
    return new TextDecoder(charset).decode(Uint8Array.from(bytes));
  } catch {
    return new TextDecoder().decode(Uint8Array.from(bytes));
  }
}

// Joins folded lines (and vCard 2.1 quoted-printable soft breaks), then reads "group.NAME;params:value".
function vcardLines(text) {
  const raw = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const lines = [];
  for (const line of raw) {
    const prev = lines.at(-1);
    if (prev !== undefined && /^[ \t]/.test(line)) lines[lines.length - 1] = prev + line.slice(1);
    else if (prev !== undefined && /ENCODING=QUOTED-PRINTABLE/i.test(prev.split(':')[0]) && prev.endsWith('=')) lines[lines.length - 1] = prev.slice(0, -1) + line;
    else lines.push(line);
  }
  return lines.filter(Boolean).map((line) => {
    // The first colon outside a quoted parameter value ends the name and parameters.
    let colon = -1;
    for (let i = 0, quoted = false; i < line.length; i += 1) {
      if (line[i] === '"') quoted = !quoted;
      else if (line[i] === ':' && !quoted) {
        colon = i;
        break;
      }
    }
    if (colon < 0) return null;
    const [head, ...paramParts] = line.slice(0, colon).split(';');
    const dot = head.lastIndexOf('.');
    const params = {};
    const types = [];
    for (const p of paramParts) {
      const [k, v] = p.includes('=') ? [p.slice(0, p.indexOf('=')).toUpperCase(), p.slice(p.indexOf('=') + 1).replace(/^"|"$/g, '')] : ['TYPE', p];
      if (k === 'TYPE') types.push(...v.split(',').map((t) => t.toLowerCase()));
      else params[k] = v;
    }
    let value = line.slice(colon + 1);
    if (/quoted-printable/i.test(params.ENCODING || '')) value = decodeQuotedPrintable(value, params.CHARSET);
    return { group: dot > 0 ? head.slice(0, dot).toLowerCase() : '', name: head.slice(dot + 1).toUpperCase(), params, types, value };
  }).filter(Boolean);
}

export function parseVCard(text, source = 'vcard') {
  const contacts = [];
  let props = null;
  for (const prop of vcardLines(text)) {
    if (prop.name === 'BEGIN' && /vcard/i.test(prop.value)) props = [];
    else if (prop.name === 'END' && /vcard/i.test(prop.value)) {
      if (props) {
        const c = vcardToContact(props, source);
        if (c) contacts.push(c);
      }
      props = null;
    } else props?.push(prop);
  }
  return contacts;
}

function vcardToContact(props, source) {
  const c = blank(source);
  // Apple labels ("item1.X-ABLabel:Facebook") apply to the other property in the same group.
  const groupLabels = Object.fromEntries(props.filter((p) => p.name === 'X-ABLABEL' && p.group).map((p) => [p.group, p.value]));
  for (const p of props) {
    const label = groupLabels[p.group] || p.types.join(' ') || p.params.LABEL || '';
    const v = p.value;
    switch (p.name) {
      case 'FN': c.name = unescapeV(v); break;
      case 'N': {
        const [family = '', given = '', middle = ''] = splitV(v, ';');
        c.family = clean(family);
        c.given = clean(`${given} ${middle}`);
        break;
      }
      case 'NICKNAME': c.nickname = clean(unescapeV(v)); break;
      case 'ORG': c.company = splitV(v, ';').map(clean).filter(Boolean).join(', '); break;
      case 'TITLE': c.title = clean(unescapeV(v)); break;
      case 'EMAIL': addEmail(c, unescapeV(v), label); break;
      case 'TEL': addPhone(c, unescapeV(v), label); break;
      case 'ADR': {
        const [po, ext, street, city, region, postal, country] = splitV(v, ';').map(clean);
        addAddress(c, [po, ext, street, [city, region, postal].filter(Boolean).join(' '), country].filter(Boolean).join(', '), label);
        break;
      }
      case 'URL': addUrl(c, unescapeV(v), label); break;
      case 'BDAY': c.birthday = normalizeBirthday(v); break;
      case 'NOTE': c.notes = [c.notes, unescapeV(v)].filter(Boolean).join('\n'); break;
      case 'CATEGORIES': addTags(c, splitV(v, ',').join(',')); break;
      case 'X-SOCIALPROFILE': {
        const network = networkOf(p.types[0] || p.params['X-USER'] || label) || networkOfUrl(v) || 'other';
        addSocial(c, network, p.params['X-USER'] && !/^https?:/i.test(v) ? p.params['X-USER'] : unescapeV(v));
        break;
      }
      case 'IMPP': {
        const [, scheme, handle] = v.match(/^([\w-]+):(.*)$/) || [];
        const network = networkOf(p.params['X-SERVICE-TYPE'] || label || scheme) || 'other';
        if (network === 'whatsapp' || network === 'viber' || network === 'signal') addPhone(c, handle || v, network);
        addSocial(c, network, handle || v);
        break;
      }
      default:
        if (/^X-(AIM|ICQ|JABBER|MSN|YAHOO|QQ|GOOGLE-TALK)$/.test(p.name)) break;
        if (/^X-(SKYPE|TWITTER|FACEBOOK|INSTAGRAM|LINKEDIN|TELEGRAM|WHATSAPP|SKYPE-USERNAME)/.test(p.name)) addSocial(c, networkOf(p.name) || 'other', unescapeV(v));
    }
  }
  return finish(c);
}

const escV = (v) => String(v ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
// Folds at 75 octets as RFC 6350 asks (without splitting a UTF-8 character).
function fold(line) {
  const out = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = new TextEncoder().encode(ch).length;
    if (bytes + size > (out.length ? 74 : 75)) {
      out.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join('\r\n ');
}

const VCARD_TYPES = { mobile: 'CELL', home: 'HOME', work: 'WORK', fax: 'FAX', 'work fax': 'WORK,FAX', 'home fax': 'HOME,FAX', main: 'MAIN', other: 'OTHER' };

export function toVCard(contacts) {
  return contacts.map((c) => {
    const lines = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${escV(c.name)}`];
    const [given, family] = c.given || c.family ? [c.given, c.family] : splitName(c.name);
    lines.push(`N:${escV(family)};${escV(given)};;;`);
    if (c.nickname) lines.push(`NICKNAME:${escV(c.nickname)}`);
    if (c.company) lines.push(`ORG:${escV(c.company)}`);
    if (c.title) lines.push(`TITLE:${escV(c.title)}`);
    for (const e of c.emails || []) lines.push(`EMAIL;TYPE=INTERNET${e.label && VCARD_TYPES[e.label] ? `,${VCARD_TYPES[e.label]}` : ''}:${e.value}`);
    for (const p of c.phones || []) lines.push(`TEL${p.label && VCARD_TYPES[p.label] ? `;TYPE=${VCARD_TYPES[p.label]}` : ''}:${p.value}`);
    for (const a of c.addresses || []) lines.push(`ADR${a.label && VCARD_TYPES[a.label] ? `;TYPE=${VCARD_TYPES[a.label]}` : ''}:;;${escV(a.value)};;;;`);
    for (const url of c.websites || []) lines.push(`URL:${url}`);
    for (const s of c.socials || []) {
      const url = socialUrl(s) || s.value;
      lines.push(`X-SOCIALPROFILE;TYPE=${s.network}:${url}`);
    }
    if (c.birthday) lines.push(`BDAY:${c.birthday}`);
    if (c.tags?.length) lines.push(`CATEGORIES:${c.tags.map(escV).join(',')}`);
    if (c.notes) lines.push(`NOTE:${escV(c.notes)}`);
    lines.push('END:VCARD');
    return lines.map(fold).join('\r\n');
  }).join('\r\n') + '\r\n';
}

export function splitName(name) {
  const parts = clean(name).split(' ');
  return parts.length > 1 ? [parts.slice(0, -1).join(' '), parts.at(-1)] : [parts[0] || '', ''];
}

// ------------------------------------------------------------------ CSV

export function parseCsvRows(text) {
  const s = text.replace(/^\ufeff/, '');
  const firstLine = s.slice(0, s.indexOf('\n') > 0 ? s.indexOf('\n') : s.length);
  const delimiter = [',', ';', '\t'].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows = [];
  let row = [''];
  let quoted = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        row[row.length - 1] += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else row[row.length - 1] += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) row.push('');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i += 1;
      rows.push(row);
      row = [''];
    } else row[row.length - 1] += ch;
  }
  if (row.length > 1 || row[0]) rows.push(row);
  return rows.filter((r) => r.some((cell) => cell.trim()));
}

// What a CSV header means: { kind, slot, part } where part is "value" or "label".
function classifyHeader(header, linkedin) {
  const h = header.toLowerCase().replace(/[_]+/g, ' ').trim();
  if (!h || /department|phonetic|yomi|symbol|office location|file as|prefix|suffix|initials|gender|language|priority|sensitivity|mileage|billing/.test(h)) return null;
  const num = (h.match(/\b(\d+)\b/) || [])[1] || '';
  const part = /-\s*(type|label)$|\blabel$/.test(h) ? 'label' : 'value';
  const social = networkOf(h.replace(/\b(url|profile|handle|username|link|id)\b/g, '').trim());
  if (/e-?mail/.test(h)) return { kind: 'email', slot: `email${num || (h.match(/e-?mail\s*(\d)/) || [])[1] || h}`, part, label: h };
  if (/\b(phone|mobile|tel|telephone|cell|fax|pager|whatsapp number)\b/.test(h)) return { kind: 'phone', slot: num ? `phone${num}` : h, part, label: h };
  if (social && !/website|web page/.test(h)) return { kind: 'social', network: social, slot: h, part: 'value' };
  if (linkedin && h === 'url') return { kind: 'social', network: 'linkedin', slot: h, part: 'value' };
  if (/\b(street|city|state|postal|zip|country|region|po box|address|formatted)\b/.test(h)) {
    const which = (h.match(/\b(home|business|work|other)\b/) || [])[1] || num || 'a';
    const field = (h.match(/\b(street|city|state|postal|zip|country|region|po box|formatted)\b/) || [])[1] || 'formatted';
    return { kind: 'address', slot: `addr${which}`, part: part === 'label' ? 'label' : field, label: /^\d+$|^a$/.test(which) ? '' : which };
  }
  if (/\b(web ?site|web page|homepage|url|link)\b/.test(h)) return { kind: 'website', slot: `web${num || h}`, part, label: h };
  if (/^(first|given)( name)?$|first name|given name/.test(h) && !/phonetic|yomi/.test(h)) return { kind: 'given' };
  if (/^(last|family|sur)( ?name)?$|last name|family name|surname/.test(h) && !/phonetic|yomi/.test(h)) return { kind: 'family' };
  if (/middle|additional name/.test(h) && !/phonetic|yomi/.test(h)) return { kind: 'middle' };
  if (/^(name|full name|display name|contact name|contact|person)$/.test(h)) return { kind: 'name' };
  if (/nick ?name/.test(h)) return { kind: 'nickname' };
  if (/title|position|job|role/.test(h)) return { kind: 'title' };
  if (/company|organi[sz]ation|employer|business name/.test(h)) return { kind: 'company' };
  if (/birth/.test(h)) return { kind: 'birthday' };
  if (/^notes?$|^comments?$|description/.test(h)) return { kind: 'notes' };
  if (/label|group|categor|tags?$|membership/.test(h)) return { kind: 'tags' };
  if (/starred|favou?rite/.test(h)) return { kind: 'favorite' };
  return null;
}

export function parseCSV(text, source = 'csv') {
  const rows = parseCsvRows(text);
  // LinkedIn's Connections.csv starts with a few lines of notes before the header row.
  const headerIndex = rows.findIndex((r) => r.filter((cell) => classifyHeader(cell, false)).length >= 2);
  if (headerIndex < 0) return [];
  const headers = rows[headerIndex];
  const linkedin = headers.some((h) => /connected on/i.test(h));
  const columns = headers.map((h) => classifyHeader(h, linkedin));
  const out = [];
  for (const row of rows.slice(headerIndex + 1)) {
    const c = blank(linkedin ? 'linkedin' : source);
    const slots = new Map();
    let middle = '';
    columns.forEach((col, i) => {
      const v = String(row[i] ?? '').trim();
      if (!col || !v) return;
      if (['email', 'phone', 'website', 'address'].includes(col.kind)) {
        const slot = slots.get(col.slot) || { kind: col.kind, label: col.label, parts: {} };
        slot.parts[col.part] = v;
        slots.set(col.slot, slot);
      } else if (col.kind === 'social') addSocial(c, col.network, v);
      else if (col.kind === 'middle') middle = v;
      else if (col.kind === 'tags') addTags(c, v);
      else if (col.kind === 'favorite') c.favorite = /^(1|true|yes|y|starred)$/i.test(v);
      else if (col.kind === 'birthday') c.birthday = normalizeBirthday(v);
      else if (col.kind === 'notes') c.notes = [c.notes, v].filter(Boolean).join('\n');
      else c[col.kind] = clean(v);
    });
    if (middle) c.given = clean(`${c.given} ${middle}`);
    for (const slot of slots.values()) {
      const label = slot.parts.label || slot.label.replace(/e-?mail|address|phone|number|value|\d+|-/g, ' ');
      if (slot.kind === 'email') addEmail(c, slot.parts.value, label);
      if (slot.kind === 'phone') addPhone(c, slot.parts.value, label);
      if (slot.kind === 'website') addUrl(c, slot.parts.value, slot.parts.label || '');
      if (slot.kind === 'address') {
        const p = slot.parts;
        const formatted = p.formatted || [p['po box'], p.street, [p.city, p.state || p.region, p.postal || p.zip].filter(Boolean).join(' '), p.country].filter(Boolean).join(', ');
        addAddress(c, formatted, p.label || slot.label);
      }
    }
    const done = finish(c);
    if (done) out.push(done);
  }
  return out;
}

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (rows) => `${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;

const GOOGLE_LABELS = { mobile: 'Mobile', home: 'Home', work: 'Work', main: 'Main', other: 'Other', fax: 'Other Fax', 'work fax': 'Work Fax', 'home fax': 'Home Fax' };
const glabel = (l) => GOOGLE_LABELS[l] || (l ? l[0].toUpperCase() + l.slice(1) : '');

// Google Contacts' own CSV layout (contacts.google.com → Import reads it back with every field).
export function toGoogleCSV(contacts) {
  const n = (key) => Math.max(1, ...contacts.map((c) => (c[key] || []).length));
  const counts = { emails: n('emails'), phones: n('phones'), addresses: n('addresses'), sites: Math.max(1, ...contacts.map((c) => (c.websites || []).length + (c.socials || []).length)) };
  const header = ['First Name', 'Middle Name', 'Last Name', 'Nickname', 'Organization Name', 'Organization Title', 'Birthday', 'Notes', 'Labels'];
  for (let i = 1; i <= counts.emails; i += 1) header.push(`E-mail ${i} - Label`, `E-mail ${i} - Value`);
  for (let i = 1; i <= counts.phones; i += 1) header.push(`Phone ${i} - Label`, `Phone ${i} - Value`);
  for (let i = 1; i <= counts.addresses; i += 1) header.push(`Address ${i} - Label`, `Address ${i} - Formatted`);
  for (let i = 1; i <= counts.sites; i += 1) header.push(`Website ${i} - Label`, `Website ${i} - Value`);
  const rows = contacts.map((c) => {
    const [given, family] = c.given || c.family ? [c.given, c.family] : splitName(c.name);
    const row = [given, '', family, c.nickname, c.company, c.title, c.birthday, c.notes, ['* myContacts', ...(c.favorite ? ['* starred'] : []), ...(c.tags || [])].join(' ::: ')];
    const pad = (list, count, fn) => { for (let i = 0; i < count; i += 1) row.push(...(list[i] ? fn(list[i]) : ['', ''])); };
    pad(c.emails || [], counts.emails, (e) => [glabel(e.label), e.value]);
    pad(c.phones || [], counts.phones, (p) => [glabel(p.label), p.value]);
    pad(c.addresses || [], counts.addresses, (a) => [glabel(a.label), a.value]);
    pad([...(c.websites || []).map((u) => ['', u]), ...(c.socials || []).map((s) => [SOCIAL_NETWORKS[s.network]?.label || 'Profile', socialUrl(s) || s.value])], counts.sites, (pair) => pair);
    return row;
  });
  return csv([header, ...rows]);
}

// Outlook / Microsoft 365 / Hotmail "Import contacts" CSV.
export function toOutlookCSV(contacts) {
  const header = ['First Name', 'Middle Name', 'Last Name', 'Nickname', 'Company', 'Job Title', 'E-mail Address', 'E-mail 2 Address', 'E-mail 3 Address', 'Mobile Phone', 'Home Phone', 'Business Phone', 'Other Phone', 'Business Fax', 'Home Address', 'Business Address', 'Other Address', 'Web Page', 'Birthday', 'Notes', 'Categories'];
  const rows = contacts.map((c) => {
    const [given, family] = c.given || c.family ? [c.given, c.family] : splitName(c.name);
    const phones = { mobile: [], home: [], work: [], other: [], 'work fax': [] };
    for (const p of c.phones || []) (phones[p.label] || (p.label === 'fax' ? phones['work fax'] : phones.mobile.length ? phones.other : phones.mobile)).push(p.value);
    const addr = (label) => (c.addresses || []).find((a) => a.label === label)?.value || '';
    const otherAddr = (c.addresses || []).find((a) => a.label !== 'home' && a.label !== 'work')?.value || '';
    const extra = (c.socials || []).map((s) => `${SOCIAL_NETWORKS[s.network]?.label || s.network}: ${socialUrl(s) || s.value}`);
    const bday = /^\d{4}-\d{2}-\d{2}$/.test(c.birthday || '') ? `${Number(c.birthday.slice(5, 7))}/${Number(c.birthday.slice(8, 10))}/${c.birthday.slice(0, 4)}` : '';
    return [
      given, '', family, c.nickname, c.company, c.title,
      c.emails?.[0]?.value, c.emails?.[1]?.value, c.emails?.[2]?.value,
      phones.mobile.join(' / '), phones.home.join(' / '), phones.work.join(' / '), phones.other.join(' / '), phones['work fax'].join(' / '),
      addr('home'), addr('work'), otherAddr, (c.websites || [])[0] || '', bday,
      [c.notes, ...extra].filter(Boolean).join('\n'), (c.tags || []).join(';'),
    ];
  });
  return csv([header, ...rows]);
}

// ------------------------------------------------------------------ JSON

const PHONE_KEYS = /^(phone|phone ?number|phone_number|mobile|tel|telephone|cell|contact_point|whatsapp|phones|phone numbers)$/i;
const EMAIL_KEYS = /^(email|e-mail|email ?address|emails|email addresses|mail)$/i;
const NAME_KEYS = /^(name|full_?name|display_?name|title|username|contact name)$/i;

// Facebook's newer exports wrap fields as { label_values: [{ label, value | vec | dict }] }.
function flattenLabelValues(obj) {
  if (!Array.isArray(obj?.label_values)) return obj;
  const out = { ...obj };
  for (const lv of obj.label_values) {
    if (!lv?.label) continue;
    out[lv.label] = lv.value ?? (Array.isArray(lv.vec) ? lv.vec.map((x) => x?.value ?? x) : lv.dict ? flattenLabelValues({ label_values: lv.dict }) : lv.href);
  }
  return out;
}

function jsonToContact(raw, source) {
  const obj = flattenLabelValues(raw);
  const c = blank(source);
  const values = (v) => (Array.isArray(v) ? v : [v]).flatMap((x) => (x && typeof x === 'object' ? [x.value ?? x.number ?? x.address ?? x.href ?? ''] : [x])).map((x) => fixMojibake(String(x ?? '')));
  for (const [key, v] of Object.entries(obj)) {
    if (v == null || v === '') continue;
    if (/^(first_?name|given_?name|givenName)$/i.test(key)) c.given = fixMojibake(clean(v));
    else if (/^(last_?name|family_?name|familyName|surname)$/i.test(key)) c.family = fixMojibake(clean(v));
    else if (NAME_KEYS.test(key) && typeof v === 'string' && !c.name) c.name = fixMojibake(v);
    else if (EMAIL_KEYS.test(key)) for (const x of values(v)) addEmail(c, x);
    else if (PHONE_KEYS.test(key)) {
      for (const x of values(v)) {
        if (EMAIL_RE.test(x.trim())) addEmail(c, x);
        else addPhone(c, x, /whatsapp/i.test(key) ? 'whatsapp' : '');
      }
    } else if (/^(company|organization|org)$/i.test(key) && typeof v === 'string') c.company = fixMojibake(clean(v));
    else if (/^(job_?title|position)$/i.test(key) && typeof v === 'string') c.title = fixMojibake(clean(v));
    else if (/^(notes?|about|bio)$/i.test(key) && typeof v === 'string') c.notes = fixMojibake(v);
    else if (/^(birthday|bday|date_of_birth)$/i.test(key)) c.birthday = normalizeBirthday(v);
    else if (/^(href|url|profile_?url|link|uri)$/i.test(key) && typeof v === 'string') addUrl(c, v);
    else if (key === 'string_list_data' && Array.isArray(v)) {
      // Instagram followers / following: [{ href, value: username }]
      for (const item of v) {
        if (item?.href) addSocial(c, networkOfUrl(item.href) || 'instagram', item.href);
        if (item?.value && !c.name) c.name = item.value;
      }
    }
  }
  if (c.socials.length === 1 && c.socials[0].network === 'instagram' && source === 'json') c.source = 'instagram';
  return finish(c);
}

const looksLikeContact = (obj) => {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const flat = flattenLabelValues(obj);
  const keys = Object.keys(flat);
  const hasName = keys.some((k) => NAME_KEYS.test(k) || /first_?name|given_?name|last_?name|family_?name/i.test(k)) || Array.isArray(flat.string_list_data);
  const hasReach = keys.some((k) => PHONE_KEYS.test(k) || EMAIL_KEYS.test(k));
  // Lists of names alone (Facebook friends) count, but not containers of further lists.
  const nested = Object.entries(flat).some(([k, v]) => k !== 'label_values' && Array.isArray(v) && v.some((x) => x && typeof x === 'object' && !('value' in x) && !('href' in x)));
  return (hasName || hasReach) && !nested;
};

export function parseJSON(text, source = 'json') {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (data?.format === 'lyrsoft-contacts' && Array.isArray(data.contacts)) {
    return data.contacts.map((c) => finish({ ...blank(c.source || 'lyrsoft'), ...c })).filter(Boolean);
  }
  // Google People API: { connections: [person] }
  if (Array.isArray(data?.connections) || Array.isArray(data?.otherContacts)) return [...(data.connections || []), ...(data.otherContacts || [])].map(fromGooglePerson).filter(Boolean);
  // Facebook: { friends_v2: [...] } (names only); Telegram: { contacts: { list: [...] } }; anything else, by walking it.
  if (/friends/.test(Object.keys(data || {}).join(' ')) && source === 'json') source = 'facebook';
  // Telegram's result.json also holds chats; only its contact list is wanted.
  if (Array.isArray(data?.contacts?.list)) return data.contacts.list.map((x) => jsonToContact(x, 'telegram')).filter(Boolean);
  const out = [];
  const seen = new Set();
  const walk = (node, depth) => {
    if (depth > 8 || out.length >= 20000) return;
    if (Array.isArray(node)) return node.forEach((x) => walk(x, depth + 1));
    if (!node || typeof node !== 'object') return;
    if (looksLikeContact(node)) {
      const c = jsonToContact(node, source);
      const key = c && JSON.stringify([c.name, c.emails, c.phones, c.socials]);
      if (c && !seen.has(key)) {
        seen.add(key);
        out.push(c);
      }
      return;
    }
    Object.values(node).forEach((x) => walk(x, depth + 1));
  };
  walk(data, 0);
  return out;
}

export const toLyrsoftJSON = (contacts) =>
  JSON.stringify({ format: 'lyrsoft-contacts', version: 1, exportedAt: new Date().toISOString(), contacts: contacts.map(({ id, createdAt, updatedAt, ...c }) => c) }, null, 2);

// ------------------------------------------------------------------ Google People API and the phone

export function fromGooglePerson(person) {
  const c = blank('google');
  const pick = (list) => (list || []).find((x) => x.metadata?.primary) || (list || [])[0];
  const name = pick(person.names);
  c.name = name?.displayName || '';
  c.given = name?.givenName || '';
  c.family = name?.familyName || '';
  c.nickname = pick(person.nicknames)?.value || '';
  const org = pick(person.organizations);
  c.company = org?.name || '';
  c.title = org?.title || '';
  for (const e of person.emailAddresses || []) addEmail(c, e.value, e.type || e.formattedType);
  for (const p of person.phoneNumbers || []) addPhone(c, p.value || p.canonicalForm, p.type || p.formattedType);
  for (const a of person.addresses || []) addAddress(c, a.formattedValue || [a.streetAddress, a.city, a.region, a.postalCode, a.country].filter(Boolean).join(', '), a.type);
  for (const u of person.urls || []) addUrl(c, u.value, u.type);
  for (const im of person.imClients || []) addSocial(c, networkOf(im.protocol || im.formattedProtocol) || 'other', im.username);
  const b = pick(person.birthdays)?.date;
  if (b?.month && b?.day) c.birthday = b.year ? `${b.year}-${String(b.month).padStart(2, '0')}-${String(b.day).padStart(2, '0')}` : `--${String(b.month).padStart(2, '0')}-${String(b.day).padStart(2, '0')}`;
  c.notes = pick(person.biographies)?.value || '';
  return finish(c);
}

// The phone's own contacts, from the Contact Picker API (Chrome on Android).
export function fromDeviceContact(entry) {
  const c = blank('device');
  c.name = (entry.name || [])[0] || '';
  for (const e of entry.email || []) addEmail(c, e);
  for (const t of entry.tel || []) addPhone(c, t);
  for (const a of entry.address || []) addAddress(c, [...(a.addressLine || []), [a.city, a.region, a.postalCode].filter(Boolean).join(' '), a.country].filter(Boolean).join(', '));
  return finish(c);
}

// ------------------------------------------------------------------ any file

// Picks the parser from the file name and content. Returns { contacts, format }.
export function parseContactsFile(name, text) {
  const lower = String(name || '').toLowerCase();
  const head = text.slice(0, 2000).replace(/^\ufeff/, '').trimStart();
  if (/BEGIN:VCARD/i.test(head) || /\.(vcf|vcard)$/.test(lower)) return { contacts: parseVCard(text, lower.includes('icloud') ? 'icloud' : 'vcard'), format: 'vCard' };
  if (head.startsWith('{') || head.startsWith('[') || lower.endsWith('.json')) {
    const source = /follow/.test(lower) ? 'instagram' : /friend|uploaded_contacts|messenger/.test(lower) ? 'facebook' : /telegram|result\.json/.test(lower) ? 'telegram' : 'json';
    return { contacts: parseJSON(text, source), format: 'JSON' };
  }
  const source = /google/.test(lower) ? 'google' : /outlook|microsoft|hotmail/.test(lower) ? 'outlook' : /yahoo/.test(lower) ? 'yahoo' : 'csv';
  return { contacts: parseCSV(text, source), format: 'CSV' };
}
