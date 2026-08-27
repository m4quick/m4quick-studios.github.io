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

  const tsRaw = field(data, 'form_ts', 20);
  const elapsedMs = tsRaw && /^\d+$/.test(tsRaw) ? Date.now() - Number(tsRaw) : null;

  const spam = scoreSubmission({ name, email, company, message, elapsedMs });
  const country = request.headers.get('cf-ipcountry') || '??';

  const flag = spam.level === 'HIGH' ? '[LIKELY SPAM] ' : spam.level === 'MEDIUM' ? '[CHECK] ' : '';

  const bodyLines = [
    `Track: ${track}`,
    `Name: ${name}`,
    `Email: ${email}`,
    `Company: ${company || '(not provided)'}`,
    `Org size: ${orgSize || '(not provided)'}`,
    `Timeline: ${timeline || '(not provided)'}`,
    `Country: ${country}`,
    `Screening: ${spam.level} (score ${spam.score})`,
  ];
  if (spam.reasons.length) {
    bodyLines.push(...spam.reasons.map((r) => `  - ${r}`));
  }
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
  ];
  if (spam.reasons.length) {
    tgLines.push(...spam.reasons.map((r) => `• ${esc(r)}`));
  }
  tgLines.push('', `<b>Message:</b>`, `<pre>${esc(message.slice(0, 900))}</pre>`);

  // Telegram must never be able to break the form: notify, but do not fail on it.
  await sendTelegram(env, tgLines.join('\n')).catch(() => {});

  if (!emailResult.ok) {
    return new Response(`Failed to send. Mailgun status ${emailResult.status}: ${emailResult.text}`, { status: 502 });
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
