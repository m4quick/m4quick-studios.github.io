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

## Secrets

```
wrangler secret put MAILGUN_API_KEY      # Mailgun private API key
wrangler secret put TELEGRAM_BOT_TOKEN   # from @BotFather
wrangler secret put TELEGRAM_CHAT_ID     # your chat/channel id
wrangler secret put TEST_KEY             # any random string, guards the test route
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
