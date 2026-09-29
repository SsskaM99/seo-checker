// Stressitesti: ajaa /api/check-kutsun joukolle sivustoja ja tulostaa yhteenvedon.
// Käyttö: node scripts/stress-test.mjs [http://localhost:3000] [tulokset.json]

import fs from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const OUT = process.argv[3] || null;
const CONCURRENCY = 4;

const SITES = [
  // Palautteessa mainitut
  'alko.fi', 'nokia.com', 'dashboa.com/fi/', 'hs.fi', 'is.fi',
  // Aiemman testin sivustot
  'seosales.fi', 'hubspot.com', 'verkkokauppa.com', 'duunitori.fi', 'example.com',
  'k-ruoka.fi', 'hsl.fi', 'wolt.com/fi/fin',
  // Laajempi otos: pienet ja isot, B2B ja B2C, eri alustat
  'sivu.me', 'yle.fi', 'kela.fi', 'posti.fi', 'op.fi', 'elisa.fi', 'tori.fi',
  'stockmann.com', 'zalando.fi', 'ikea.com/fi/fi/', 'finnair.com/fi-fi', 'supercell.com',
  'gigantti.fi', 's-kaupat.fi', 'fonecta.fi', 'vincit.com', 'reaktor.com',
  'kideve.fi', 'wordpress.org', 'github.com',
  // Virhetapaukset
  'tamaa-ei-ole-olemassa-12345.fi', 'http://neverssl.com', 'localhost:3000', '127.0.0.1',
  'http://169.254.169.254/latest/meta-data/', 'ftp://example.com', 'seosales.fi/ei-olemassa',
];

async function check(site) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/api/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: site }),
      signal: AbortSignal.timeout(45000),
    });
    const data = await r.json();
    const ms = Date.now() - t0;
    if (!r.ok) return { site, http: r.status, ms, error: data.error };
    const cats = Object.fromEntries(data.categories.map(c => [c.id, c.score]));
    const words = data.categories.find(c => c.id === 'content')?.checks.find(c => c.label === 'Sisällön määrä')?.message || '';
    return { site, http: r.status, ms, url: data.url, score: data.score, cats, words, notes: data.notes || [] };
  } catch (err) {
    return { site, http: 0, ms: Date.now() - t0, error: 'Testiajo: ' + err.message };
  }
}

const queue = [...SITES];
const results = [];
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length) {
    const s = queue.shift();
    const res = await check(s);
    results.push(res);
    const line = res.error
      ? `${String(res.http).padEnd(4)} ${s.padEnd(42)} ${String(res.ms).padStart(6)} ms  VIRHE: ${res.error}`
      : `${String(res.http).padEnd(4)} ${s.padEnd(42)} ${String(res.ms).padStart(6)} ms  ${String(res.score).padStart(3)}  ` +
        Object.entries(res.cats).map(([k, v]) => `${k}:${v}`).join(' ') + `  | ${res.words}`;
    console.log(line);
  }
}));

const ok = results.filter(r => !r.error);
console.log(`\nYhteensä ${results.length}, onnistui ${ok.length}, virheitä ${results.length - ok.length}`);
if (ok.length) {
  const avg = Math.round(ok.reduce((s, r) => s + r.ms, 0) / ok.length);
  console.log(`Keskim. kesto ${avg} ms, pisin ${Math.max(...ok.map(r => r.ms))} ms`);
}
if (OUT) fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
