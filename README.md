# Lyrsoft

Everything behind **https://lyrsoft.com**:

- **Website** (`/`): the company site; its contact form files each message as a lead in Lyrsoft Work and emails it to hello@lyrsoft.com.
- **Lyrsoft Work** (`/app/`): workspaces, boards and items.
- **Lyrsoft Mail**: opens as one window with a tab per mailbox (photo, name, unread count) and a Manage tab for the super admin. Each mailbox has a profile its members can edit: photo, display name, colour, description and a signature added to every email sent from it (`PATCH /mail/mailboxes/{address}/profile`). Shared inboxes (support@, hello@ …) for every mail domain, received and sent through Amazon SES. Folders: Inbox, Closed, Spam (mail that fails SES spam checks) and Trash; Delete moves to Trash, where conversations can be restored, and Delete forever / Empty trash / Empty spam remove them and their stored files for good. Tick conversations to act on many at once.
- **Lyrbot**: the website's help assistant, as on Lyrshop and Lyrtrip. A robot button opens a chat answered by Claude (`api/work/lyrbot.mjs`) from the facts in its prompt, with WhatsApp and email for a person. Capped at 20 questions per visitor per hour and 1,500 per day for the whole site. It uses the Anthropic API key in the `lyrshop/anthropic` secret (stack parameter `AnthropicSecretName`; blank turns it off).

Sign-in uses the Lyrcloud Cognito user pool: **Google**, or an **email and password** (`lyrsoft/signin.js`, `src/cognito.js`) confirmed with a 6-digit code that Cognito emails (sent from no-reply@lyrcloud.com, since the pool is shared). GitHub sign-ins are refused because GitHub emails aren't proof of ownership. The super admin is **lyrclouds@gmail.com** (stack parameter `SuperAdminEmail`); it is never stored, but derived on every request from a Google sign-in with that email, whatever case Cognito gives the provider name.

## Messages and meetings

- **Messages** (`/app/#/chat`, `lyrsoft/chat.js`, API in `api/work/collab.mjs`): **groups** (a name and any people you share a workspace with; members can add people, rename or leave), **direct messages** with one person, and a **team channel** for every workspace. Staff can add or message anyone. Messenger-style: replies, reactions (👍 ❤️ 😂 😮 😢 🙏), edit and unsend, photos and files up to 25 MB (uploaded straight to the mail bucket under `chat/<conversation>/` with signed URLs; unsending deletes them), emoji, "typing…", "Seen" and "Active now". The conversation itself is `lyrsoft/conversation.js`, shared with the call's chat panel. The open conversation polls every 4 seconds; the sidebar badge every 30.
- **Meetings** (`/app/#/meetings`, `lyrsoft/meet.js`): schedule a video meeting and email the invitations (time shown in the host's time zone, with a Join link to `/app/#/meet/<id>`), start an instant call, or call everyone in a conversation from Messages. The host (or staff) can invite more people or cancel. Inviting uses `lyrsoft/people.js`: a pop-up that searches everyone you share a workspace with and accepts any typed email, and, in the schedule form, suggestions as you type with chosen people as chips. The call's Invite button opens the same pop-up for the host.
- **Meeting chat:** every meeting has a conversation: the one it was started from, or a group of the host and invitees made with it (listed in Messages as “📹 <title>”). The call has a 💬 Chat panel with it, counting new messages while closed.
- **Calls** run on **Amazon Chime SDK**: joining creates the Chime meeting on first use and an attendee per person (about $0.0017 per attendee-minute). Mute, camera (front first; **Flip** switches between front and rear on phones), screen sharing, invite link and leave. The browser SDK is bundled into `lyrsoft/chime-sdk.js` by `scripts/build-chime-sdk.mjs` and only loads when someone joins.
- **Recording** happens in the browser: it records the screen, window or tab you pick, with your microphone and the call's audio, and saves a .webm file to your downloads. Nothing is uploaded. It needs Chrome, Edge or Firefox on a computer; phone browsers can't capture the screen.

## Lyr Chat

**Lyr Chat** (`https://lyrsoft.com/chat/`, `lyrsoft/lyrchat.js`) is a phone-first messaging app on the same accounts and conversations as Messages: chats, groups, voice and video calls that ring, voice messages, a Calls tab and push notifications. It installs to the home screen (`/brand/lyrchat.webmanifest`).

- **Anyone on Lyrsoft:** start a chat by email, or by the mobile number someone verified (`POST /chat/dm` with `{ phone }`, 60 number lookups per person per day), from your co-workers or from your Lyrsoft Contacts. Someone outside your workspaces gets a **message request**: they see it under Message requests and Accept, Delete, Block or Report. Replying also accepts. A person found by number never has their email shown to the sender until they accept (`maskJson` in `api/work/lyrchat-model.mjs`). People start at most 30 chats with strangers a day.
- **Contacts tab:** your Lyrsoft Contacts appear in Lyr Chat automatically. Everyone on Lyrsoft comes first, matched by an email that has an account or by a mobile number they verified (`GET /chat/address-book`, `matchAddressBook` in `api/work/lyrchat-model.mjs`), with 💬 📞 📹 buttons. Everyone else gets an Invite button (WhatsApp, SMS, email or share). `POST /chat/dm { contactId }` opens the chat. Phone matches never reveal the account's email. Results are cached for 6 hours or until the book changes (`CHATBOOK#<userId>`), and at most 20,000 numbers are matched per person per day (`RATE#chatsync#`), so importing contacts can't be used to sweep numbers.
- **Block and report:** blocking stops someone's messages and calls in your DM. Reporting also blocks them and emails their recent messages to the super admin (`REPORT#` rows). Settings lists blocked people.
- **Calls:** 📞 and 📹 in a DM or group create a `CALL#<id>` record and a meeting on the same Chime call room as Meetings (`lyrsoft/meet.js`). Everyone else is rung: in the open app (`GET /calls/ringing`, polled every 3 s, with a ringtone and vibration) and by push. Calls ring for 45 seconds. A DM call leaves "Missed voice call", "Voice call declined" or "Video call · 2:31" in the chat; a group call leaves a Join button. The Calls tab is `GET /calls` (90 days). Calls need an accepted chat.
- **Speaker:** 🔊 in the call controls (Lyr Chat and Meetings). Where the browser can choose the audio output and lists a loudspeaker (Chrome, Edge, some Android phones), it switches the call to it and back. Otherwise (iPhone, most phones) it makes the call louder through Web Audio, with a gain and a limiter.
- **Elsewhere:** Lyrsoft Work's sidebar links to Lyr Chat under Communicate. Lyrbot on the website knows about Lyr Chat, has a “What is Lyr Chat?” quick question and a 💬 Lyr Chat link.
- **Voice messages:** 🎙 in any conversation (Lyr Chat and Messages) records with MediaRecorder and sends the clip as an audio attachment, played inline.
- **Push notifications:** Web Push through the service worker `lyrsoft/lyrchat-sw.js`, served unhashed at `/chat/sw.js`. The VAPID keys are derived from the `lyrsoft/app` secret (`vapidKeysFrom`), so there's nothing extra to store. Subscriptions are `PUSH#<email>` rows, at most 10 devices each (`api/work/push.mjs`). New messages in DMs and groups notify everyone else; calls notify with Answer and Decline. Decline works from the notification without opening the app, through `POST /public/call` with a per-call token. While the app is on screen, pushes go to it instead. On iPhone and iPad, notifications need the app added to the home screen (iOS 16.4+).
- **Sign-in** is remembered on the device (`localStorage`, unlike Lyrsoft Work's per-tab session), so the installed app opens signed in. Signing out clears it and the device's push subscription.

## Contacts

- **Contacts** (`/app/#/contacts`, `lyrsoft/contacts.js`, API in `api/work/contacts.mjs`): everyone's own private address book (up to 10,000 contacts): names, phones, emails, social profiles (WhatsApp, Facebook, Messenger, Instagram, X, LinkedIn, Telegram, TikTok, YouTube …), addresses, websites, birthday, labels, notes and favourites. Call, text, WhatsApp or email from a contact, or reach them inside Lyrsoft: **Lyr Chat** opens a direct message (offering to add them to one of your workspaces first if you don’t share one) and **Meeting** starts a video call now or schedules one. Both work with an email or a **phone number**: a number finds the Lyrsoft account that verified it as its mobile (`POST /people/phone`, 60 lookups per person per day; a non-co-worker's email is never revealed), and people not on Lyrsoft get an invitation or the meeting's **guest link** by WhatsApp or SMS from your phone. A guest link (`#/meet/<id>?k=<key>`, shown to hosts) lets anyone who signs in join; search by name, number, email or label; filter by label or where contacts came from; select many to export, label or delete.
- **Apps:** a one-tap button for every social profile on a contact opens a chat where the app allows it (Instagram and Facebook/Messenger DMs, Telegram, Viber, Signal, Skype, Reddit messages, Snapchat and LINE adds) or their profile (X, Threads, LinkedIn, TikTok, YouTube, Pinterest, Twitch, Bluesky, GitHub); apps that can't be opened at a person (WeChat, KakaoTalk, imo, Discord names) copy the ID and open the app. **＋ Apps** reaches the phone number on Telegram, Viber and Signal, and adds a profile on any of 26 networks. **Google Meet** starts a meeting (meet.google.com/new) and sends its link by email, WhatsApp or SMS, or opens a Google Calendar event with the contact invited (Calendar adds the Meet link); **Teams** opens a chat, audio or video call, or a new-meeting form with the contact as attendee (needs their email). Both work through public links, so no Google or Microsoft account is connected to Lyrsoft.
- **Find on social** (`lyrsoft/contacts-find.js`): **🔎 Find** on a contact looks up the social accounts linked to their email, from sources where the person made the link public: the accounts they verified on **Gravatar** (looked up by SHA-256 of the email) and **GitHub** accounts showing that email. Each one can be added to the contact in one tap. A phone number opens WhatsApp, Telegram, Viber and Signal at that number, so the app shows whether they're on it (within their privacy settings). There are also people-search links for Facebook, Instagram, LinkedIn, X, TikTok, Threads, YouTube, Bluesky, Pinterest, Reddit, GitHub and Google, and a paste-a-profile-link box that detects the network. The lookups run in the browser. Sign-up and password-reset pages are deliberately never probed to test whether an email or number is registered.
- **Import:** this phone (the Contact Picker in Chrome on Android; elsewhere a .vcf from the phone's Contacts app), **Google** (straight from Google Contacts when `LYRSOFT_GOOGLE_CLIENT_ID` is set at build time, otherwise Google's vCard / CSV export), **Facebook / Messenger / Instagram** ("Download your information" JSON: friends, followers, uploaded contacts), **LinkedIn** (`Connections.csv`), Telegram (`result.json`), Outlook, iCloud, Yahoo, any vCard / CSV / JSON, and the people you work with in Lyrsoft. Files are read in the browser (`lyrsoft/contacts-formats.js`); people already in the book (same email or phone) get the new details added instead of a duplicate. **Merge duplicates** finds people sharing a phone, email or name.
- **Export:** vCard 3.0 (phones, Google, iCloud, Outlook), Google CSV, Outlook CSV or a Lyrsoft JSON backup, downloaded or sent through the phone's share sheet; one contact can be shared as a .vcf. WhatsApp, Telegram and Meta's apps read the phone's contacts, so contacts reach them through the phone.
- **Google import setup:** create an OAuth web client in Google Cloud with the People API enabled, add `https://lyrsoft.com` as an authorised JavaScript origin, and deploy with `LYRSOFT_GOOGLE_CLIENT_ID=<client id> npm run deploy`. The app asks only for read-only contacts access; the token stays in the browser.

## Marketing

**Lyrsoft Marketing** (`/app/#/w/<workspace>/marketing`, `lyrsoft/marketing.js`, API in `api/work/marketing.mjs`) gives every workspace email marketing:

- **Audience:** subscribers with tags and a status (subscribed, unsubscribed, bounced, marked as spam), up to 50,000 per workspace. Add people one by one, paste a list, import a CSV / vCard / JSON file (Mailchimp, Google, Outlook, spreadsheets), bring in your Contacts or the workspace team, and export CSV. Imports never resubscribe someone who left.
- **Signup forms:** each form has a hosted page (`https://lyrsoft.com/public/subscribe?w=…&f=…`) and HTML to paste into any website; new subscribers get the form's tags. Bots are caught by a hidden field, and signups are limited per IP and per form.
- **Campaigns:** write the email with simple formatting (headings, bold, links, lists, buttons, images) and merge tags such as `{{first_name|there}}`, with a live desktop / phone preview drawn by `lyrsoft/marketing-email.js`, the same code the API sends with. Send a test, then send to everyone or to people with certain tags, now or at a scheduled time.
- **Reports:** delivered, unique opens and clicks, clicks per link, unsubscribes, bounces and spam complaints, and each recipient's activity.
- **Who can do what:** workspace members write drafts and manage subscribers; owners and admins change settings and send. Campaigns go out from `campaigns@lyrsoft.com` (stack parameter `MarketingFrom`) with the workspace's sender name and reply-to; Lyrsoft staff may send from any address on a mail domain. Every email has the workspace's postal address and a one-click unsubscribe link (`List-Unsubscribe`). A workspace sends up to 2,000 emails a day (40,000 for staff); the SES account allows 50,000 a day at 14 a second.
- **How sending works:** starting a send snapshots the audience into recipient rows (`MKTC#<campaign>`), then the work API Lambda invokes itself to send about 12 emails a second, 20 seconds per run, until none are left. A one-minute EventBridge rule (`lyrsoft-marketing-tick`) starts scheduled campaigns and resumes stalled sends. Emails go through the SES configuration set `lyrsoft-marketing`, whose bounces and complaints arrive through the SNS topic `lyrsoft-marketing-events` and suppress those addresses.
- **Links:** open pixels, click redirects (only to links in that campaign), unsubscribe and signup pages are signed with the `lyrsoft/app` secret and served at `https://lyrsoft.com/public/*`, which CloudFront forwards to the work API (`lyrsoft-site.yml`).

## Accounts and admin console

- **Profile** (`/app/#/profile`, `lyrsoft/account.js`): photo (the Google photo by default, or an upload the browser shrinks to a ≤ 45 KB JPEG, `lyrsoft/avatar.js`), name, verified email, mobile number and email settings. The role badge in the top bar opens the admin console. Profiles are rows in the `lyrsoft-work` table (`PROFILE#<sub>`), created on first sign-in.
- **Mobile verification:** `POST /me/phone` texts a 6-digit code through Amazon SNS and `POST /me/phone/verify` checks it; only an HMAC of the code is stored (key in the `lyrsoft/app` secret). Limits: 5 codes per person and 200 for the site per day. The AWS account's SMS is still in the **SNS sandbox** ($1/month spend limit), so codes only reach numbers verified in the SNS console until production SMS access is granted.
- **Emails** (from `Lyrsoft <no-reply@lyrsoft.com>`, stack parameter `MailFrom`, replies to hello@lyrsoft.com): a welcome email on first sign-in, and product updates the super admin sends from the admin console. Each update has a signed one-click unsubscribe link (`/public/unsubscribe`), and people can switch updates off in their profile.
- **Admin console** (`/app/#/admin`, admins and the super admin): every account with sign-in method, mobile, role and last sign-in. Admins disable regular users; only the super admin makes or removes admins and emails updates. Admins made in Lyrcloud are admins here too.

## Look and feel

The app uses Plus Jakarta Sans with bold headings, gradient accents, page and dialog animations, and stat numbers that count up (styles at the end of `lyrsoft/app.css`). `lyrsoft/ui.js` adds a command palette (**Ctrl/⌘ K**) that jumps to any page, workspace, board, mailbox or Marketing, keyboard shortcuts (**?** lists them: `/` search, `g` then `h`/`m`/`k`/`c`/`t`/`p`), and a light / dark / device theme switch in the top bar (**Shift T**), remembered in the browser.

## Layout

```
lyrsoft/            website (home.html), app (index.html, app.js, mail.js), sign-in callback
lyrsoft/brand/      logo (SVG), favicons and web manifest, served at /brand/ (and /favicon.ico)
src/auth.js         Cognito sign-in helpers: Google (Hosted UI) and email and password (src/cognito.js), copies of Lyrcloud's
api/work/           work API Lambda: workspaces, boards, items, contacts, marketing, chat and meetings, contact form, Lyrbot, mail routes
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
