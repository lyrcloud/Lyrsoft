// Website enquiries from the lyrsoft.com contact form: validation, the "Website leads" board
// template and the message filed into the Lyrsoft Mail inbox. Pure functions (see leads.test.mjs).
import { EMAIL_RE, ValidationError } from './model.mjs';

export const CONTACT_LIMIT_PER_HOUR = 5;

const text = (value, max) => String(value ?? '').trim().slice(0, max);
const fail = (message) => {
  throw new ValidationError(message);
};

export const SERVICES = ['Web application', 'Mobile app', 'Cloud & DevOps', 'AI integration', 'UI/UX design', 'Support & maintenance'];
export const BUDGETS = ['Under $10k', '$10k – $50k', '$50k – $150k', '$150k+'];

// Returns the cleaned enquiry, or null for a bot (the hidden "website" field is filled in).
export function cleanContact(body) {
  if (text(body?.website, 200)) return null;
  const contact = {
    name: text(body?.name, 100),
    email: text(body?.email, 254).toLowerCase(),
    company: text(body?.company, 120),
    service: SERVICES.includes(body?.service) ? body.service : '',
    budget: BUDGETS.includes(body?.budget) ? body.budget : '',
    message: text(body?.message, 5000),
  };
  if (!contact.name) fail('Please tell us your name.');
  if (!EMAIL_RE.test(contact.email)) fail('Please enter a valid email address.');
  if (contact.message.length < 10) fail('Please tell us a little more about your project.');
  return contact;
}

const status = (id, title, labels) => ({ id, title, type: 'status', labels: labels.map(([labelId, label, color]) => ({ id: labelId, label, color })) });

export function leadsBoard() {
  return {
    name: 'Website leads',
    description: 'Every message from the lyrsoft.com contact form. Reply from the hello@lyrsoft.com inbox in Mail.',
    columns: [
      status('stage', 'Stage', [
        ['new', 'New', '#579bfc'],
        ['contacted', 'Contacted', '#fdab3d'],
        ['proposal', 'Proposal sent', '#a25ddc'],
        ['won', 'Won', '#00c875'],
        ['lost', 'Lost', '#e2445c'],
      ]),
      { id: 'owner', title: 'Owner', type: 'person' },
      { id: 'email', title: 'Email', type: 'text' },
      { id: 'company', title: 'Company', type: 'text' },
      { id: 'service', title: 'Service', type: 'text' },
      { id: 'budget', title: 'Budget', type: 'text' },
      { id: 'followup', title: 'Follow up', type: 'date' },
      { id: 'message', title: 'Message', type: 'text' },
    ],
    groups: [
      { id: 'inbound', title: 'Inbound', color: '#579bfc' },
      { id: 'qualified', title: 'Qualified', color: '#a25ddc' },
      { id: 'closed', title: 'Closed', color: '#00c875' },
    ],
  };
}

export function leadValues(contact) {
  const values = { stage: 'new', email: contact.email, company: contact.company, service: contact.service, budget: contact.budget, message: contact.message.slice(0, 2000) };
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value));
}

export function contactSubject(contact) {
  return `Website enquiry from ${contact.name}${contact.company ? ` (${contact.company})` : ''}`;
}

export function contactText(contact, leadUrl) {
  const details = [
    ['Name', contact.name],
    ['Email', contact.email],
    ['Company', contact.company],
    ['Service', contact.service],
    ['Budget', contact.budget],
  ].filter(([, value]) => value);
  return [
    contact.message,
    '',
    '—',
    ...details.map(([label, value]) => `${label}: ${value}`),
    '',
    `Sent from the lyrsoft.com contact form. Lead: ${leadUrl}`,
  ].join('\n');
}
