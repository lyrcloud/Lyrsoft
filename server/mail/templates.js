// Every email Lyrsoft sends is built here: a plain-text body plus an HTML version in the shared layout.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const paragraphs = (text) => esc(text).split(/\n{2,}/).map((p) => `<p style="margin:0 0 16px">${p.replace(/\n/g, '<br>')}</p>`).join('');

function layout({ heading, bodyHtml, action }) {
  const button = action
    ? `<p style="margin:24px 0"><a href="${esc(action.url)}" style="background:#5034ff;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">${esc(action.label)}</a></p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f3f4f8;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#1f2330">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:14px;overflow:hidden">
<tr><td style="background:#14123a;padding:20px 28px;color:#fff;font-size:20px;font-weight:700;letter-spacing:.3px">Lyrsoft</td></tr>
<tr><td style="padding:28px;font-size:15px;line-height:1.6">
<h1 style="font-size:20px;margin:0 0 16px">${esc(heading)}</h1>${bodyHtml}${button}
</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #eceef4;font-size:12px;color:#7a7f93">Lyrsoft · Software development · www.lyrsoft.com</td></tr>
</table></td></tr></table></body></html>`;
}

function build({ subject, heading = subject, text, action }) {
  const fullText = action ? `${text}\n\n${action.label}: ${action.url}\n` : `${text}\n`;
  return { subject, text: `${fullText}\n— Lyrsoft · www.lyrsoft.com`, html: layout({ heading, bodyHtml: paragraphs(text), action }) };
}

export const templates = {
  invite: ({ name, inviter, role, url }) => build({
    subject: `${inviter} invited you to Lyrsoft Hub`,
    heading: 'Welcome to Lyrsoft Hub',
    text: `Hi ${name},\n\n${inviter} added you to Lyrsoft Hub as ${role}. Set your password to get started. This link is valid for 7 days.`,
    action: { label: 'Set your password', url },
  }),

  super_admin_setup: ({ url }) => build({
    subject: 'Set up your Lyrsoft super admin account',
    heading: 'Your super admin account is ready',
    text: 'Lyrsoft Hub was started and this address is its super admin. Choose a password to sign in. This link is valid for 7 days.',
    action: { label: 'Choose a password', url },
  }),

  password_reset: ({ name, url }) => build({
    subject: 'Reset your Lyrsoft Hub password',
    text: `Hi ${name},\n\nSomeone asked to reset the password for this account. If that was you, use the link below within 1 hour. Otherwise you can ignore this email.`,
    action: { label: 'Reset password', url },
  }),

  contact_receipt: ({ name }) => build({
    subject: 'We got your message — Lyrsoft',
    heading: `Thanks, ${name}`,
    text: 'Your message reached the Lyrsoft team. Someone will reply within one business day.\n\nIf anything changes in the meantime, just reply to this email.',
  }),

  lead_notification: ({ name, email, company, service, budget, message, url }) => build({
    subject: `New lead: ${name}${company ? ` (${company})` : ''}`,
    text: `Name: ${name}\nEmail: ${email}\nCompany: ${company || '-'}\nService: ${service || '-'}\nBudget: ${budget || '-'}\n\n${message}`,
    action: { label: 'Open in Lyrsoft Hub', url },
  }),

  item_assigned: ({ name, actor, item, board, url }) => build({
    subject: `${actor} assigned you "${item}"`,
    text: `Hi ${name},\n\n${actor} assigned you to "${item}" on the ${board} board.`,
    action: { label: 'Open item', url },
  }),

  item_update: ({ name, actor, item, board, body, url }) => build({
    subject: `${actor} commented on "${item}"`,
    text: `Hi ${name},\n\n${actor} posted an update on "${item}" (${board}):\n\n${body}`,
    action: { label: 'Reply in Lyrsoft Hub', url },
  }),

  test: () => build({
    subject: 'Lyrsoft Mail test message',
    text: 'This is a test message from Lyrsoft Mail. If you can read it, delivery works.',
  }),

  custom: ({ subject, body }) => build({ subject, text: body }),
};

export function render(key, vars) {
  const fn = templates[key];
  if (!fn) throw new Error(`Unknown email template: ${key}`);
  return fn(vars);
}
