# Intake form backend (Cloudflare Worker + Mailgun + Telegram)

Handles `POST /api/intake` (contact form) and `POST /api/subscribe`
(newsletter) from `m4quickstudios.com`. Each submission is sent to
`m4quick@gmail.com` by email **and** pushed to Telegram.

## Sending domain — read this before changing it

This worker sends `From: intake@m4quickstudios.com`.

It previously sent from a Mailgun **sandbox** domain
(`sandbox04420bfd…mailgun.org`). That was the cause of intake emails being
flagged and filtered by Gmail:

- Sandbox domains are **test-only**. Mailgun restricts them to a handful of
  pre-authorised recipients — anything else is rejected outright.
- A sandbox domain is unrelated to `m4quickstudios.com`, so the SPF, DKIM and
  DMARC records published for the real domain did not apply. Gmail showed
  *"This message isn't authenticated and the sender can't be verified."*

The real domain is already configured for this:

| Record | Value |
|---|---|
| SPF   | `v=spf1 include:mailgun.org ~all` |
| DMARC | `v=DMARC1; p=quarantine; …` |
| DKIM  | `krs._domainkey.m4quickstudios.com` |
| MX    | `mxa.mailgun.org`, `mxb.mailgun.org` |

`m4quickstudios.com` must be present and **verified** in the Mailgun dashboard
under Sending → Domains. If sends start returning 401/404 from Mailgun, that
verification is the first thing to check.

## Spam screening

Bots were getting through the honeypot, so each intake is scored and
annotated — **LOW / MEDIUM / HIGH** appears in the Telegram message and in the
email subject.

Signals: a free mailbox paired with a large-corporate company claim; gibberish
message bodies; URLs in the message; very short messages; submission within
seconds of page load (via the `form_ts` hidden field); and unusually shaped
names.

**Scoring never blocks a submission.** A false positive that silently drops a
real enquiry costs far more than a spam message you can ignore. Only the
honeypot hard-blocks, because a human cannot trip it.


## Never losing a submission

Every intake is written to Cloudflare KV **before** any notification is
attempted. Email and Telegram are best-effort delivery on top of a durable
record — if both fail, the enquiry still exists and is recoverable.

One-time setup:

```
wrangler kv namespace create SUBMISSIONS
# paste the returned id into wrangler.toml
```

Recover stored submissions (newest first):

```
curl "https://m4quickstudios.com/api/submissions?key=<TEST_KEY>&limit=50"
```

The visitor is redirected to the success page whenever the record was stored,
even if mail delivery failed. Showing a raw gateway error over a mail-provider
hiccup loses the lead twice — once in delivery, and again because the visitor
assumes the form is broken.

## Verifying people are real

| Layer | What it catches | Cost to a real visitor |
|---|---|---|
| Honeypot | naive bots | none (invisible) |
| `form_ts` timing | scripted posts | none |
| Turnstile | most automated submissions | usually zero-click |
| MX / A lookup | typo'd and invented email domains | none |
| Screening heuristics | template and gibberish spam | none |

**Turnstile** — Cloudflare dashboard → Turnstile → Add site for
`m4quickstudios.com`, then set both keys on the worker:

```
wrangler secret put TURNSTILE_SECRET          # private, verifies submissions
npx wrangler secret put TURNSTILE_SITE_KEY    # public, served to the form
```

No HTML edit is needed. The form asks `GET /api/config` on load and mounts the
widget only if a site key comes back. With no key set the endpoint returns
`null`, no widget renders, and the form submits normally — so there is never
disabled markup sitting in the repo or a broken challenge box shown to a real
visitor.

`TURNSTILE_MODE` in `wrangler.toml` controls behaviour:

- `off` — skip entirely
- `flag` — a failure scores heavily but still stores and notifies (**default**)
- `block` — a failure is rejected outright, after storing

It ships on `flag` deliberately: a misconfigured key in `block` mode would
silently reject every genuine enquiry, and you would have no way of knowing.
Move to `block` once you have watched it pass real traffic.

**MX check** — the email domain is resolved over DNS-over-HTTPS. A syntactically
valid address at a domain that cannot receive mail is a strong fake signal, and
it also catches honest typos like `gmial.com`.

## Secrets

```
wrangler secret put MAILGUN_API_KEY      # Mailgun private API key
wrangler secret put TELEGRAM_BOT_TOKEN   # from @BotFather
wrangler secret put TELEGRAM_CHAT_ID     # your chat/channel id
wrangler secret put TEST_KEY             # random string; guards /api/test-telegram and /api/submissions
wrangler secret put TURNSTILE_SECRET     # Cloudflare Turnstile secret key (optional)
```

Telegram is optional — if the two Telegram secrets are absent the worker still
emails normally and simply skips the notification. A Telegram failure can never
break the form.

## Telegram setup

1. In Telegram, message **@BotFather** → `/newbot` → follow the prompts.
   Copy the bot token it gives you.
2. Send your new bot any message (it cannot message you first).
3. Get your chat id:
   `curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | grep -o '"id":[0-9-]*' | head -1`
4. Store both with `wrangler secret put` as above.
5. Deploy, then verify without touching the public form:
   `curl "https://m4quickstudios.com/api/test-telegram?key=<TEST_KEY>"`

## Deploy

**Normally you do not.** `.github/workflows/deploy-worker.yml` deploys the
worker on any push that touches `worker/`, so it ships through the same
Gitea → GitHub path as the rest of the site:

```
git push  ->  Gitea  ->  GitHub  ->  Action  ->  wrangler deploy
```

The site itself publishes to GitHub Pages; only `/api/*` is this worker.
Because the path filter is scoped to `worker/**`, editing a page does not
redeploy the backend that receives intake forms.

Two repo secrets are required on the GitHub side
(Settings → Secrets and variables → Actions):

| Secret | Scope |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Workers Scripts: Edit |
| `CLOUDFLARE_ACCOUNT_ID` | — |

The workflow refuses to deploy if `wrangler.toml` still holds the KV
placeholder, or if `worker.js` reverts to a Mailgun sandbox domain — the two
failures that have already cost real intake requests.

### Manual deploy, if you need it

```
cd worker
wrangler login
wrangler deploy
```

Route is bound in the Cloudflare dashboard (Workers & Pages → m4quick-intake →
Settings → Triggers → Routes): `m4quickstudios.com/api/*`, zone
`m4quickstudios.com`. The rest of the site is served by GitHub Pages.

## Test

```
curl -i -X POST https://m4quickstudios.com/api/subscribe -d "email=test@example.com"
```

Expect a `303` to `/?submitted=newsletter#newsletter`, an email at
`m4quick@gmail.com`, and a Telegram message.
