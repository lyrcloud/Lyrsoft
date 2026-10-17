# Lyrsoft

Everything behind **https://lyrsoft.com**:

- **Website** (`/`): the company site; its contact form files each message as a lead in Lyrsoft Work and emails it to hello@lyrsoft.com.
- **Lyrsoft Work** (`/app/`): workspaces, boards and items.
- **Lyrsoft Mail**: shared inboxes (support@, hello@ …) for every mail domain, received and sent through Amazon SES.
- **Lyrbot**: the website's help assistant, as on Lyrshop and Lyrtrip. A robot button opens a chat answered by Claude (`api/work/lyrbot.mjs`) from the facts in its prompt, with WhatsApp and email for a person. Capped at 20 questions per visitor per hour and 1,500 per day for the whole site. It uses the Anthropic API key in the `lyrshop/anthropic` secret (stack parameter `AnthropicSecretName`; blank turns it off).

Sign-in uses the Lyrcloud Cognito user pool (Google). The super admin is **lyrclouds@gmail.com** (stack parameter `SuperAdminEmail`); it is never stored, but derived on every request from a Google sign-in with that email.

## Layout

```
lyrsoft/            website (home.html), app (index.html, app.js, mail.js), sign-in callback
src/auth.js         Cognito Hosted UI helpers (copy of Lyrcloud's src/auth.js)
api/work/           work API Lambda: workspaces, boards, items, contact form, Lyrbot, mail routes
api/mail/           mail model, store, routes and the SES inbound processor
api/account/        roles.mjs: super admin / admin rules (copy of Lyrcloud's)
infra/aws/          lyrsoft-work-api.yml (API, DynamoDB, SES) and lyrsoft-site.yml (S3 + CloudFront)
scripts/            build, deploy, local dev server and local API
```

The Lyrcloud repo (github.com/lyrcloud/Lyrcloud) still owns the shared pieces: the Cognito user pool, the account API (`/me`, user roles) and lyrcloud.com. `src/auth.js` and `api/account/roles.mjs` are copies; keep them in step with Lyrcloud.

## Develop

Requires Node 22 or newer.

```bash
npm install
npm test
npm run api    # local work API on http://localhost:8787 (in-memory data, fake AWS)
npm run dev    # site and app on http://localhost:5174
```

Sign in locally with http://localhost:5174/?dev-login=lyrclouds@gmail.com (super admin) or any other email. Lyrbot answers locally only when `ANTHROPIC_API_KEY` is set for `npm run api`; otherwise it shows its contact fallback.

## Deploy

```bash
npm run deploy
```

`scripts/deploy-lyrsoft.sh` runs the tests, ships the work API and inbound mail Lambdas (stack `lyrsoft-work-api`), checks SES identities and prints any missing DNS records, then builds the site and uploads it to the `lyrsoft-site` stack (S3 + CloudFront). It needs AWS credentials for account 479664683751, us-east-1. DNS for lyrsoft.com is on Cloudflare.
