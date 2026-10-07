// Sähköpostipolun testi: käynnistää palvelimen testiasetuksilla, korvaa Resendin paikallisella
// vastaanottajalla ja tarkistaa, mitä viestejä lähtee. Viestit tallennetaan esikatseltaviksi.
// Käyttö: npm test  (tarvitsee verkkoyhteyden, koska analysoi seosales.fi:n)

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP_PORT = 3101, MOCK_PORT = 3199;
const APP = `http://127.0.0.1:${APP_PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-checker-test-'));
const PREVIEW_DIR = path.join(ROOT, 'outbox', 'test');

const received = [];
let failNext = false;
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c).on('end', () => {
    if (req.url.startsWith('/formspree')) { res.end('{}'); return; }
    const payload = JSON.parse(body);
    received.push({ payload, headers: req.headers });
    if (failNext) { failNext = false; res.writeHead(500); res.end('{"message":"testivirhe"}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: `test-${received.length}` }));
  });
});
await new Promise(r => mock.listen(MOCK_PORT, '127.0.0.1', r));

const app = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: {
    ...process.env, PORT: String(APP_PORT), DATA_DIR,
    RESEND_API_KEY: 're_testi', RESEND_API_URL: `http://127.0.0.1:${MOCK_PORT}/emails`,
    RESEND_FROM: 'SEO Sales <raportti@seosales.fi>', REPLY_TO: 'jani@seosales.fi',
    FORMSPREE_KEY: '', FOLLOWUP_DAYS: '3',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let appLog = '';
app.stdout.on('data', d => appLog += d);
app.stderr.on('data', d => appLog += d);
for (let i = 0; i < 100 && !appLog.includes('running'); i++) await new Promise(r => setTimeout(r, 100));
if (!appLog.includes('running')) {
  console.error('Palvelin ei käynnistynyt:\n' + appLog);
  app.kill(); mock.close();
  process.exit(1);
}

let passed = 0, failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
};
const post = (p, body, headers = {}) => fetch(APP + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

try {
  console.log('1. Analyysi');
  const check1 = await (await post('/api/check', { url: 'seosales.fi' })).json();
  check('palauttaa analysisId:n', typeof check1.analysisId === 'string', JSON.stringify(check1).slice(0, 120));

  console.log('2. Virheellinen sähköposti');
  const bad = await post('/api/lead', { email: 'ei-osoite', analysisId: check1.analysisId });
  check('hylätään (400 invalid_email)', bad.status === 400 && (await bad.json()).code === 'invalid_email');
  check('ei lähetä viestejä', received.length === 0);

  console.log('3. Liidi ja viestit');
  const r3 = await post('/api/lead', {
    email: ' Testi@Esimerkki.FI ', newsletter: true, analysisId: check1.analysisId, url: check1.url,
    // Selaimen lähettämä data ei saa päätyä viestiin.
    categories: [{ label: 'HUIJAUS', checks: [{ label: 'Soita heti numeroon 0700', status: 'fail', message: 'HUIJAUSVIESTI' }] }],
    score: 1,
  });
  const j3 = await r3.json();
  check('vastaus ok ja raportti lähetetty', r3.ok && j3.emailSent === true, JSON.stringify(j3));
  check('kaksi viestiä Resendille', received.length === 2, `saatiin ${received.length}`);
  const [report, followup] = received.map(x => x.payload);
  const now = Date.now();
  check('raportti: vastaanottaja siistitty', report?.to === 'testi@esimerkki.fi', report?.to);
  check('raportti: lähettäjä ja vastausosoite', report?.from === 'SEO Sales <raportti@seosales.fi>' && report?.reply_to === 'jani@seosales.fi');
  check('raportti: aihe sisältää sivuston ja pisteet', /^Näkyvyysanalyysi: seosales\.fi – \d+\/100$/.test(report?.subject || ''), report?.subject);
  check('raportti lähtee heti (ei ajastusta)', !report?.scheduled_at);
  check('raportti ei sisällä selaimen syöttämää tekstiä', !report?.html.includes('HUIJAUS'));
  check('raportti käyttää palvelimen pisteitä', report?.html.includes(`>${check1.score}<`));
  const days = (new Date(followup?.scheduled_at) - now) / 86400000;
  check('muistutus ajastettu noin 3 päivän päähän', days > 2.99 && days < 3.01, followup?.scheduled_at);
  check('muistutuksella sama vastausosoite', followup?.reply_to === 'jani@seosales.fi');
  check('muistutus ei sisällä selaimen syöttämää tekstiä', !followup?.html.includes('HUIJAUS'));
  check('idempotenssiavaimet asetettu', received.every(x => /^(report|followup)-/.test(x.headers['idempotency-key'] || '')));
  const leads = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'leads.json'), 'utf8'));
  check('liidi tallennettu uutiskirjesuostumuksen kanssa', leads.length === 1 && leads[0].newsletter === true && leads[0].score === check1.score);

  fs.mkdirSync(PREVIEW_DIR, { recursive: true });
  fs.writeFileSync(path.join(PREVIEW_DIR, 'raportti.html'), report?.html || '');
  fs.writeFileSync(path.join(PREVIEW_DIR, 'muistutus.html'), followup?.html || '');

  console.log('4. Vanhentunut analyysi');
  const r4 = await post('/api/lead', { email: 'toinen@esimerkki.fi', analysisId: 'olematon', url: 'https://seosales.fi/' });
  check('analyysi ajetaan uudelleen ja viestit lähtevät', r4.ok && received.length === 4, `status ${r4.status}, viestejä ${received.length}`);

  console.log('5. Resend-virhe');
  failNext = true;
  const r5 = await post('/api/lead', { email: 'kolmas@esimerkki.fi', analysisId: check1.analysisId });
  const j5 = await r5.json();
  check('käyttäjä saa silti raportin (ok, emailSent false)', r5.ok && j5.emailSent === false, JSON.stringify(j5));
  check('virhe kirjataan lokiin', /epäonnistui/.test(appLog));

  console.log('6. CORS');
  const ok = await fetch(APP + '/api/check', { method: 'OPTIONS', headers: { Origin: 'https://seosales.fi' } });
  check('seosales.fi sallittu', ok.headers.get('access-control-allow-origin') === 'https://seosales.fi');
  const evil = await fetch(APP + '/api/check', { method: 'OPTIONS', headers: { Origin: 'https://huijaus.example' } });
  check('vieras domain ei sallittu', !evil.headers.get('access-control-allow-origin'));
} finally {
  app.kill();
  mock.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

console.log(`\n${passed} ok, ${failed} epäonnistui. Viestien esikatselu: outbox/test/`);
process.exit(failed ? 1 : 0);
