// Contacts › Find on social: which social accounts go with a contact's email or phone number.
//
// Only sources where the person chose to make the link public are queried:
//   - Gravatar: the social accounts someone verified on their Gravatar profile (looked up by email hash),
//   - GitHub: accounts that show that email address publicly.
// Phone numbers are checked by opening WhatsApp, Telegram, Viber or Signal at the number, which shows
// whether they're on it as far as their own privacy settings allow. Everything else is a search link that
// opens the network's own search. Sign-up / password-reset probing ("is this email registered?") is
// deliberately not done: it breaks those services' terms and bypasses people's privacy choices.

import { SOCIAL_NETWORKS, networkOfUrl } from './contacts-formats.js';

const GRAVATAR_TYPES = { twitter: 'x', x: 'x', fb: 'facebook', bsky: 'bluesky' };

export async function sha256Hex(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

// Turns a Gravatar v3 profile into { name, avatar, profile, accounts: [{ network, value }] }.
export function fromGravatar(profile) {
  if (!profile || typeof profile !== 'object') return null;
  const accounts = (profile.verified_accounts || [])
    .filter((a) => a && !a.is_hidden && /^https?:\/\//i.test(a.url || ''))
    .map((a) => {
      const type = String(a.service_type || '').toLowerCase();
      const network = networkOfUrl(a.url) || GRAVATAR_TYPES[type] || (SOCIAL_NETWORKS[type] ? type : 'other');
      return { network, value: a.url, label: a.service_label || SOCIAL_NETWORKS[network]?.label || type };
    });
  return { name: profile.display_name || '', avatar: profile.avatar_url || '', profile: profile.profile_url || '', accounts };
}

export async function gravatarLookup(email, fetchFn = fetch) {
  const hash = await sha256Hex(normalizeEmail(email));
  const res = await fetchFn(`https://api.gravatar.com/v3/profiles/${hash}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Gravatar ${res.status}`);
  return fromGravatar(await res.json());
}

export async function githubLookup(email, fetchFn = fetch) {
  const res = await fetchFn(`https://api.github.com/search/users?q=${encodeURIComponent(`${normalizeEmail(email)} in:email`)}&per_page=5`, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(res.status === 403 ? 'GitHub search limit reached; try again in a minute' : `GitHub ${res.status}`);
  const { items = [] } = await res.json();
  return items.map((u) => ({ network: 'github', value: u.html_url, label: `GitHub · ${u.login}`, avatar: u.avatar_url }));
}

// Comparable key for a profile, so the same account isn't suggested twice or re-added.
export function profileKey({ network, value }) {
  const v = String(value || '').trim().toLowerCase().replace(/^https?:\/\/(www\.|m\.)?/, '').replace(/\/+$/, '');
  const handle = v.includes('/') ? v.split(/[?#]/)[0].split('/').filter(Boolean).pop() : v;
  return `${network}:${String(handle || '').replace(/^@/, '')}`;
}

export function newAccounts(contact, found) {
  const seen = new Set((contact.socials || []).map(profileKey));
  return found.filter((a) => {
    const key = profileKey(a);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Every source for one contact: { found: [account], sources: [{ source, email, ok, error?, name?, avatar? }] }.
export async function findAccounts(contact, fetchFn = fetch) {
  const emails = [...new Set((contact.emails || []).map((e) => normalizeEmail(e.value)).filter(Boolean))].slice(0, 5);
  const jobs = emails.flatMap((email) => [
    gravatarLookup(email, fetchFn).then((g) => ({ source: 'Gravatar', email, ok: true, name: g?.name, avatar: g?.avatar, profile: g?.profile, accounts: g?.accounts || [] })),
    githubLookup(email, fetchFn).then((accounts) => ({ source: 'GitHub', email, ok: true, accounts })),
  ].map((p, i) => p.catch((error) => ({ source: i ? 'GitHub' : 'Gravatar', email, ok: false, error: error.message, accounts: [] }))));
  const sources = await Promise.all(jobs);
  return { sources, found: newAccounts(contact, sources.flatMap((s) => s.accounts.map((a) => ({ ...a, via: `${s.source} (${s.email})` })))) };
}

// Opening these at the number shows whether the person uses the app (within their privacy settings).
export function phoneChecks(phone) {
  const digits = String(phone || '').replace(/[^\d+]/g, '').replace(/^00/, '+').replace(/^\+/, '');
  if (digits.length < 7) return [];
  return [
    { network: 'whatsapp', href: `https://wa.me/${digits}` },
    { network: 'telegram', href: `https://t.me/+${digits}` },
    { network: 'viber', href: `viber://chat?number=%2B${digits}` },
    { network: 'signal', href: `https://signal.me/#p/+${digits}` },
  ];
}

// Each network's own search, filled in with what we know about the contact.
export function searchLinks(contact) {
  const name = String(contact.name || '').trim();
  const email = contact.emails?.[0]?.value || '';
  const phone = contact.phones?.[0]?.value || '';
  const q = encodeURIComponent;
  const google = (site, term) => `https://www.google.com/search?q=${q(`site:${site} "${term}"`)}`;
  const links = [];
  if (name) {
    links.push(
      { network: 'facebook', href: `https://www.facebook.com/search/people/?q=${q(name)}` },
      { network: 'instagram', href: google('instagram.com', name) },
      { network: 'linkedin', href: `https://www.linkedin.com/search/results/people/?keywords=${q([name, contact.company].filter(Boolean).join(' '))}` },
      { network: 'x', href: `https://x.com/search?q=${q(name)}&f=user` },
      { network: 'tiktok', href: `https://www.tiktok.com/search/user?q=${q(name)}` },
      { network: 'threads', href: `https://www.threads.net/search?q=${q(name)}&serp_type=people` },
      { network: 'youtube', href: `https://www.youtube.com/results?search_query=${q(name)}&sp=EgIQAg%253D%253D` },
      { network: 'bluesky', href: `https://bsky.app/search?q=${q(name)}` },
      { network: 'pinterest', href: `https://www.pinterest.com/search/users/?q=${q(name)}` },
      { network: 'reddit', href: `https://www.reddit.com/search/?q=${q(name)}&type=user` },
    );
  }
  if (email) links.push({ network: 'github', href: `https://github.com/search?q=${q(email)}&type=users`, by: email });
  for (const term of [email, phone].filter(Boolean)) links.push({ network: 'other', label: 'Google', href: `https://www.google.com/search?q=${q(`"${term}"`)}`, by: term });
  return links.map((l) => ({ ...l, label: l.label || SOCIAL_NETWORKS[l.network]?.label || l.network, by: l.by || name }));
}
