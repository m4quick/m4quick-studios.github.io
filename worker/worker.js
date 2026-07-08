const MAILGUN_DOMAIN = 'sandbox04420bfd931745d389bcbc6316ef6609.mailgun.org';
const TO_EMAIL = 'm4quick@gmail.com';
const FROM_EMAIL = `M4Quick Studios <postmaster@${MAILGUN_DOMAIN}>`;

async function sendMail(env, subject, bodyText) {
  const form = new FormData();
  form.append('from', FROM_EMAIL);
  form.append('to', TO_EMAIL);
  form.append('subject', subject);
  form.append('text', bodyText);

  const resp = await fetch(`https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`api:${env.MAILGUN_API_KEY}`),
    },
    body: form,
  });
  const respText = await resp.text();
  return { ok: resp.ok, status: resp.status, text: respText };
}

function field(data, name, max) {
  return (data.get(name) || '').toString().trim().slice(0, max);
}

async function handleIntake(request, env, url) {
  const data = await request.formData();

  // honeypot — bots fill every field, real users never see this one
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

  const body = [
    `Track: ${track}`,
    `Name: ${name}`,
    `Email: ${email}`,
    `Company: ${company || '(not provided)'}`,
    `Org size: ${orgSize || '(not provided)'}`,
    `Timeline: ${timeline || '(not provided)'}`,
    '',
    'Message:',
    message,
  ].join('\n');

  const result = await sendMail(env, `New intake: ${track} — ${name}`, body);
  if (!result.ok) {
    return new Response(`Failed to send. Mailgun status ${result.status}: ${result.text}`, { status: 502 });
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
  if (!result.ok) {
    return new Response(`Failed to send. Mailgun status ${result.status}: ${result.text}`, { status: 502 });
  }

  return Response.redirect(`${url.origin}/?submitted=newsletter#newsletter`, 303);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method !== 'POST') {
      return new Response('Not found', { status: 404 });
    }

    try {
      if (url.pathname === '/api/intake') {
        return await handleIntake(request, env, url);
      }
      if (url.pathname === '/api/subscribe') {
        return await handleSubscribe(request, env, url);
      }
    } catch (err) {
      return new Response('Server error', { status: 500 });
    }

    return new Response('Not found', { status: 404 });
  },
};
