# Lyrsoft

The www.lyrsoft.com web app. One Node.js server runs three things:

| Part | URL | What it is |
|---|---|---|
| **Website** | `/` | Public company site: services, process, products, contact form |
| **Lyrsoft Hub** | `/hub/` | Work platform in the style of monday.com: boards, groups, items, status/person/date columns, table and kanban views, item updates, activity feed, search, team and client accounts |
| **Lyrsoft Mail** | `/hub/#/mail` | Email delivery system used by everything above: queue, retries with backoff, delivery log with per-message timeline, compose/broadcast, suppression list |

The **super admin is `lyrclouds@gmail.com`** (set by `SUPER_ADMIN_EMAIL`). That account is created on first start, always kept as super admin, and cannot be demoted, deactivated or edited by anyone else. Only the super admin can create or manage admins.

## Run it

Requires Node.js 22.13+ (uses the built-in `node:sqlite`; the only npm dependencies are Express and Nodemailer).

```bash
npm install
cp .env.example .env      # adjust if needed
npm start                 # or: npm run dev (restarts on changes)
```

Open http://localhost:3000. On first start the console prints a **setup link** for the super admin (the same link is emailed to lyrclouds@gmail.com). Open it, choose a password, and you are in.

Lost the link or the password? `npm run admin-link` prints a fresh one.

```bash
npm test                  # integration tests: auth, roles, boards, contact form, mail queue
```

## How the pieces connect

- **Contact form → Hub.** Each website message becomes an item on the *Website leads* board (status *New*), the lead is emailed to the super admin with Reply-To set to the visitor, and the visitor gets a confirmation email.
- **Hub → Mail.** Invites, password resets, "you were assigned" and "new update on your item" notifications all go through the Lyrsoft Mail queue, so every one of them shows up in the delivery log.
- **Mail queue.** Messages are stored in SQLite and sent by a background worker. Failures retry after 1, 4, 16, 64… minutes (up to `MAIL_MAX_ATTEMPTS`); permanent SMTP rejections (5xx) fail immediately. Admins can retry, cancel, send tests, and suppress addresses.

## Roles

| Role | Can do |
|---|---|
| Super admin | Everything, including managing admins. Exactly one account. |
| Admin | Manage users (not admins), all boards, Lyrsoft Mail |
| Manager | Create boards; change any board's columns, groups and members |
| Member | Work on items in team boards and boards they belong to |
| Client | See only boards they are added to; can comment, not edit |

Boards are either **team** (all staff can see them) or **private** (members and admins only). Add a client to a board as a member to share it with them.

## Email delivery setup

Development defaults to `MAIL_TRANSPORT=log`: every message is written to `data/outbox/*.eml` and nobody is emailed.

To send for real set `MAIL_TRANSPORT=smtp` and the `SMTP_*` variables:

- **Gmail** (quick start): `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_USER=lyrclouds@gmail.com`, `SMTP_PASS=<app password>` (Google Account → Security → App passwords). Gmail rewrites the sender to the Gmail address, so set `MAIL_FROM="Lyrsoft <lyrclouds@gmail.com>"`.
- **Amazon SES / Postmark / Mailgun** (recommended for `no-reply@lyrsoft.com`): verify the lyrsoft.com domain with the provider, add its SPF and DKIM DNS records, then use its SMTP host and credentials. SES example: `SMTP_HOST=email-smtp.us-east-1.amazonaws.com`, `SMTP_PORT=465`.

## Deploying to www.lyrsoft.com

1. Run on a server with Node 22.13+: `NODE_ENV=production BASE_URL=https://www.lyrsoft.com npm start` (use systemd, pm2 or Docker to keep it running).
2. Put nginx or Caddy in front for HTTPS and proxy to `PORT`. `NODE_ENV=production` marks session cookies `Secure`, so HTTPS is required.
3. Point the `lyrsoft.com` / `www.lyrsoft.com` DNS records at the server.
4. Back up `data/lyrsoft.db` (SQLite, WAL mode) regularly.

## Layout

```
server/
  index.js          start: bootstrap, mail worker, HTTP server
  app.js            Express app, security headers, routes
  config.js         environment settings
  db.js             SQLite schema and helpers
  auth.js           passwords (scrypt), sessions, CSRF guard, one-time tokens
  bootstrap.js      super admin + default boards
  boards.js         board templates, permissions, column value rules
  admin-link.js     `npm run admin-link`
  mail/             templates.js · transport.js (SMTP / log) · queue.js (queue + worker)
  routes/           auth · users · boards (boards, items, dashboard, search) · mail · public (contact form)
public/
  index.html, css/, js/   website
  hub/                    Lyrsoft Hub single-page app (no build step)
test/app.test.js
```
