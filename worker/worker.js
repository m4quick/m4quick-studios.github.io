// Intake + newsletter backend for m4quickstudios.com
//
// Sends each submission to email (Microsoft Graph) and to Telegram.
//
// Mailgun is gone. It returned 401 Forbidden on every send this account ever
// made — verified across five stored submissions spanning weeks — so no
// enquiry notification ever reached the inbox. Only the store-first design
// and the Telegram leg kept those enquiries from vanishing.
//
// Mail now goes out through the intake@m4quickstudios.com mailbox in the
// tenant that owns the domain, so SPF, 2048-bit DKIM and DMARC all align by
// construction rather than by configuration. One fewer service, one fewer
// credential, one fewer SPF include.
const SEND_AS = 'intake@m4quickstudios.com';
// Notifications land in the same mailbox that sends them, so an enquiry and
// any reply to it live in one place.
const TO_EMAIL = SEND_AS;
const GRAPH = 'https://graph.microsoft.com/v1.0';
const LOGIN = 'https://login.microsoftonline.com';

const TELEGRAM_API = 'https://api.telegram.org';

// ---------------------------------------------------------------- utilities

function field(data, name, max) {
  return (data.get(name) || '').toString().trim().slice(0, max);
}

function esc(s) {
  return String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
}

// ------------------------------------------------------------ spam scoring
//
// Deliberately advisory, not a gate. A false positive that silently drops a
// real enquiry costs far more than a spam message you can ignore, so nothing
// here blocks a submission — it only annotates it. The honeypot stays a hard
// block because a human literally cannot trip it.

const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
  'aol.com', 'gmx.us', 'gmx.com', 'gmx.de', 'mail.ru', 'yandex.ru',
  'proton.me', 'protonmail.com', 'icloud.com', 'zoho.com', 'inbox.lv',
]);

// Companies whose staff would essentially never use a free mailbox for
// procurement. Claiming one of these alongside a gmail address is a strong
// mismatch signal.
const BIG_CORP = [
  'google', 'alphabet', 'microsoft', 'amazon', 'apple', 'meta', 'facebook',
  'netflix', 'nvidia', 'oracle', 'ibm', 'intel', 'cisco', 'salesforce',
  'adobe', 'tesla', 'openai', 'anthropic',
];

function looksLikeGibberish(text) {
  const words = text.toLowerCase().match(/[a-z]{6,}/g) || [];
  if (words.length < 2) return false;
  let bad = 0;
  for (const w of words) {
    const vowels = (w.match(/[aeiou]/g) || []).length;
    const ratio = vowels / w.length;
    const longRun = /[bcdfghjklmnpqrstvwxyz]{5,}/.test(w);
    if (ratio < 0.22 || longRun) bad++;
  }
  return bad / words.length >= 0.5;
}

function scoreSubmission({ name, email, company, message, elapsedMs }) {
  const reasons = [];
  let score = 0;

  const domain = (email.split('@')[1] || '').toLowerCase();
  const companyLc = company.toLowerCase();

  if (FREE_MAIL.has(domain) && BIG_CORP.some((c) => companyLc.includes(c))) {
    score += 3;
    reasons.push(`claims "${company}" but uses a free ${domain} address`);
  }

  if (looksLikeGibberish(message)) {
    score += 4;
    reasons.push('message body looks like generated gibberish');
  }

  if (/https?:\/\/|www\.|\.[a-z]{2,4}\/|\b[a-z0-9-]+\.(com|net|org|ru|us)\b/i.test(message)) {
    score += 2;
    reasons.push('message contains a URL or domain');
  }

  if (message.length < 25) {
    score += 1;
    reasons.push('message is very short');
  }

  // Bots post the instant they parse the page; humans take time to type.
  if (elapsedMs !== null && elapsedMs >= 0 && elapsedMs < 4000) {
    score += 3;
    reasons.push(`submitted ${Math.round(elapsedMs / 1000)}s after page load`);
  }

  if (name && !/\s/.test(name) && name.length > 8 && !/[aeiou]{1}/i.test(name.slice(-3))) {
    score += 1;
    reasons.push('name has no spacing and an unusual shape');
  }

  const level = score >= 6 ? 'HIGH' : score >= 3 ? 'MEDIUM' : 'LOW';
  return { score, level, reasons };
}

// ------------------------------------------------- human verification

// Cloudflare Turnstile. Verifies the visitor is a real person without the
// friction (or the privacy cost) of an image CAPTCHA.
//
// Mode is controlled by TURNSTILE_MODE:
//   off   - skip entirely
//   flag  - a failure adds heavily to the spam score but still stores/notifies
//   block - a failure is rejected outright (still stored first)
// Default is "flag" so a misconfigured key can never silently reject real
// enquiries. Tighten to "block" once you have watched it work.
async function verifyTurnstile(env, token, ip) {
  const mode = (env.TURNSTILE_MODE || 'flag').toLowerCase();
  if (mode === 'off' || !env.TURNSTILE_SECRET) {
    return { mode, ran: false, ok: true, reason: 'turnstile not configured' };
  }
  if (!token) {
    return { mode, ran: true, ok: false, reason: 'no Turnstile token submitted' };
  }
  try {
    const body = new FormData();
    body.append('secret', env.TURNSTILE_SECRET);
    body.append('response', token);
    if (ip) body.append('remoteip', ip);
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
    });
    const j = await r.json();
    return {
      mode,
      ran: true,
      ok: !!j.success,
      reason: j.success ? 'passed' : `failed (${(j['error-codes'] || []).join(', ') || 'unknown'})`,
    };
  } catch (e) {
    // Never let an outage at the verifier block a real person.
    return { mode, ran: true, ok: true, reason: 'verifier unreachable, allowed' };
  }
}

// Does the email's domain actually accept mail? Catches typos and invented
// domains that a syntax check happily passes.
async function domainAcceptsMail(email) {
  const domain = (email.split('@')[1] || '').toLowerCase().trim();
  if (!domain || !domain.includes('.')) return { checked: true, ok: false, reason: 'malformed domain' };
  try {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`, {
      headers: { Accept: 'application/dns-json' },
    });
    const j = await r.json();
    const has = Array.isArray(j.Answer) && j.Answer.some((a) => a.type === 15);
    if (has) return { checked: true, ok: true, reason: 'MX present' };
    // Some small domains accept mail on the A record with no MX.
    const r2 = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=A`, {
      headers: { Accept: 'application/dns-json' },
    });
    const j2 = await r2.json();
    const hasA = Array.isArray(j2.Answer) && j2.Answer.length > 0;
    return { checked: true, ok: hasA, reason: hasA ? 'no MX, A record only' : 'no MX and no A record' };
  } catch (e) {
    return { checked: false, ok: true, reason: 'DNS check unavailable' };
  }
}

// ------------------------------------------------------------- storage

// Write the submission down BEFORE notifying anyone. This is the whole
// guarantee: if Graph and Telegram are both down, the enquiry still exists
// and can be replayed. Nothing is ever lost to a delivery failure.
async function storeSubmission(env, record) {
  if (!env.SUBMISSIONS) return { ok: false, reason: 'KV not bound' };
  try {
    const key = `intake:${record.receivedAt}:${crypto.randomUUID()}`;
    await env.SUBMISSIONS.put(key, JSON.stringify(record));
    return { ok: true, key };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

// ------------------------------------------------------------- notifiers

// Client-credentials token, cached for the life of the isolate. Graph tokens
// last an hour; we treat one as stale a minute early to avoid racing expiry.
let cachedToken = null;

async function graphToken(env) {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60000) {
    return { ok: true, token: cachedToken.value };
  }
  if (!env.GRAPH_TENANT_ID || !env.GRAPH_CLIENT_ID || !env.GRAPH_CLIENT_SECRET) {
    return { ok: false, status: 0, text: 'graph not configured' };
  }
  const resp = await fetch(`${LOGIN}/${env.GRAPH_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GRAPH_CLIENT_ID,
      client_secret: env.GRAPH_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  const text = await resp.text();
  if (!resp.ok) return { ok: false, status: resp.status, text: text.slice(0, 300) };
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { ok: false, status: resp.status, text: 'token response was not JSON' }; }
  cachedToken = { value: parsed.access_token, expiresAt: now + Number(parsed.expires_in || 3600) * 1000 };
  return { ok: true, token: parsed.access_token };
}

// Deliberately conservative. This address comes from a public form, and a
// malformed one would make Graph reject the whole message — losing the
// notification to protect a convenience. If it does not look like an address,
// we simply omit Reply-To and send anyway.
function usableReplyTo(addr) {
  if (!addr) return null;
  const a = String(addr).trim();
  if (a.length > 254 || /[\s<>,;"]/.test(a)) return null;
  return /^[^@]+@[^@.]+\.[^@]+$/.test(a) ? a : null;
}

async function sendMail(env, subject, bodyText, replyToAddr) {
  const t = await graphToken(env);
  if (!t.ok) return { ok: false, status: t.status || 0, text: `token: ${t.text}` };

  const replyTo = usableReplyTo(replyToAddr);

  const resp = await fetch(`${GRAPH}/users/${encodeURIComponent(SEND_AS)}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'Text', content: bodyText },
        toRecipients: [{ emailAddress: { address: TO_EMAIL } }],
        ...(replyTo ? { replyTo: [{ emailAddress: { address: replyTo } }] } : {}),
      },
      saveToSentItems: true,
    }),
  });
  // Graph answers a successful sendMail with 202 and an empty body.
  const text = resp.status === 202 ? 'accepted' : (await resp.text()).slice(0, 400);
  return { ok: resp.ok, status: resp.status, text };
}

async function sendTelegram(env, html) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return { ok: false, status: 0, text: 'telegram not configured' };
  }
  const resp = await fetch(`${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  return { ok: resp.ok, status: resp.status, text: await resp.text() };
}

// --------------------------------------------------------------- handlers

async function handleIntake(request, env, url) {
  const data = await request.formData();

  // Honeypot — a human never sees this field, so anything in it is a bot.
  if (field(data, 'hp_field', 100)) {
    return Response.redirect(`${url.origin}/?submitted=intake#contact`, 303);
  }

  const name = field(data, 'name', 200);
  const email = field(data, 'email', 200);
  const company = field(data, 'company', 200);
  const orgSize = field(data, 'org_size', 100);
  const track = field(data, 'track', 100);
  const timeline = field(data, 'timeline', 100);
  const message = field(data, 'message', 3000);

  if (!name || !email || !message || !track) {
    return new Response('Missing required fields', { status: 400 });
  }

  const ip = request.headers.get('cf-connecting-ip') || '';
  const country = request.headers.get('cf-ipcountry') || '??';
  const tsRaw = field(data, 'form_ts', 20);
  const elapsedMs = tsRaw && /^\d+$/.test(tsRaw) ? Date.now() - Number(tsRaw) : null;

  // Run the two independent human checks concurrently.
  const [turnstile, mailDomain] = await Promise.all([
    verifyTurnstile(env, field(data, 'cf-turnstile-response', 4000), ip),
    domainAcceptsMail(email),
  ]);

  const spam = scoreSubmission({ name, email, company, message, elapsedMs });
  if (turnstile.ran && !turnstile.ok) {
    spam.score += 6;
    spam.reasons.push(`Turnstile ${turnstile.reason}`);
  }
  if (mailDomain.checked && !mailDomain.ok) {
    spam.score += 4;
    spam.reasons.push(`email domain does not accept mail (${mailDomain.reason})`);
  }
  spam.level = spam.score >= 6 ? 'HIGH' : spam.score >= 3 ? 'MEDIUM' : 'LOW';

  const record = {
    receivedAt: new Date().toISOString(),
    track, name, email, company, orgSize, timeline, message,
    ip, country,
    elapsedMs,
    turnstile: { ran: turnstile.ran, ok: turnstile.ok, reason: turnstile.reason },
    mailDomain,
    screening: { score: spam.score, level: spam.level, reasons: spam.reasons },
  };

  // Persist FIRST. Everything after this point is best-effort delivery — the
  // enquiry itself is already safe.
  const stored = await storeSubmission(env, record);

  // Hard rejection only when explicitly configured, and only after storing.
  if (turnstile.ran && !turnstile.ok && turnstile.mode === 'block') {
    return new Response('Verification failed. Please reload the page and try again.', { status: 403 });
  }

  const flag = spam.level === 'HIGH' ? '[LIKELY SPAM] ' : spam.level === 'MEDIUM' ? '[CHECK] ' : '';

  const bodyLines = [
    `Track: ${track}`,
    `Name: ${name}`,
    `Email: ${email}`,
    `Company: ${company || '(not provided)'}`,
    `Org size: ${orgSize || '(not provided)'}`,
    `Timeline: ${timeline || '(not provided)'}`,
    `Country: ${country}`,
    '',
    `Screening: ${spam.level} (score ${spam.score})`,
    `Turnstile: ${turnstile.ran ? turnstile.reason : 'not configured'}`,
    `Email domain: ${mailDomain.reason}`,
    `Stored: ${stored.ok ? stored.key : 'NOT STORED — ' + stored.reason}`,
  ];
  if (spam.reasons.length) bodyLines.push(...spam.reasons.map((r) => `  - ${r}`));
  bodyLines.push('', 'Message:', message);

  const emailResult = await sendMail(env, `${flag}New intake: ${track} — ${name}`, bodyLines.join('\n'), email);

  const icon = spam.level === 'HIGH' ? '\u{1F6A8}' : spam.level === 'MEDIUM' ? '\u{26A0}\u{FE0F}' : '\u{1F4E5}';
  const tgLines = [
    `${icon} <b>New intake — ${esc(track)}</b>`,
    '',
    `<b>Name:</b> ${esc(name)}`,
    `<b>Email:</b> ${esc(email)}`,
    `<b>Company:</b> ${esc(company || '—')}`,
    `<b>Org size:</b> ${esc(orgSize || '—')}`,
    `<b>Timeline:</b> ${esc(timeline || '—')}`,
    `<b>Country:</b> ${esc(country)}`,
    '',
    `<b>Screening:</b> ${spam.level} (score ${spam.score})`,
    `<b>Human check:</b> ${esc(turnstile.ran ? turnstile.reason : 'Turnstile off')}`,
    `<b>Mail domain:</b> ${esc(mailDomain.reason)}`,
  ];
  if (spam.reasons.length) tgLines.push(...spam.reasons.map((r) => `• ${esc(r)}`));
  if (!stored.ok) tgLines.push(`\u{26A0}\u{FE0F} <b>NOT STORED:</b> ${esc(stored.reason)}`);
  tgLines.push('', '<b>Message:</b>', `<pre>${esc(message.slice(0, 900))}</pre>`);

  const tgResult = await sendTelegram(env, tgLines.join('\n')).catch((e) => ({ ok: false, status: 0, text: String(e) }));

  // Record what actually happened to each notification channel. Without this a
  // silent delivery failure is invisible: the visitor sees success, the record
  // is stored, and nothing anywhere says the email never went out.
  const delivery = {
    email: { ok: emailResult.ok, status: emailResult.status, detail: String(emailResult.text || '').slice(0, 400) },
    telegram: { ok: tgResult.ok, status: tgResult.status, detail: String(tgResult.text || '').slice(0, 200) },
  };
  console.log('intake delivery', JSON.stringify(delivery));
  if (stored.ok && env.SUBMISSIONS) {
    await env.SUBMISSIONS.put(stored.key, JSON.stringify({ ...record, delivery })).catch(() => {});
  }

  // The visitor is told it worked because, as far as their enquiry is
  // concerned, it did — it is stored and recoverable. Showing them a raw
  // gateway error over a mail-provider hiccup loses the lead twice: once in
  // delivery, and again because they assume the form is broken.
  if (!emailResult.ok && !stored.ok) {
    return new Response('We could not record your message. Please email m4quick@gmail.com directly.', { status: 502 });
  }
  return Response.redirect(`${url.origin}/?submitted=intake#contact`, 303);
}

async function handleSubscribe(request, env, url) {
  const data = await request.formData();

  if (field(data, 'hp_field', 100)) {
    return Response.redirect(`${url.origin}/?submitted=newsletter#newsletter`, 303);
  }

  const email = field(data, 'email', 200);
  if (!email || !email.includes('@')) {
    return new Response('Invalid email', { status: 400 });
  }

  const result = await sendMail(env, 'New newsletter signup', `Email: ${email}`, email);
  await sendTelegram(env, `\u{1F4E7} <b>Newsletter signup</b>\n${esc(email)}`).catch(() => {});

  if (!result.ok) {
    return new Response(`Failed to send. Graph status ${result.status}: ${result.text}`, { status: 502 });
  }
  return Response.redirect(`${url.origin}/?submitted=newsletter#newsletter`, 303);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Serves the public Turnstile site key so the form can configure itself.
    // The site key is not a secret — it is designed to sit in page markup —
    // but serving it from here means the widget appears the moment a key is
    // set, with no HTML edit and no disabled markup checked into the repo.
    // No key set: returns null, the form renders without a widget and works.
    if (request.method === 'GET' && url.pathname === '/api/config') {
      return new Response(JSON.stringify({
        turnstileSiteKey: env.TURNSTILE_SITE_KEY || null,
      }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
      });
    }

    // Recover stored submissions. This is what makes the store-first
    // guarantee real: if email and Telegram both failed, every enquiry is
    // still here and readable.
    if (request.method === 'GET' && url.pathname === '/api/submissions') {
      if (!env.TEST_KEY || url.searchParams.get('key') !== env.TEST_KEY) {
        return new Response('Not found', { status: 404 });
      }
      if (!env.SUBMISSIONS) {
        return new Response('KV not bound', { status: 500 });
      }
      const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
      // Keys are intake:<ISO timestamp>:<uuid>, so KV returns them oldest
      // first. Passing `limit` to list() therefore hands back the OLDEST
      // records, and sorting afterwards only reorders the wrong set — asking
      // for the latest 2 returned submissions from days earlier, which is
      // exactly how this misled me while testing the Graph cutover.
      // Collect every key, sort, then trim.
      const allKeys = [];
      let cursor;
      do {
        const page = await env.SUBMISSIONS.list({ prefix: 'intake:', cursor });
        allKeys.push(...page.keys);
        cursor = page.list_complete ? null : page.cursor;
      } while (cursor);
      allKeys.sort((a, b) => (a.name < b.name ? 1 : -1));
      const list = { keys: allKeys.slice(0, limit) };
      const out = [];
      for (const k of list.keys) {
        const v = await env.SUBMISSIONS.get(k.name);
        if (v) out.push(JSON.parse(v));
      }
      out.sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1));
      return new Response(JSON.stringify({ count: out.length, submissions: out }, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Lets you verify Telegram wiring without submitting the public form.
    if (request.method === 'GET' && url.pathname === '/api/test-telegram') {
      if (url.searchParams.get('key') !== env.TEST_KEY) {
        return new Response('Not found', { status: 404 });
      }
      const r = await sendTelegram(env, '\u{2705} <b>Test</b> — intake worker can reach Telegram.');
      return new Response(`telegram ok=${r.ok} status=${r.status}\n${r.text}`, { status: r.ok ? 200 : 502 });
    }

    if (request.method !== 'POST') {
      return new Response('Not found', { status: 404 });
    }

    try {
      if (url.pathname === '/api/intake') return await handleIntake(request, env, url);
      if (url.pathname === '/api/subscribe') return await handleSubscribe(request, env, url);
    } catch (err) {
      return new Response('Server error', { status: 500 });
    }

    return new Response('Not found', { status: 404 });
  },
};
