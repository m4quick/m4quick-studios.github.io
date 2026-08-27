// Intake + newsletter backend for m4quickstudios.com
//
// Sends each submission to email (Mailgun) and to Telegram.
//
// IMPORTANT (was the cause of "forms not arriving in Gmail"):
// this previously sent From a Mailgun *sandbox* domain. Sandbox domains are
// test-only — they deliver to at most a handful of pre-authorised recipients
// and are unrelated to m4quickstudios.com's SPF/DKIM/DMARC, so Gmail flagged
// every message as unauthenticated. Sending From the real domain uses the
// SPF/DKIM/DMARC records already published for it.
const MAILGUN_DOMAIN = 'm4quickstudios.com';
const TO_EMAIL = 'm4quick@gmail.com';
const FROM_EMAIL = `M4Quick Studios <intake@${MAILGUN_DOMAIN}>`;

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
// guarantee: if Mailgun and Telegram are both down, the enquiry still exists
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

async function sendMail(env, subject, bodyText) {
  const form = new FormData();
  form.append('from', FROM_EMAIL);
  form.append('to', TO_EMAIL);
  form.append('subject', subject);
  form.append('text', bodyText);
  form.append('h:Reply-To', TO_EMAIL);

  const resp = await fetch(`https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(`api:${env.MAILGUN_API_KEY}`) },
    body: form,
  });
  return { ok: resp.ok, status: resp.status, text: await resp.text() };
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

  const emailResult = await sendMail(env, `${flag}New intake: ${track} — ${name}`, bodyLines.join('\n'));

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

  await sendTelegram(env, tgLines.join('\n')).catch(() => {});

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

  const result = await sendMail(env, 'New newsletter signup', `Email: ${email}`);
  await sendTelegram(env, `\u{1F4E7} <b>Newsletter signup</b>\n${esc(email)}`).catch(() => {});

  if (!result.ok) {
    return new Response(`Failed to send. Mailgun status ${result.status}: ${result.text}`, { status: 502 });
  }
  return Response.redirect(`${url.origin}/?submitted=newsletter#newsletter`, 303);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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
      const list = await env.SUBMISSIONS.list({ prefix: 'intake:', limit });
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
