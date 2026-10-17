// Local Lyrsoft work API for development: runs the real Lambda handler (api/work/index.mjs) with
// an in-memory database (scripts/dev/fake-dynamodb.mjs) and fake sign-in. Data is lost on restart.
//
//   npm run api              API on http://localhost:8787
//   npm run dev              app on http://localhost:5174 (built against the local API)
//
// Sign in locally by opening http://localhost:5174/?dev-login=you@example.com: the app stores a
// fake token for that email. Use lyrclouds@gmail.com to act as the super admin.
//
// Mail: nothing leaves your machine. Dev-only endpoints (no auth):
//   POST /__dev/inbound  { from, fromName, to: [..], subject, text, html?, inReplyTo?, attachment? }
//                        simulates an incoming email through the real processor (api/mail/inbound.mjs)
//   GET  /__dev/sent     what the app "sent" through SES
import { createServer } from 'node:http';
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
  const fakeDb = ${JSON.stringify(new URL('./dev/fake-dynamodb.mjs', import.meta.url).href)};
  const fakeAws = ${JSON.stringify(new URL('./dev/fake-aws.mjs', import.meta.url).href)};
  export async function resolve(specifier, context, next) {
    if (specifier === '@aws-sdk/client-dynamodb' || specifier === '@aws-sdk/lib-dynamodb') return { url: fakeDb, shortCircuit: true };
    if (['@aws-sdk/client-s3', '@aws-sdk/client-sesv2', '@aws-sdk/s3-request-presigner'].includes(specifier)) return { url: fakeAws, shortCircuit: true };
    return next(specifier, context);
  }
`));

process.env.TABLE_NAME = 'lyrsoft-work';
process.env.MAIL_BUCKET = 'lyrsoft-mail-dev';
process.env.MAIL_DOMAINS ??= 'lyrsoft.com,lyrcloud.com,lyrtrip.com,lyrshop.com,lyrpay.com,mrshihab.com';
const port = Number(process.env.PORT || 8787);

// Fake tokens look like "dev.<email>". Cognito's userInfo endpoint is answered locally.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (!String(url).includes('/oauth2/userInfo')) return realFetch(url, options);
  const token = String(options?.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token.startsWith('dev.')) return new Response('{"error":"invalid_token"}', { status: 401 });
  const email = token.replace(/^dev\./, '');
  const name = email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return new Response(JSON.stringify({ sub: `sub-${email}`, username: `GoogleOIDC_${email}`, email, name }));
};

const { handler } = await import('../api/work/index.mjs');
const { processInbound } = await import('../api/mail/inbound.mjs');
const { buildRawEmail } = await import('../api/mail/model.mjs');
const fakeAws = await import('./dev/fake-aws.mjs');

// Builds a raw email like a real sender would, stores it where SES would, and runs the processor.
async function simulateInbound({ from, fromName = '', to, subject, text, html, inReplyTo, attachment }) {
  const id = `dev-in-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  let raw = buildRawEmail({ from: { name: fromName, address: from }, to, subject, text, html, inReplyTo, references: inReplyTo ? [inReplyTo] : [] })
    .replace('MIME-Version: 1.0', `Message-ID: <${id}@sender.example>\r\nMIME-Version: 1.0`);
  if (attachment) {
    // Wrap the alternative body in multipart/mixed with one attachment.
    const split = raw.indexOf('\r\n\r\n');
    const head = raw.slice(0, split);
    const body = raw.slice(split + 4);
    const innerType = head.match(/Content-Type: (.+)/)[1];
    const outer = 'mixed-' + id;
    raw = head.replace(/Content-Type: .+/, `Content-Type: multipart/mixed; boundary="${outer}"`) + '\r\n\r\n' +
      `--${outer}\r\nContent-Type: ${innerType}\r\n\r\n${body}\r\n` +
      `--${outer}\r\nContent-Type: text/plain; name="${attachment.filename}"\r\nContent-Disposition: attachment; filename="${attachment.filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
      Buffer.from(attachment.content).toString('base64') + `\r\n--${outer}--\r\n`;
  }
  fakeAws.objects.set(`inbound/${id}`, { body: Buffer.from(raw), contentType: 'message/rfc822' });
  return processInbound({
    mail: { messageId: id, source: from, timestamp: new Date().toISOString() },
    receipt: {
      recipients: to,
      spamVerdict: { status: /viagra|lottery/i.test(subject) ? 'FAIL' : 'PASS' },
      virusVerdict: { status: 'PASS' },
      spfVerdict: { status: 'PASS' },
      dkimVerdict: { status: 'PASS' },
      dmarcVerdict: { status: 'PASS' },
    },
  });
}

async function devRoute(request, url, body, response) {
  const send = (status, data, type = 'application/json') =>
    response.writeHead(status, { ...cors, 'content-type': type }).end(type === 'application/json' ? JSON.stringify(data) : data);
  if (request.method === 'POST' && url.pathname === '/__dev/inbound') return send(200, await simulateInbound(JSON.parse(body || '{}')));
  if (request.method === 'GET' && url.pathname === '/__dev/sent') return send(200, fakeAws.sentMail);
  if (request.method === 'GET' && url.pathname.startsWith('/__dev/s3/')) {
    const object = fakeAws.objects.get(decodeURIComponent(url.pathname.slice('/__dev/s3/'.length)));
    return object ? send(200, object.body, object.contentType || 'application/octet-stream') : send(404, { error: 'missing' });
  }
  return send(404, { error: 'not_found' });
}

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
};

createServer(async (request, response) => {
  if (request.method === 'OPTIONS') return response.writeHead(204, cors).end();
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname.startsWith('/__dev/')) {
    return devRoute(request, url, chunks.length ? Buffer.concat(chunks).toString('utf8') : '', response).catch((error) => {
      console.error(error);
      response.writeHead(500, cors).end(String(error.stack || error));
    });
  }
  const token = (request.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const isPublic = request.method === 'POST' && url.pathname === '/public/contact'; // AuthorizationType NONE in the template
  if (!isPublic && !token.startsWith('dev.')) return response.writeHead(401, { ...cors, 'content-type': 'application/json' }).end('{"message":"Unauthorized"}');
  const result = await handler({
    requestContext: {
      http: { method: request.method, path: url.pathname, sourceIp: request.socket.remoteAddress },
      authorizer: isPublic ? undefined : { jwt: { claims: { sub: `sub-${token.slice(4)}` } } },
    },
    headers: { authorization: request.headers.authorization },
    rawQueryString: url.search.slice(1),
    body: chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined,
  });
  response.writeHead(result.statusCode, { ...cors, ...result.headers }).end(result.body);
}).listen(port, () => console.log(`Lyrsoft dev API on http://localhost:${port} (in-memory data)`));
