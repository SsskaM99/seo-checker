// Tietoturvatesti: sisäverkon osoitteiden esto, syötteiden käsittely, otsakkeet ja käyttörajoitukset.
// Käynnistää palvelimen testiasetuksilla (ei lähetä sähköposteja). Käyttö: npm run test:security

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const { safeLookup, isPrivateIp } = require(path.join(ROOT, 'fetcher.js'));
const PORT = 3102;
const APP = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-checker-sec-'));

const app = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DATA_DIR, RESEND_API_KEY: '', RESEND_KEY: '', FORMSPREE_KEY: '', FORMSPREE_ID: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
app.stdout.on('data', d => log += d);
app.stderr.on('data', d => log += d);
for (let i = 0; i < 100 && !log.includes('running'); i++) await new Promise(r => setTimeout(r, 100));

let passed = 0, failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
};
const analyze = async url => {
  const r = await fetch(APP + '/api/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

try {
  console.log('1. Sisäverkon ja erikoisosoitteiden esto (SSRF)');
  for (const url of ['localhost', '127.0.0.1', 'http://[::1]/', 'http://2130706433', 'http://0x7f.1', 'localtest.me',
    'http://169.254.169.254/latest/meta-data/', 'metadata.google.internal', 'http://[::ffff:7f00:1]/', 'http://10.0.0.1',
    'http://192.168.1.1', 'http://[fd00::1]/']) {
    const r = await analyze(url);
    check(`${url} estetty`, r.status === 400 && ['blocked_address', 'invalid_url', 'dns'].includes(r.body.code), `${r.status} ${r.body.code}`);
  }
  for (const url of ['ftp://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'http://example.com:22/', 'http://example.com:6379/', 'https://' + 'a'.repeat(2100) + '.fi']) {
    const r = await analyze(url);
    check(`${url.slice(0, 40)} hylätty`, r.status === 400, `${r.status} ${r.body.code}`);
  }

  console.log('2. DNS-kiinnitys yhteyden hetkellä (rebinding)');
  const lookup = host => new Promise(res => safeLookup(host, {}, (err, addr) => res(err ? err.code : addr)));
  check('localtest.me (127.0.0.1) estetään yhteyden hetkellä', await lookup('localtest.me') === 'EBLOCKED');
  check('example.com sallitaan', !['EBLOCKED', 'ENOTFOUND'].includes(await lookup('example.com')));
  check('IPv4-upotus ::ffff:a9fe:a9fe estetty', isPrivateIp('::ffff:a9fe:a9fe'));
  check('NAT64 64:ff9b::7f00:1 estetty', isPrivateIp('64:ff9b::7f00:1'));
  check('julkinen 8.8.8.8 sallittu', !isPrivateIp('8.8.8.8'));

  console.log('3. Uudelleenohjaus sisäverkkoon');
  const redir = await analyze('https://httpbin.org/redirect-to?url=http%3A%2F%2F127.0.0.1%2F');
  if (redir.status === 400 || redir.status === 502 || redir.status === 504) {
    check('ohjaus 127.0.0.1:een estetty', redir.body.code === 'blocked_address' || redir.body.code === 'invalid_url', `${redir.status} ${redir.body.code}`);
  } else console.log(`  – ohitettu (httpbin ei vastannut odotetusti: ${redir.status})`);

  console.log('4. Syötteet ja virheet');
  const badJson = await fetch(APP + '/api/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{rikki' });
  const badBody = await badJson.text();
  check('rikkinäinen JSON: 400 ilman pinojälkeä', badJson.status === 400 && !/at |node_modules|Error:/.test(badBody), badBody.slice(0, 80));
  const big = await fetch(APP + '/api/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'x'.repeat(30000) }) });
  check('ylisuuri pyyntö hylätään', big.status === 400 || big.status === 413, String(big.status));
  const noBody = await fetch(APP + '/api/check', { method: 'POST' });
  check('tyhjä pyyntö hylätään hallitusti', noBody.status === 400, String(noBody.status));

  console.log('5. Otsakkeet ja tiedostot');
  const home = await fetch(APP + '/');
  check('X-Powered-By piilotettu', !home.headers.get('x-powered-by'));
  check('nosniff asetettu', home.headers.get('x-content-type-options') === 'nosniff');
  check('upotus vain omille sivuille (frame-ancestors)', /frame-ancestors/.test(home.headers.get('content-security-policy') || ''));
  for (const f of ['/leads.json', '/analyses.json', '/.env', '/server.js', '/outbox/', '/../leads.json']) {
    const r = await fetch(APP + f);
    check(`${f} ei ole julkinen`, r.status === 404 || r.status === 400, String(r.status));
  }

  console.log('6. Sähköpostien väärinkäytön esto');
  const a = await analyze('example.com');
  let last;
  for (let i = 0; i < 4; i++) {
    last = await fetch(APP + '/api/lead', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'kohde@esimerkki.fi', analysisId: a.body.analysisId }) });
  }
  check('4. raportti samaan osoitteeseen vuorokaudessa estetty', last.status === 429, String(last.status));
  for (const email of ['a@b', 'x'.repeat(250) + '@esimerkki.fi', 'foo@bar.fi\nBcc: x@y.fi', '<script>@x.fi']) {
    const r = await fetch(APP + '/api/lead', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, analysisId: a.body.analysisId }) });
    check(`virheellinen osoite hylätään: ${JSON.stringify(email).slice(0, 30)}`, r.status === 400, String(r.status));
  }
} finally {
  app.kill();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

console.log(`\n${passed} ok, ${failed} epäonnistui.`);
process.exit(failed ? 1 : 0);
