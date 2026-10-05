const express = require('express');
const cheerio = require('cheerio');
const path = require('path');
const fs = require('fs');
const { fetchPage, fetchSiteFiles, FetchError } = require('./fetcher');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const LEADS_FILE = path.join(__dirname, 'leads.json');
const ANALYSES_FILE = path.join(__dirname, 'analyses.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: false }));

function loadLeads() {
  try { return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8')); }
  catch { return []; }
}

function saveLead(lead) {
  const leads = loadLeads();
  leads.push(lead);
  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2), 'utf8');
}

function loadAnalyses() {
  try { return JSON.parse(fs.readFileSync(ANALYSES_FILE, 'utf8')); }
  catch { return []; }
}

function saveAnalysis(entry) {
  const analyses = loadAnalyses();
  analyses.push(entry);
  fs.writeFileSync(ANALYSES_FILE, JSON.stringify(analyses, null, 2), 'utf8');
}

// Yksinkertainen IP-kohtainen rajoitus, ettei analyysiä voi käyttää massahakuihin.
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = Number(process.env.RATE_MAX || 20);
const rateHits = new Map();
function rateLimited(ip) {
  if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return false; // paikallinen testaus
  const now = Date.now();
  const hits = (rateHits.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  hits.push(now);
  rateHits.set(ip, hits);
  if (rateHits.size > 5000) rateHits.clear();
  return hits.length > RATE_MAX;
}

async function runAnalysis(input) {
  const page = await fetchPage(input);
  const siteFiles = await fetchSiteFiles(page.finalUrl);
  return analyze(page.html, page.finalUrl, { responseTimeMs: page.responseTimeMs, headers: page.headers, ...siteFiles });
}

app.post('/api/check', async (req, res) => {
  if (rateLimited(req.ip)) {
    return res.status(429).json({ error: 'Olet tehnyt useita analyysejä lyhyessä ajassa. Kokeile uudelleen hetken kuluttua.', code: 'rate_limited' });
  }

  try {
    const results = await runAnalysis(req.body?.url);

    saveAnalysis({
      url: results.url,
      score: results.score,
      platform: results.platform,
      categories: results.categories.map(c => ({ id: c.id, score: c.score })),
      timestamp: new Date().toISOString(),
    });

    res.json(results);
  } catch (err) {
    if (err instanceof FetchError) return res.status(err.httpStatus).json({ error: err.message, code: err.code });
    console.error('Analyysivirhe:', err);
    return res.status(500).json({ error: 'Analyysi epäonnistui odottamattomasti. Kokeile uudelleen.', code: 'internal' });
  }
});

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function scoreLabel(score) {
  if (score >= 80) return 'Hyv&auml;';
  if (score >= 60) return 'Kohtalainen';
  return 'Kehitett&auml;v&auml;&auml;';
}

function scoreHex(score) {
  if (score >= 80) return '#27AE60';
  if (score >= 50) return '#E67E22';
  return '#C0392B';
}

// Tekstinä käytettävät tummemmat sävyt valkoisella pohjalla (kontrasti vähintään 4.5:1), samat kuin sivulla.
function scoreTextHex(score) {
  if (score >= 80) return '#1B7A43';
  if (score >= 50) return '#A35200';
  return '#C0392B';
}

// Tummalla pohjalla luettavat sävyt.
function scoreDarkHex(score) {
  if (score >= 80) return '#3DD68C';
  if (score >= 50) return '#F2994A';
  return '#FF8A7A';
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function buildReportHTML({ url, score, summary, categories, platform }) {
  const date = new Date().toLocaleDateString('fi-FI');
  const host = hostOf(url);
  const cats = Array.isArray(categories) ? categories : [];
  const allChecks = cats.flatMap(c => (c.checks || []).map(ch => ({ ...ch, catLabel: c.label })));
  const fails = allChecks.filter(c => c.status === 'fail');
  const warns = allChecks.filter(c => c.status === 'warn');
  const passes = allChecks.filter(c => c.status === 'pass');
  const CTA_URL = 'https://seosales.fi/yhteys.html';

  // Kaksi kolmen sarakkeen riviä, jotta otsikot mahtuvat myös puhelimen näytölle.
  const catCell = c => `
    <td style="text-align:center;padding:12px 4px;width:33%">
      <div style="font-size:26px;font-weight:700;color:${scoreTextHex(c.score)}">${c.score}</div>
      <div style="font-size:11px;color:#6B6A73;text-transform:uppercase;letter-spacing:0.05em;margin-top:4px">${esc(c.label)}</div>
    </td>`;
  const catScoreBlock = [cats.slice(0, 3), cats.slice(3)].filter(r => r.length).map(r => '<tr>' + r.map(catCell).join('') + '</tr>').join('');

  const issueBlock = (items, sectionTitle, titleColor, lineColor) => {
    if (!items.length) return '';
    return `
  <tr><td style="padding:28px 40px 4px">
    <h2 style="font-size:18px;font-weight:600;color:${titleColor};margin:0">${sectionTitle} (${items.length})</h2>
  </td></tr>` + items.map(ch => `
  <tr><td style="padding:14px 40px 4px">
    <div style="border-left:3px solid ${lineColor};padding-left:16px">
      <div style="font-size:11px;color:#6B6A73;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px">${esc(ch.catLabel)}</div>
      <div style="font-size:15px;font-weight:600;color:#17161C;margin-bottom:4px">${esc(ch.label)}</div>
      <div style="font-size:15px;color:#34333C;line-height:1.6">${esc(ch.message)}</div>
      ${ch.tip ? `<div style="font-size:14px;color:#34333C;margin-top:6px;line-height:1.6"><strong style="color:#17161C">Miten korjata:</strong> ${esc(ch.tip)}</div>` : ''}
    </div>
  </td></tr>`).join('');
  };

  // Yksi kevyt kehotus korjattavien jälkeen; varsinainen CTA on viestin lopussa.
  const inlineCta = fails.length ? `
  <tr><td style="padding:16px 40px 0">
    <a href="${CTA_URL}" style="font-size:14px;color:#6D4AFF;text-decoration:none;font-weight:600">Haluatko, ett&auml; k&auml;ymme n&auml;m&auml; yhdess&auml; l&auml;pi? Varaa maksuton keskustelu &rarr;</a>
  </td></tr>` : '';

  // Esimerkit lauseen keskelle: pieni alkukirjain, paitsi lyhenteissä (HTTPS).
  const passExamples = passes.slice(0, 3).map(p => {
    const l = p.label.replace(/\s*\(.*\)$/, '');
    return esc(/^\p{Lu}\p{Ll}/u.test(l) ? l[0].toLowerCase() + l.slice(1) : l);
  });
  const exampleText = passExamples.length > 1 ? passExamples.slice(0, -1).join(', ') + ' ja ' + passExamples.at(-1) : passExamples[0];
  const passBlock = passes.length ? `
  <tr><td style="padding:28px 40px 4px">
    <h2 style="font-size:18px;font-weight:600;color:#1B7A43;margin:0">Kunnossa (${passes.length})</h2>
  </td></tr>
  <tr><td style="padding:8px 40px 0;font-size:15px;color:#34333C;line-height:1.6">
    ${passes.length} tarkistusta on kunnossa, muun muassa ${exampleText}.
  </td></tr>` : '';

  return `<!DOCTYPE html>
<html lang="fi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F5F5F7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<div style="display:none;max-height:0;overflow:hidden">Sivuston ${esc(host)} n&auml;kyvyysanalyysi: ${score}/100. T&auml;rkeimm&auml;t kehityskohteet ja korjausohjeet.</div>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F5F5F7;padding:24px 0">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#FFFFFF;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.06)">

  <!-- Yläosa: sama tumma paneeli kuin raporttisivulla. LOGO: korvaa tekstin PNG-logolla, kun se on saatavilla. -->
  <tr><td style="background:#17161C;padding:32px 40px 36px;text-align:center">
    <div style="font-size:18px;font-weight:700;color:#FFFFFF;letter-spacing:-0.02em">SEO Sales</div>
    <div style="font-size:11px;color:#25D9C6;text-transform:uppercase;letter-spacing:0.12em;margin-top:20px">N&auml;kyvyysanalyysi</div>
    <div style="font-size:14px;color:#FFFFFF;margin-top:8px">${esc(url)} <span style="color:#C6C2D1">&middot; ${date}${platform ? ` &middot; ${esc(platform)}` : ''}</span></div>
    <div style="display:inline-block;width:100px;height:100px;border-radius:50%;border:6px solid ${scoreHex(score)};text-align:center;line-height:100px;margin-top:22px">
      <span style="font-size:36px;font-weight:700;color:#FFFFFF">${score}</span>
    </div>
    <div style="font-size:12px;font-weight:600;color:${scoreDarkHex(score)};text-transform:uppercase;letter-spacing:0.08em;margin-top:12px">${scoreLabel(score)}</div>
    ${summary ? `<div style="font-size:15px;color:#D8D5E0;margin:10px auto 0;line-height:1.6;max-width:440px">${esc(summary)}</div>` : ''}
  </td></tr>

  <!-- Tervehdys -->
  <tr><td style="padding:32px 40px 4px;font-size:16px;color:#34333C;line-height:1.65">
    <p style="margin:0 0 14px">Hei,</p>
    <p style="margin:0">kiitos, että teit näkyvyysanalyysin. Tässä sivuston <strong style="color:#17161C">${esc(host)}</strong> tulokset osa-alueittain ja korjausohjeet. ${fails.length ? 'Kannattaa aloittaa korjattavista kohdista, sillä ne vaikuttavat näkyvyyteen eniten.' : 'Korjattavia puutteita ei löytynyt, joten voit keskittyä huomioitaviin kohtiin.'}</p>
  </td></tr>

  <!-- Osa-alueiden pisteet -->
  <tr><td style="padding:20px 24px 4px">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#F5F5F7;border-radius:10px">
      ${catScoreBlock}
    </table>
  </td></tr>

  ${issueBlock(fails, 'Korjattavaa', '#C0392B', '#C0392B')}
  ${inlineCta}
  ${issueBlock(warns, 'Huomioitavaa', '#A35200', '#E67E22')}
  ${passBlock}

  <!-- Allekirjoitus -->
  <tr><td style="padding:32px 40px 36px;font-size:15px;color:#34333C;line-height:1.6">
    <p style="margin:0 0 18px">Jos jokin tuloksista herättää kysymyksiä, voit vastata suoraan tähän viestiin.</p>
    <p style="margin:0">Terveisin<br><strong style="color:#17161C">Jani</strong><br>SEO Sales</p>
  </td></tr>

  <!-- CTA -->
  <tr><td style="padding:36px 40px;text-align:center;background:#17161C">
    <div style="font-size:22px;font-weight:700;color:#FFFFFF;margin-bottom:8px">Tehd&auml;&auml;n n&auml;kyvyydest&auml; <span style="color:#25D9C6">myynti&auml;</span></div>
    <div style="font-size:15px;color:#C6C2D1;line-height:1.6;margin:0 auto 22px;max-width:440px">
      Analyysi n&auml;ytt&auml;&auml; l&auml;ht&ouml;tilanteen. Keskustelussa katsomme, mitk&auml; korjaukset tuovat teid&auml;n yritykselle eniten asiakkaita ja miss&auml; j&auml;rjestyksess&auml; ne kannattaa tehd&auml;.
    </div>
    <a href="${CTA_URL}" style="display:inline-block;background:#FFFFFF;color:#17161C;font-size:13px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;padding:14px 32px;border-radius:8px;text-decoration:none">Varaa maksuton keskustelu</a>
  </td></tr>

  <!-- Footer -->
  <tr><td style="padding:18px 40px;text-align:center;font-size:12px;color:#6B6A73;line-height:1.55">
    Sait t&auml;m&auml;n raportin, koska pyysit sit&auml; n&auml;kyvyysanalyysiss&auml; sivulla <a href="https://seosales.fi" style="color:#0C847C;text-decoration:underline">seosales.fi</a>.
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

app.post('/api/lead', (req, res) => {
  const { email, phone, newsletter, url, score, categories, summary, platform } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Virheellinen sähköposti' });

  const lead = {
    email: email.trim().toLowerCase(),
    phone: (phone || '').trim(),
    newsletter: !!newsletter,
    url: url || '',
    score: score ?? null,
    timestamp: new Date().toISOString(),
  };
  saveLead(lead);
  console.log(`Uusi liidi: ${lead.email} | ${lead.url} | newsletter: ${lead.newsletter}`);

  const reportHtml = buildReportHTML({ url: lead.url, score: lead.score, summary, categories, platform: typeof platform === 'string' ? platform.slice(0, 40) : null });

  const RESEND_KEY = process.env.RESEND_KEY || '';
  const FROM_EMAIL = process.env.FROM_EMAIL || 'raportti@seosales.fi';

  if (RESEND_KEY) {
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `SEO Sales <${FROM_EMAIL}>`,
        to: lead.email,
        subject: `Näkyvyysanalyysi: ${lead.url} — ${lead.score}/100`,
        html: reportHtml,
      }),
    }).then(r => {
      if (!r.ok) return r.text().then(t => console.error('Resend error:', t));
      console.log(`Raportti lahetetty: ${lead.email}`);
    }).catch(err => console.error('Resend error:', err.message));
  }

  const FORMSPREE_ID = process.env.FORMSPREE_ID || '';
  if (FORMSPREE_ID) {
    fetch(`https://formspree.io/f/${FORMSPREE_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        _subject: `Uusi liidi: ${lead.email} | ${lead.url} | ${lead.score}/100`,
        email: lead.email,
        phone: lead.phone || '-',
        sivusto: lead.url,
        pistemaara: `${lead.score}/100`,
        uutiskirje: lead.newsletter ? 'Kylla' : 'Ei',
        aika: lead.timestamp,
      }),
    }).then(r => {
      if (!r.ok) return r.text().then(t => console.error('Formspree error:', t));
      console.log(`Formspree-ilmoitus lahetetty`);
    }).catch(err => console.error('Formspree error:', err.message));
  }

  res.json({ ok: true });
});

// Muistutusviesti noin kolme päivää analyysin jälkeen.
function buildFollowupHTML({ url, score, categories }) {
  const CTA_URL = 'https://seosales.fi/yhteys.html';
  const host = hostOf(url);
  const cats = Array.isArray(categories) ? categories : [];
  const allChecks = cats.flatMap(c => (c.checks || []).map(ch => ({ ...ch, catLabel: c.label })));
  const top = [...allChecks.filter(c => c.status === 'fail'), ...allChecks.filter(c => c.status === 'warn')].slice(0, 3);

  const topBlock = top.length ? `
  <tr><td style="padding:8px 40px 4px">
    <div style="font-size:11px;font-weight:600;color:#0C847C;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:10px">T&auml;rkeimm&auml;t kehityskohteet</div>
    ${top.map(ch => `
    <div style="border-left:3px solid ${ch.status === 'fail' ? '#C0392B' : '#E67E22'};padding:2px 0 2px 14px;margin-bottom:12px">
      <div style="font-size:15px;font-weight:600;color:#17161C">${esc(ch.label)}</div>
      <div style="font-size:14px;color:#34333C;line-height:1.55">${esc(ch.message)}</div>
    </div>`).join('')}
  </td></tr>` : '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#F5F5F7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<div style="display:none;max-height:0;overflow:hidden">Katsotaanko yhdess&auml;, mit&auml; tuloksista kannattaa tehd&auml; ensin?</div>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F5F5F7;padding:24px 0">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.06)">

  <tr><td style="padding:28px 40px 0">
    <div style="font-size:17px;font-weight:700;color:#17161C;letter-spacing:-0.02em">SEO Sales</div>
  </td></tr>

  <tr><td style="padding:24px 40px 8px;font-size:16px;color:#34333C;line-height:1.65">
    <p style="margin:0 0 16px">Hei,</p>
    <p style="margin:0 0 16px">kävit muutama päivä sitten läpi sivuston <strong style="color:#17161C">${esc(host)}</strong> näkyvyyttä. Kokonaispisteet olivat <strong style="color:${scoreTextHex(score)}">${score}/100</strong>.</p>
  </td></tr>

  ${topBlock}

  <tr><td style="padding:12px 40px 8px;font-size:16px;color:#34333C;line-height:1.65">
    <p style="margin:0 0 16px">Raportti näyttää, missä mennään. Seuraava kysymys on, mitkä korjaukset tuovat teidän yritykselle eniten asiakkaita ja missä järjestyksessä ne kannattaa tehdä.</p>
    <p style="margin:0">Haluatko, että katsotaan tulokset yhdessä? Lyhyessä keskustelussa käymme läpi tärkeimmät kohdat ja sovimme, mistä kannattaa aloittaa.</p>
  </td></tr>

  <tr><td style="padding:24px 40px 8px">
    <a href="${CTA_URL}" style="display:inline-block;background:#17161C;color:#FFFFFF;font-size:13px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;padding:14px 28px;border-radius:8px;text-decoration:none">Varaa maksuton keskustelu</a>
  </td></tr>

  <tr><td style="padding:16px 40px 32px;font-size:15px;color:#34333C;line-height:1.6">
    <p style="margin:0 0 20px">Voit myös vastata suoraan tähän viestiin.</p>
    <p style="margin:0">Terveisin<br><strong style="color:#17161C">Jani</strong><br>SEO Sales</p>
  </td></tr>

  <tr><td style="padding:18px 40px;border-top:1.5px solid #E8E8EC;font-size:12px;color:#6B6A73;line-height:1.55">
    Saat tämän viestin, koska teit näkyvyysanalyysin sivulla <a href="https://seosales.fi" style="color:#0C847C;text-decoration:underline">seosales.fi</a>. Muistutus lähetetään vain kerran.
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

// Esikatselut vain kehityskäyttöön: tuotannossa ne tekisivät analyysejä ilman käyttörajoitusta.
app.get(['/api/report-preview', '/api/followup-preview'], async (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).end();
  const testUrl = req.query.url || 'https://esimerkki.fi';
  try {
    const data = await runAnalysis(testUrl);
    const html = req.path.endsWith('followup-preview')
      ? buildFollowupHTML({ url: data.url, score: data.score, categories: data.categories })
      : buildReportHTML({ url: data.url, score: data.score, summary: data.summary, categories: data.categories, platform: data.platform });
    res.send(html);
  } catch (err) {
    res.status(500).send('Virhe: ' + err.message);
  }
});

function analyze(html, url, extra = {}) {
  const $ = cheerio.load(html);
  const text = visibleText($);

  const seo = analyzeSEO($, url);
  const technical = analyzeTechnical($, url, extra);
  const content = analyzeContent($, text);
  const social = analyzeSocial($);
  const ai = analyzeAI($, text, extra);
  const lang = $('html').attr('lang') || '';
  const keywords = analyzeKeywords($, lang, text, new URL(url).hostname.replace(/^www\./, ''));

  const categories = [seo, technical, content, social, ai, keywords];

  // Alustakohtaiset vinkit vain oikealle alustalle.
  const platform = detectPlatform($, html, extra.headers || {});
  if (platform !== 'WordPress') {
    categories.forEach(c => c.checks.forEach(ch => {
      if (ch.tip) ch.tip = ch.tip.replace(/\s*WordPressissä[^.]*\./g, '');
    }));
  }

  const totalWeight = categories.reduce((s, c) => s + c.weight, 0);
  const overallScore = Math.round(categories.reduce((s, c) => s + c.score * c.weight, 0) / totalWeight);

  return {
    url,
    platform,
    score: overallScore,
    categories,
    summary: makeSummary(overallScore),
    counts: {
      fail: categories.reduce((s, c) => s + c.checks.filter(x => x.status === 'fail').length, 0),
      warn: categories.reduce((s, c) => s + c.checks.filter(x => x.status === 'warn').length, 0),
      pass: categories.reduce((s, c) => s + c.checks.filter(x => x.status === 'pass').length, 0),
    },
  };
}

// Julkaisualusta sivun koodista ja vastauksen otsakkeista. Järjestys ratkaisee: ensimmäinen osuma voittaa.
const PLATFORMS = [
  ['WordPress', (h, gen) => /\/wp-content\/|\/wp-includes\//.test(h) || /wordpress/i.test(gen)],
  ['Wix', (h, gen, H) => /static\.wixstatic\.com/.test(h) || !!H['x-wix-request-id'] || /wix\.com/i.test(gen)],
  ['Shopify', (h, gen, H) => /cdn\.shopify\.com/.test(h) || !!H['x-shopify-stage']],
  ['Squarespace', h => /static1\.squarespace\.com|squarespace-cdn\.com/.test(h)],
  ['Webflow', (h, gen) => /data-wf-site=/.test(h) || /webflow/i.test(gen)],
  ['Framer', (h, gen) => /framerusercontent\.com/.test(h) || /framer/i.test(gen)],
  ['HubSpot', (h, gen, H) => /hubspot/i.test(gen) || !!H['x-hubspot-correlation-id']],
  ['Drupal', (h, gen, H) => /drupal/i.test(gen) || !!H['x-drupal-cache']],
  ['Joomla', (h, gen) => /joomla/i.test(gen)],
  ['Next.js', h => /\/_next\/static\//.test(h)],
  ['Nuxt', h => /\/_nuxt\//.test(h)],
  ['Gatsby', h => /id="___gatsby"/.test(h)],
  ['GitHub Pages', (h, gen, H) => /^github\.com$/i.test(H.server || '')],
];

function detectPlatform($, html, headers) {
  const gen = $('meta[name="generator"]').attr('content') || headers['x-generator'] || headers['x-powered-by'] || '';
  const hit = PLATFORMS.find(([, test]) => test(html, gen, headers));
  return hit ? hit[0] : null;
}

// Kävijälle näkyvä teksti: skriptit, tyylit ja upotukset eivät ole sisältöä.
function visibleText($) {
  const body = $('body').clone();
  body.find('script,style,noscript,template,svg,iframe').remove();
  return body.text().replace(/­/g, '').replace(/\s+/g, ' ').trim();
}

function countWords(text) {
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
}

function analyzeSEO($, url) {
  const checks = [];
  let score = 0, max = 0;

  const title = $('title').first().text().trim();
  max += 15;
  if (!title) {
    checks.push(ck('Sivun otsikko (title)', 'fail', 'Sivulta puuttuu otsikko, joka näkyy hakutuloksessa ja selaimen välilehdellä.', 'Lisää sivulle <title>-otsikko, jossa on tärkein palvelunne ja yrityksen nimi, esimerkiksi "Tilintarkastus Tampereella | Yritys Oy". Se on hakukoneelle tärkein yksittäinen tieto sivusta.'));
  } else if (title.length < 30) {
    checks.push(ck('Sivun otsikko (title)', 'warn', `Otsikko on lyhyt (${title.length} merkkiä).`, 'Lisää otsikkoon tärkein palvelu ja tarvittaessa paikkakunta. Tavoitepituus on 50–60 merkkiä.'));
    score += 7;
  } else if (title.length > 60) {
    checks.push(ck('Sivun otsikko (title)', 'warn', `Otsikko on pitkä (${title.length} merkkiä).`, 'Lyhennä otsikko 50–60 merkkiin ja nosta tärkein asia alkuun. Google katkaisee pidemmät otsikot.'));
    score += 9;
  } else {
    checks.push(ck('Sivun otsikko (title)', 'pass', `Otsikko on sopivan mittainen (${title.length} merkkiä).`));
    score += 15;
  }

  const desc = $('meta[name="description"]').attr('content')?.trim() || '';
  max += 15;
  if (!desc) {
    checks.push(ck('Hakutuloksen kuvaus', 'fail', 'Sivulta puuttuu kuvaus (meta description).', 'Kirjoita sivulle 140–160 merkin kuvaus, joka kertoo, mitä tarjoatte ja miksi juuri teidät kannattaa valita. Se näkyy hakutuloksessa otsikon alla. WordPressissä kuvauksen voi lisätä esimerkiksi Yoast- tai Rank Math -lisäosalla.'));
  } else if (desc.length < 70) {
    checks.push(ck('Hakutuloksen kuvaus', 'warn', `Kuvaus on lyhyt (${desc.length} merkkiä).`, 'Täydennä kuvaus 140–160 merkkiin: kerro, mitä tarjoatte, kenelle ja mikä on seuraava askel.'));
    score += 7;
  } else if (desc.length > 160) {
    checks.push(ck('Hakutuloksen kuvaus', 'warn', `Kuvaus on pitkä (${desc.length} merkkiä).`, 'Lyhennä kuvaus 140–160 merkkiin ja sijoita tärkein viesti alkuun. Google katkaisee pidemmät kuvaukset.'));
    score += 9;
  } else {
    checks.push(ck('Hakutuloksen kuvaus', 'pass', `Kuvaus on sopivan mittainen (${desc.length} merkkiä).`));
    score += 15;
  }

  const h1s = $('h1');
  max += 10;
  if (h1s.length === 0) {
    checks.push(ck('Pääotsikko (H1)', 'fail', 'Sivulta puuttuu pääotsikko.', 'Lisää sivun alkuun yksi pääotsikko (H1), joka kertoo, mitä tarjoatte. Se auttaa sekä kävijää että hakukonetta ymmärtämään sivun aiheen.'));
  } else if (h1s.length > 1) {
    checks.push(ck('Pääotsikko (H1)', 'warn', `Sivulla on ${h1s.length} pääotsikkoa.`, 'Jätä sivulle yksi H1-pääotsikko ja muuta muut H2-väliotsikoiksi. Yksi pääotsikko kertoo hakukoneelle selkeästi, mistä sivu kertoo.'));
    score += 5;
  } else {
    checks.push(ck('Pääotsikko (H1)', 'pass', `Pääotsikko löytyy: "${trunc(h1s.first().text().trim(), 60)}"`));
    score += 10;
  }

  const canonical = $('link[rel="canonical"]').attr('href') || '';
  max += 10;
  if (!canonical) {
    checks.push(ck('Ensisijainen osoite (canonical)', 'warn', 'Sivulta puuttuu canonical-merkintä.', 'Lisää sivun <head>-osaan merkintä <link rel="canonical" href="…">, joka osoittaa sivun viralliseen osoitteeseen. Se estää samaa sisältöä kilpailemasta itseään vastaan eri osoitteissa.'));
  } else {
    checks.push(ck('Ensisijainen osoite (canonical)', 'pass', 'Sivun virallinen osoite on merkitty.'));
    score += 10;
  }

  const links = $('a[href]');
  let internal = 0, external = 0;
  const bareHost = h => h.replace(/^www\./, '');
  const pageHost = bareHost(new URL(url).hostname);
  links.each((_, el) => {
    const href = $(el).attr('href') || '';
    if (/^(#|javascript:|mailto:|tel:)/.test(href)) return;
    try {
      const lUrl = new URL(href, url);
      if (bareHost(lUrl.hostname) === pageHost) internal++; else external++;
    } catch { internal++; }
  });
  max += 10;
  if (internal === 0) {
    checks.push(ck('Sisäiset linkit', 'warn', 'Sisäisiä linkkejä ei löytynyt.', 'Linkitä etusivulta tärkeimmille palvelusivuille ja palvelusivuilta toisiinsa. Linkit auttavat hakukonetta ymmärtämään sivuston rakenteen ja kävijää löytämään eteenpäin.'));
  } else {
    checks.push(ck('Sisäiset linkit', 'pass', `${internal} sisäistä, ${external} ulkoista linkkiä.`));
    score += 10;
  }

  return cat('seo', 'Hakukoneet', 'Löytääkö Google sivustosi, ja houkutteleeko hakutulos klikkaamaan?', score, max, checks, 3);
}

function analyzeTechnical($, url, extra = {}) {
  const checks = [];
  let score = 0, max = 0;

  max += 20;
  if (url.startsWith('https://')) {
    checks.push(ck('HTTPS', 'pass', 'Sivusto käyttää suojattua HTTPS-yhteyttä.'));
    score += 20;
  } else {
    checks.push(ck('HTTPS', 'fail', 'Sivusto ei käytä HTTPS:ää.', 'Ota käyttöön SSL-varmenne ja ohjaa kaikki http-osoitteet https-osoitteisiin. Useimmat palveluntarjoajat tarjoavat varmenteen maksutta. Ilman sitä selaimet varoittavat kävijöitä, ja Google sijoittaa sivun heikommin.'));
  }

  const viewport = $('meta[name="viewport"]').attr('content') || '';
  max += 15;
  if (!viewport) {
    checks.push(ck('Mobiilioptimointi', 'fail', 'Viewport-metatagi puuttuu.', 'Lisää sivun <head>-osaan <meta name="viewport" content="width=device-width, initial-scale=1">, jotta sivu skaalautuu puhelimen näytölle.'));
  } else {
    checks.push(ck('Mobiilioptimointi', 'pass', 'Viewport on asetettu mobiililaitteille.'));
    score += 15;
  }

  const lang = $('html').attr('lang') || '';
  max += 10;
  if (!lang) {
    checks.push(ck('Kieliasetus', 'warn', 'HTML lang-attribuutti puuttuu.', 'Lisää sivun <html>-tagiin kieli, esimerkiksi <html lang="fi">. Se auttaa hakukoneita näyttämään sivun oikeankielisille hakijoille ja ruudunlukijoita lukemaan tekstin oikein.'));
  } else {
    checks.push(ck('Kieliasetus', 'pass', `Kieli asetettu: "${lang}".`));
    score += 10;
  }

  const robotsMeta = $('meta[name="robots"]').attr('content') || '';
  max += 10;
  if (robotsMeta.includes('noindex')) {
    checks.push(ck('Indeksointi', 'fail', 'Sivulla on noindex — hakukoneet eivät indeksoi sivua.', 'Poista sivulta noindex-merkintä, jos haluat sen näkyvän hakutuloksissa. WordPressissä tarkista myös kohta Asetukset → Lukeminen → Hakukoneiden näkyvyys.'));
  } else if (extra.robots?.blocksAll('Googlebot')) {
    checks.push(ck('Indeksointi', 'fail', 'Robots.txt estää Googlea lukemasta sivustoa.', 'Poista robots.txt-tiedostosta "Disallow: /", jos haluat sivuston näkyvän hakutuloksissa.'));
  } else {
    checks.push(ck('Indeksointi', 'pass', 'Sivu sallii hakukoneindeksoinnin.'));
    score += 10;
  }

  const charset = $('meta[charset]').attr('charset') || $('meta[http-equiv="Content-Type"]').attr('content') || '';
  max += 10;
  if (!charset && !$('meta[charset]').length) {
    checks.push(ck('Merkistökoodaus', 'warn', 'Charset-määrittelyä ei löytynyt.', 'Lisää sivun <head>-osan alkuun <meta charset="UTF-8">, jotta ääkköset näkyvät oikein kaikissa selaimissa.'));
  } else {
    checks.push(ck('Merkistökoodaus', 'pass', 'Merkistökoodaus on määritelty.'));
    score += 10;
  }

  // Vasteaika (Lighthouse-inspiroitu)
  if (extra.responseTimeMs != null) {
    max += 15;
    const ms = extra.responseTimeMs;
    if (ms <= 800) {
      checks.push(ck('Vasteaika', 'pass', `Palvelin vastasi nopeasti (${ms} ms).`));
      score += 15;
    } else if (ms <= 2000) {
      checks.push(ck('Vasteaika', 'warn', `Palvelimen vasteaika on kohtalainen (${ms} ms).`, 'Ota käyttöön välimuisti, esimerkiksi julkaisujärjestelmän välimuistilisäosa tai CDN-palvelu, ja tarkista palvelimen teho. Tavoite on alle 800 ms.'));
      score += 8;
    } else {
      checks.push(ck('Vasteaika', 'fail', `Palvelin vastaa hitaasti (${ms} ms).`, 'Selvitä hitauden syy palveluntarjoajan kanssa: välimuisti, CDN-palvelu tai tehokkaampi palvelin ratkaisevat useimmiten. Hidas sivu menettää kävijöitä ennen kuin ehtii latautua.'));
    }
  }

  // Robots.txt
  if (extra.robotsOk != null) {
    max += 10;
    if (extra.robotsOk) {
      checks.push(ck('Robots.txt', 'pass', 'Robots.txt-tiedosto löytyi — hakukoneet tietävät mitä indeksoida.'));
      score += 10;
    } else {
      checks.push(ck('Robots.txt', 'warn', 'Robots.txt-tiedostoa ei löytynyt.', 'Lisää sivuston juureen robots.txt-tiedosto, joka kertoo hakukoneille, mitä saa lukea, ja osoittaa sivukarttaan (rivi "Sitemap: https://…/sitemap.xml"). Sen puuttuminen ei estä indeksointia, mutta turhatkin sivut voivat päätyä hakutuloksiin.'));
    }
  }

  // Sitemap
  if (extra.sitemapOk != null) {
    max += 10;
    if (extra.sitemapOk) {
      checks.push(ck('Sivukartta', 'pass', 'XML-sivukartta löytyi — hakukoneet löytävät kaikki sivut.'));
      score += 10;
    } else {
      checks.push(ck('Sivukartta', 'warn', 'XML-sivukarttaa (sitemap.xml) ei löytynyt.', 'Luo XML-sivukartta ja lähetä se Google Search Consoleen. Useimmat julkaisujärjestelmät, kuten WordPress, tekevät sen automaattisesti tai lisäosalla. Sivukartan avulla hakukone löytää kaikki sivut.'));
    }
  }

  return cat('technical', 'Tekniikka', 'Toimiiko sivusto nopeasti ja luotettavasti kaikilla laitteilla?', score, max, checks, 2);
}

function analyzeContent($, text) {
  const checks = [];
  let score = 0, max = 0;

  const wordCount = countWords(text);
  max += 20;
  if (wordCount < 100) {
    checks.push(ck('Sisällön määrä', 'fail', `Noin ${wordCount} sanaa.`, 'Kirjoita sivulle vähintään 300 sanaa: mitä tarjoatte, kenelle, miten työ etenee ja miksi teidät kannattaa valita. Hakukone tarvitsee tekstiä ymmärtääkseen sivun aiheen.'));
  } else if (wordCount < 300) {
    checks.push(ck('Sisällön määrä', 'warn', `Noin ${wordCount} sanaa — voisi olla enemmän.`, 'Täydennä sisältöä esimerkiksi palvelukuvauksilla, asiakasesimerkeillä ja usein kysytyillä kysymyksillä. Noin 500 sanaa antaa hakukoneelle paremman kuvan sivusta.'));
    score += 10;
  } else {
    checks.push(ck('Sisällön määrä', 'pass', `Noin ${wordCount} sanaa — riittävästi sisältöä.`));
    score += 20;
  }

  const headings = [];
  $('h1,h2,h3,h4,h5,h6').each((_, el) => headings.push(parseInt(el.tagName.charAt(1))));
  max += 15;
  let hierarchyOk = true;
  for (let i = 1; i < headings.length; i++) {
    if (headings[i] > headings[i - 1] + 1) { hierarchyOk = false; break; }
  }
  if (headings.length === 0) {
    checks.push(ck('Otsikkorakenne', 'fail', 'Sivulla ei ole yhtään otsikkoa.', 'Jäsennä sisältö otsikoilla: yksi pääotsikko (H1) ja aiheittain väliotsikot (H2, H3). Otsikot auttavat kävijää silmäilemään ja hakukonetta ymmärtämään rakenteen.'));
  } else if (!hierarchyOk) {
    checks.push(ck('Otsikkorakenne', 'warn', 'Otsikkotasot hyppäävät (esim. H2 → H4).', 'Korjaa otsikkotasot järjestykseen H1 → H2 → H3. Valitse taso sisällön rakenteen mukaan, ei ulkoasun, sillä otsikon koon voi säätää tyyleillä.'));
    score += 7;
  } else {
    checks.push(ck('Otsikkorakenne', 'pass', `${headings.length} otsikkoa, rakenne on looginen.`));
    score += 15;
  }

  // Seurantapikselit eivät ole kuvia. Tyhjä alt="" (tai role="presentation" / aria-hidden)
  // on oikea tapa merkitä koristekuva, joten vain kokonaan puuttuva alt on puute.
  const images = $('img').filter((_, el) => !['0', '1'].includes($(el).attr('width')) && !['0', '1'].includes($(el).attr('height')));
  const isDecorative = el => {
    const alt = $(el).attr('alt');
    return (alt !== undefined && alt.trim() === '') || $(el).attr('role') === 'presentation' || $(el).attr('role') === 'none' || $(el).attr('aria-hidden') === 'true';
  };
  const decorative = images.filter((_, el) => isDecorative(el)).length;
  const contentImages = images.length - decorative;
  const noAlt = images.filter((_, el) => !isDecorative(el) && $(el).attr('alt') === undefined).length;
  const decoNote = decorative ? ` ${decorative} koristekuvaa on merkitty oikein tyhjällä alt-tekstillä.` : '';
  max += 15;
  if (images.length === 0) {
    checks.push(ck('Kuvien alt-tekstit', 'warn', 'Sivulla ei ole kuvia.', 'Lisää sivulle kuvia, jotka tukevat viestiä, esimerkiksi tiimistä, työstä tai tuotteista, ja kirjoita jokaiselle kuvaava alt-teksti.'));
    score += 7;
  } else if (noAlt > 0) {
    checks.push(ck('Kuvien alt-tekstit', 'fail', `${noAlt}/${contentImages} kuvalta puuttuu alt-teksti.${decoNote}`, 'Kirjoita jokaiselle sisältökuvalle lyhyt alt-teksti, joka kertoo, mitä kuvassa on. Pelkästään koristeelliset kuvat merkitään tyhjällä alt-tekstillä (alt=""). Alt-teksti kertoo kuvan sisällön hakukoneille ja ruudunlukijaa käyttäville.'));
    score += Math.round(15 * (1 - noAlt / contentImages));
  } else if (decorative >= 5 && decorative / images.length > 0.5) {
    // Moni julkaisujärjestelmä (esim. WordPress) tulostaa tyhjän alt-tekstin, jos sitä ei ole kirjoitettu.
    checks.push(ck('Kuvien alt-tekstit', 'warn', `${decorative}/${images.length} kuvaa on merkitty koristekuviksi tyhjällä alt-tekstillä.`, 'Tarkista, ovatko kuvat oikeasti koristeellisia. Moni julkaisujärjestelmä, kuten WordPress, jättää alt-tekstin tyhjäksi, jos sitä ei ole kirjoitettu. Kirjoita sisältökuville lyhyt alt-teksti, joka kertoo, mitä kuvassa on.'));
    score += 10;
  } else if (contentImages === 0) {
    checks.push(ck('Kuvien alt-tekstit', 'pass', `Sivun ${decorative} kuvaa on merkitty koristekuviksi tyhjällä alt-tekstillä.`));
    score += 15;
  } else {
    checks.push(ck('Kuvien alt-tekstit', 'pass', `Kaikilla ${contentImages} sisältökuvalla on alt-teksti.${decoNote}`));
    score += 15;
  }

  return cat('content', 'Sisältö', 'Onko sisältöä riittävästi, ja onko se selkeästi jäsennelty?', score, max, checks, 2);
}

function analyzeSocial($) {
  const checks = [];
  let score = 0, max = 0;

  const ogTitle = $('meta[property="og:title"]').attr('content') || '';
  const ogDesc = $('meta[property="og:description"]').attr('content') || '';
  const ogImage = $('meta[property="og:image"]').attr('content') || '';
  max += 30;
  const ogCount = [ogTitle, ogDesc, ogImage].filter(Boolean).length;
  if (ogCount === 0) {
    checks.push(ck('Open Graph', 'fail', 'Open Graph -tagit puuttuvat.', 'Lisää sivulle Open Graph -tagit og:title, og:description ja og:image. Niiden avulla jaettu linkki näkyy LinkedInissä ja viestisovelluksissa kuvana ja otsikkona. WordPressissä ne hoituvat esimerkiksi Yoast-lisäosalla.'));
  } else if (ogCount < 3) {
    const missing = [];
    if (!ogTitle) missing.push('og:title');
    if (!ogDesc) missing.push('og:description');
    if (!ogImage) missing.push('og:image');
    checks.push(ck('Open Graph', 'warn', `Osittain kunnossa. Puuttuu: ${missing.join(', ')}.`, `Lisää puuttuvat tagit: ${missing.join(', ')}.${missing.includes('og:image') ? ' Jakokuvaksi sopii 1200 × 630 pikselin kuva.' : ''}`));
    score += Math.round(30 * ogCount / 3);
  } else {
    checks.push(ck('Open Graph', 'pass', 'og:title, og:description ja og:image löytyvät.'));
    score += 30;
  }

  const twCard = $('meta[name="twitter:card"]').attr('content') || '';
  const twTitle = $('meta[name="twitter:title"]').attr('content') || '';
  max += 20;
  if (!twCard && !twTitle) {
    checks.push(ck('Twitter/X-kortit', 'warn', 'Twitter Card -tagit puuttuvat.', 'Lisää tagit twitter:card (arvo "summary_large_image") ja twitter:title, jotta linkki näkyy X:ssä isona kuvakorttina.'));
  } else {
    checks.push(ck('Twitter/X-kortit', 'pass', 'Twitter Card -tagit löytyvät.'));
    score += 20;
  }

  const favicon = $('link[rel="icon"]').length || $('link[rel="shortcut icon"]').length;
  max += 10;
  if (!favicon) {
    checks.push(ck('Favicon', 'warn', 'Favicon puuttuu.', 'Lisää sivustolle favicon eli pieni tunnuskuva. Se näkyy selaimen välilehdellä ja Googlen hakutuloksissa sivun nimen vieressä.'));
  } else {
    checks.push(ck('Favicon', 'pass', 'Favicon on asetettu.'));
    score += 10;
  }

  return cat('social', 'Somenäkyvyys', 'Miltä sivusto näyttää, kun joku jakaa sen LinkedInissä tai viestisovelluksessa?', score, max, checks, 1);
}

function analyzeAI($, text, extra = {}) {
  const checks = [];
  let score = 0, max = 0;

  const jsonLd = $('script[type="application/ld+json"]');
  max += 25;
  if (jsonLd.length === 0) {
    checks.push(ck('Rakenteellinen data', 'warn', 'JSON-LD-merkintöjä ei löytynyt.', 'Lisää sivulle schema.org-merkinnät JSON-LD-muodossa, vähintään Organization- tai LocalBusiness-tyyppi yrityksen nimellä, yhteystiedoilla ja palveluilla. Ne kertovat hakukoneille ja tekoälyille yksiselitteisesti, keitä olette ja mitä teette.'));
  } else {
    checks.push(ck('Rakenteellinen data', 'pass', `${jsonLd.length} JSON-LD-lohkoa löytyi.`));
    score += 25;
  }

  // Myös avattavat UKK-kysymykset (summary) ja määritelmälistat (dt) ovat kysymysotsikoita.
  const headingTexts = [];
  $('h2,h3,h4,summary,dt').each((_, el) => headingTexts.push($(el).text().replace(/\s+/g, ' ').trim()));
  const questionHeadings = headingTexts.filter(t => /\?$/.test(t) || /^(miksi|miten|mitä|milloin|kuinka|what|how|why|when)/i.test(t));
  max += 25;
  if (questionHeadings.length === 0) {
    checks.push(ck('Kysymysmuotoiset otsikot', 'warn', 'Kysymysmuotoisia otsikoita ei löytynyt.', 'Muotoile osa väliotsikoista asiakkaan kysymyksiksi, esimerkiksi "Mitä palvelu maksaa?", ja vastaa heti otsikon alla. Tekoälyhaut poimivat tällaisia vastauksia suoraan.'));
  } else {
    checks.push(ck('Kysymysmuotoiset otsikot', 'pass', `${questionHeadings.length} kysymysmuotoista otsikkoa löytyi.`));
    score += 25;
  }

  const faqSchema = jsonLd.toArray().some(el => {
    try { return JSON.stringify($(el).html()).includes('FAQPage'); } catch { return false; }
  });
  max += 15;
  if (faqSchema) {
    checks.push(ck('UKK-merkinnät (FAQ-schema)', 'pass', 'Usein kysyttyjen kysymysten merkinnät löytyivät. Ne auttavat hakukoneita ja tekoälyjä poimimaan vastauksia suoraan sivulta.'));
    score += 15;
  } else {
    checks.push(ck('UKK-merkinnät (FAQ-schema)', 'warn', 'Usein kysyttyjen kysymysten merkintöjä ei löytynyt.', 'Kokoa sivulle asiakkaiden usein kysymät kysymykset vastauksineen ja merkitse ne FAQPage-rakenteella. Merkityt kysymykset ja vastaukset ovat tekoälyhauille helppo lähde.'));
  }

  const metaRobots = ($('meta[name="robots"]').attr('content') || '').toLowerCase();
  const blocked = extra.robots?.blockedAiBots || [];
  const blockedSearch = blocked.filter(b => b.search);
  const names = list => list.map(b => b.name).join(', ');
  max += 15;
  if (blockedSearch.length) {
    checks.push(ck('Tekoälypääsy', 'fail', `Robots.txt estää tekoälyhakuja lukemasta sivustoa: ${names(blockedSearch)}.`, 'Poista robots.txt-tiedostosta hakubottien estot (esimerkiksi OAI-SearchBot, ChatGPT-User ja PerplexityBot). Kun tekoälyhaku ei pääse sivustolle, se ei voi suositella teitä vastauksissaan.'));
  } else if (blocked.length || metaRobots.includes('noai')) {
    const what = blocked.length ? `Robots.txt estää osan tekoälyboteista (${names(blocked)})` : 'Sivulla on noai-merkintä';
    checks.push(ck('Tekoälypääsy', 'warn', `${what}. Tekoälyhaut pääsevät silti sivustolle.`, 'Päätä, haluatko yrityksen tietojen päätyvän tekoälymallien koulutusaineistoon. Estetyt botit keräävät aineistoa koulutukseen, joten esto voi heikentää sitä, miten mallit tuntevat yrityksen. Jos haluat mallien tuntevan teidät, poista estot robots.txt-tiedostosta.'));
    score += 8;
  } else {
    checks.push(ck('Tekoälypääsy', 'pass', extra.robots ? 'Robots.txt sallii tekoälyhakujen ja -bottien pääsyn sivustolle.' : 'Tekoälybotteja ei ole estetty.'));
    score += 15;
  }

  // Useimmat tekoälybotit eivät aja JavaScriptiä: jos sisältö syntyy vasta selaimessa, ne näkevät tyhjän sivun.
  const words = countWords(text);
  const appShell = $('#root,#app,#__next,#__nuxt,[data-reactroot],app-root').length > 0 || $('script[src]').length >= 5;
  max += 20;
  if (words < 80 && appShell) {
    checks.push(ck('Sisältö ilman JavaScriptiä', 'fail', `Sivun sisältö syntyy vasta JavaScriptillä — botit näkevät vain noin ${words} sanaa.`, 'Pyydä sivuston kehittäjää ottamaan käyttöön palvelinpuolen renderöinti tai esirenderöinti, jotta sisältö on mukana sivun HTML-koodissa. Tekoälybotit ja osa hakukoneista eivät aja JavaScriptiä.'));
  } else if (words < 200 && appShell) {
    checks.push(ck('Sisältö ilman JavaScriptiä', 'warn', `Vain osa sisällöstä näkyy ilman JavaScriptiä (noin ${words} sanaa).`, 'Varmista, että palvelukuvaukset ja tärkein teksti ovat mukana sivun HTML-koodissa eivätkä lataudu vasta JavaScriptillä.'));
    score += 10;
  } else {
    checks.push(ck('Sisältö ilman JavaScriptiä', 'pass', 'Sisältö näkyy suoraan sivun koodissa, joten myös tekoälybotit pystyvät lukemaan sen.'));
    score += 20;
  }

  // llms.txt: uusi, vielä vakiintumaton käytäntö, joten puute on huomautus eikä virhe.
  max += 10;
  if (extra.llmsOk) {
    checks.push(ck('llms.txt', 'pass', 'llms.txt-tiedosto löytyi — tekoälyillä on valmis tiivistelmä yrityksestä.'));
    score += 10;
  } else {
    checks.push(ck('llms.txt', 'warn', 'llms.txt-tiedostoa ei löytynyt.', 'Lisää sivuston juureen llms.txt-tiedosto: lyhyt Markdown-muotoinen kuvaus yrityksestä, palveluista, yhteystiedoista ja tärkeimmistä sivuista. Käytäntö on vielä uusi, mutta se on helppo tapa kertoa tekoälyille, keitä olette ja mitä teette.'));
  }

  // Yritystiedot: Google ja tekoälyhaut suosittelevat helpommin yritystä, jonka tiedot ovat yksiselitteiset.
  const visible = {
    puhelin: $('a[href^="tel:"]').length > 0 || /(?:\+358|(?<!\d)0)\s?\d{1,2}[\s-]?\d{3,4}[\s-]?\d{3,4}(?!\d)/.test(text),
    'sähköposti': $('a[href^="mailto:"]').length > 0 || /[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(text),
    osoite: /(?<!\d)\d{5}\s+\p{Lu}\p{Ll}+/u.test(text),
    'Y-tunnus': /(?<!\d)\d{7}-\d(?!\d)/.test(text),
  };
  const foundInfo = Object.keys(visible).filter(k => visible[k]);
  const missingInfo = Object.keys(visible).filter(k => !visible[k]);
  const ldNodes = [];
  const walk = n => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === 'object') { ldNodes.push(n); Object.values(n).forEach(walk); }
  };
  jsonLd.each((_, el) => { try { walk(JSON.parse($(el).html())); } catch {} });
  const orgSchema = ldNodes.some(n => n['@type'] && (n.telephone || n.address || n.contactPoint));
  const listFi = arr => arr.length > 1 ? arr.slice(0, -1).join(', ') + ' ja ' + arr.at(-1) : arr[0];
  max += 15;
  score += Math.round(Math.min(foundInfo.length, 3) / 3 * 10) + (orgSchema ? 5 : 0);
  const infoTip = 'Näytä puhelinnumero, sähköposti, osoite ja Y-tunnus esimerkiksi sivun alaosassa ja lisää samat tiedot Organization- tai LocalBusiness-merkintään. Pidä tiedot samoina myös Google-yritysprofiilissa, Fonectassa ja YTJ:ssä.';
  // Vain etusivu tarkistetaan, ja yhteystiedot ovat usein omalla sivullaan: puute on huomautus, ei virhe.
  if ((foundInfo.length >= 3 && orgSchema) || foundInfo.length === 4) {
    checks.push(ck('Yritystiedot', 'pass', `Yhteystiedot (${listFi(foundInfo)}) löytyvät sivulta${orgSchema ? ' ja rakenteellisesta datasta' : ''}.`));
  } else if (foundInfo.length === 0 && !orgSchema) {
    checks.push(ck('Yritystiedot', 'warn', 'Etusivulta ei löytynyt yhteystietoja: puhelinta, sähköpostia, osoitetta tai Y-tunnusta.', infoTip));
  } else {
    const missingParts = [...missingInfo, ...(orgSchema ? [] : ['yhteystiedot rakenteellisessa datassa'])];
    checks.push(ck('Yritystiedot', 'warn', `${foundInfo.length ? `Sivulta löytyy ${listFi(foundInfo)}. ` : ''}Puuttuu: ${listFi(missingParts)}.`, infoTip));
  }

  return cat('ai', 'Tekoälyhaut', 'Voivatko ChatGPT ja muut tekoälyhaut suositella teitä?', score, max, checks, 2);
}

function analyzeKeywords($, pageLang, text, siteHost = '') {
  const checks = [];
  let score = 0, max = 0;

  const isEnglish = (pageLang || '').toLowerCase().startsWith('en');

  const FI_STOP = new Set(['ja','on','ei','se','että','ole','oli','ovat','tai','kun','niin','kuin','mutta','myös','voi','olla','jos','tämä','tässä','sen','sitä','joka','nämä','niitä','jossa','hän','he','me','te','ne','jne','eli','sekä','vai','tms','yli','alle','kanssa','mukaan','joiden','jonka','jotka','joita','niiden','tämän','näiden','siitä','näitä','niissä','joissa','enemmän','vähemmän','hyvin','erittäin','todella','melko','aivan','ihan','siis','kaikki','kaikkia','kaikista','jokainen','muu','muut','muita','jokin','joku','mitä','mikä','missä','miten','miksi','kuka','koska','paljon','vain','aina','usein','myöhemmin','ennen','jälkeen','edes','vielä','nyt','sitten','täällä','siellä','tänne','sinne','tähän','siihen','näin','noin','siten','kuten','esim','mm','yms','ym','www','http','https','com','html','the','and','for','you','with','this','that','are','from','your','all','not','was','will','can','has','been','have','had','but','our','one','their','more','about','which','when','would','there','each','than','its','into','also','how','other','what','some','them','these','most','may','then','very','just','any','new','only','such','over','many','well','between','much','both','own','still','before','after','through','should','back','where','even','too','off','out','got','get','did','made','say','down','long','find','here','way','two','now']);

  const bodyText = text.toLowerCase();
  const words = bodyText.match(/[a-zäöåéü]{3,}/g) || [];
  const filtered = words.filter(w => !FI_STOP.has(w) && w.length >= 4);
  const totalTerms = filtered.length;

  // Minimisisältökynnys — liian vähän tekstiä -> ei luotettavaa analyysiä
  if (totalTerms < 30) {
    checks.push(ck('Sisällön määrä', 'fail', 'Sivustolla on liian vähän tekstisisältöä avainsana-analyysiin.', 'Kirjoita sivulle vähintään 300 sanaa tekstiä palveluistanne. Hakukone tarvitsee tekstiä ymmärtääkseen, mistä sivu kertoo.'));
    return cat('keywords', 'Avainsanat', 'Tuoko sivusto ostavia asiakkaita vai satunnaisia kävijöitä?', 5, 100, checks, 2);
  }

  const freq = {};
  filtered.forEach(w => { freq[w] = (freq[w] || 0) + 1; });
  const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
  const topKeywords = sorted.slice(0, 20).map(([w]) => w);

  const title = ($('title').text() || '').replace(/­/g, '').toLowerCase();
  const desc = ($('meta[name="description"]').attr('content') || '').toLowerCase();
  const h1 = $('h1').first().text().replace(/­/g, '').toLowerCase();
  const metaText = `${title} ${desc} ${h1}`;

  // --- 1. Hakutuloksen otsikko ---
  max += 25;
  const metaTopMatch = topKeywords.slice(0, 5).filter(kw => metaText.includes(kw)).length;
  if (metaTopMatch >= 3) {
    checks.push(ck('Hakutuloksen otsikko', 'pass', `Sivun otsikko ja kuvaus vastaavat sivun sisältöä hyvin (${metaTopMatch}/5 ydintermiä löytyy).`));
    score += 25;
  } else if (metaTopMatch >= 1) {
    checks.push(ck('Hakutuloksen otsikko', 'warn', `Sivun otsikko ja kuvaus vastaavat sisältöä vain osittain (${metaTopMatch}/5 ydintermiä).`, 'Kirjoita otsikko ja kuvaus uudelleen niin, että niissä toistuvat sivun tärkeimmät aiheet, samat sanat, joilla asiakkaat palveluanne hakevat.'));
    score += 12;
  } else {
    checks.push(ck('Hakutuloksen otsikko', 'fail', 'Sivun otsikko ja kuvaus eivät kerro Googlelle, mistä sivu oikeasti kertoo.', 'Kirjoita otsikko ja kuvaus uudelleen sivun pääaiheen ympärille: mitä tarjoatte ja kenelle. Hakija näkee ne ennen kuin päättää, klikkaako.'));
  }

  // --- 2. Väärät kävijät (kontekstitietoinen) ---
  // Tunnista sivuston tarkoitus title/H1/meta -tekstistä
  const SITE_PURPOSE_SIGNALS = {
    ecommerce: ['verkkokauppa', 'kauppa', 'osta', 'tuotteet', 'tuote', 'tilaus', 'toimitus', 'shop', 'store', 'buy', 'product', 'cart', 'shopping'],
    recruitment: ['työpaikat', 'avoimet työpaikat', 'rekrytointi', 'työnhaku', 'työnantaja', 'careers', 'jobs', 'hiring'],
    education: ['koulutus', 'oppilaitos', 'yliopisto', 'ammattikorkeakoulu', 'koulu', 'university', 'school', 'academy'],
    media: ['uutiset', 'lehti', 'media', 'toimitus', 'artikkeli', 'news', 'magazine', 'editorial'],
    review: ['arvostelut', 'vertailu', 'reviews', 'comparison']
  };

  const detectedPurpose = new Set();
  Object.entries(SITE_PURPOSE_SIGNALS).forEach(([purpose, signals]) => {
    if (signals.some(s => metaText.includes(s))) detectedPurpose.add(purpose);
  });

  const TRAP_PATTERNS = [
    // Termit ovat sanan alkuja (taivutusmuodot mukana); '$' = koko sana. "Maksuton" ei ole mukana,
    // koska B2B-sivuilla se on tavallinen toimintakehotus (maksuton keskustelu, maksuton arvio).
    { terms: ['ilmai', 'free$'], label: '"ilmainen"-hakusanat', reason: 'Ilmaista etsivät harvoin ostavat — sivusto voi kerätä väärää yleisöä.', fix: 'Käytä "ilmainen"-sanoja vain siellä, missä tarjoatte oikeasti jotain maksutonta, ja kerro muualla palvelun arvosta ja tuloksista.', skipIf: ['ecommerce'] },
    { terms: ['työpaik', 'työnhak', 'työhakemu', 'rekry', 'avoimet työ', 'palkkau', 'palkka$', 'palkkaa$', 'uramahdollisu', 'urapolk', 'urakehity'], label: 'työnhaku-hakusanat', reason: 'Työnhakijat löytävät sivuston, vaikka he eivät ole potentiaalisia asiakkaita.', fix: 'Kokoa rekrytointisisältö omalle urasivulleen, jotta etusivu ja palvelusivut puhuttelevat asiakkaita.', skipIf: ['recruitment'] },
    { terms: ['kurssi', 'opiskel', 'tutkinto', 'tutkinno', 'oppimi', 'oppia$'], label: 'opiskelu-hakusanat', reason: 'Opiskelijat ja tiedonhakijat harvoin ostavat palveluita.', fix: 'Jos koulutus ei ole palvelunne, vähennä opiskeluun liittyviä sanoja palvelusivuilta ja kerro, mitä asiakas saa.', skipIf: ['education'] },
    { terms: ['kokemuksia$', 'arvostel', 'review', 'vertailu'], label: 'vertailu-hakusanat', reason: 'Vertailuhakijat ovat vasta tiedonhakuvaiheessa eivätkä yleensä ota yhteyttä.', fix: 'Kerro vertailujen ja arvostelujen yhteydessä, miksi asiakkaat valitsevat juuri teidät, ja lisää selkeä toimintakehotus.', skipIf: ['review'] },
    { terms: ['ohje$', 'ohjeet$', 'ohjeita$', 'ohjeen$', 'ohjeiden$', 'opas$', 'oppaa', 'tutorial', 'tee itse', 'tee-se-itse', 'itse tehden'], label: 'tee-se-itse -hakusanat', reason: 'Itse tekemisestä kiinnostuneet eivät yleensä osta palvelua.', fix: 'Pidä ohjeet ja oppaat omana sisältönään ja ohjaa niistä palveluun: kerro, milloin apua kannattaa pyytää.', skipIf: ['education', 'media'] },
  ];

  max += 25;
  const foundTraps = [];
  TRAP_PATTERNS.forEach(pattern => {
    if (pattern.skipIf && pattern.skipIf.some(p => detectedPurpose.has(p))) return;
    // Osuma vain sanan alusta: "ura" ei saa osua sanaan "seuraava" eikä "työ" sanaan "yhteistyö".
    const counts = pattern.terms.map(t => {
      const whole = t.endsWith('$');
      const re = new RegExp('(?<![\\p{L}])' + t.replace('$', '') + (whole ? '(?![\\p{L}])' : ''), 'gu');
      return (bodyText.match(re) || []).length;
    });
    const found = pattern.terms.filter((_, i) => counts[i] > 0);
    if (found.length > 0) {
      const count = counts.reduce((a, b) => a + b, 0);
      const ratio = count / totalTerms;
      if (count >= 5 && ratio >= 0.005) foundTraps.push({ ...pattern, found, count });
    }
  });

  if (foundTraps.length === 0) {
    checks.push(ck('Väärät kävijät', 'pass', 'Sivusto ei houkuttele väärää yleisöä — sisältö puhuttelee oikeita kävijöitä.'));
    score += 25;
  } else if (foundTraps.length <= 2) {
    const detail = foundTraps.map(t => t.label).join(' ja ');
    checks.push(ck('Väärät kävijät', 'warn', `Sivustolla on sanoja, jotka voivat tuoda vääriä kävijöitä: ${detail}. ${foundTraps[0].reason}`, foundTraps.map(t => t.fix).join(' ')));
    score += 12;
  } else {
    const detail = foundTraps.map(t => t.label).join(', ');
    checks.push(ck('Väärät kävijät', 'fail', `Sivusto voi näkyä hauissa, jotka tuovat kävijöitä jotka eivät osta: ${detail}.`, 'Käy läpi, missä yhteydessä sanoja käytetään, ja muotoile tekstit puhuttelemaan ostavaa asiakasta: kerro palvelun arvosta ja tuloksista. Siirrä muu sisältö, kuten rekrytointi tai ohjeet, omille sivuilleen.'));
  }

  // --- 3. Sisällön selkeys ---
  // Toistuuko sivun pääaihe (otsikko ja pääotsikko) läpi tekstin? Teksti jaetaan 100 sanan jaksoihin
  // ja lasketaan, monessako jaksossa pääaiheen sanat esiintyvät. Mittari ei riipu sivun pituudesta.
  // Sanat verrataan neljän kirjaimen alun perusteella, jotta taivutusmuodot ja yhdyssanat osuvat (Vantaalla ~ Vantaa).
  max += 25;
  const stem = w => w.slice(0, 4);
  const brandStems = new Set((siteHost.match(/[\p{L}]{4,}/gu) || []).map(stem));
  const topicStems = new Set(((title + ' ' + h1).match(/[\p{L}]{4,}/gu) || [])
    .filter(w => !FI_STOP.has(w)).map(stem).filter(st => !brandStems.has(st)));
  const allWords = bodyText.match(/[\p{L}]+/gu) || [];
  const chunks = [];
  for (let i = 0; i < allWords.length; i += 100) chunks.push(allWords.slice(i, i + 100));
  const coveredChunks = chunks.filter(ch => ch.some(w => w.length >= 4 && topicStems.has(stem(w)))).length;
  const topicCoverage = topicStems.size && chunks.length ? coveredChunks / chunks.length : 0;

  if (topicCoverage >= 0.6) {
    checks.push(ck('Sisällön selkeys', 'pass', `Sivusto kertoo selkeästi yhdestä aiheesta — Google ymmärtää mistä on kyse.`));
    score += 25;
  } else if (topicCoverage >= 0.3) {
    checks.push(ck('Sisällön selkeys', 'warn', `Sivuston viesti hajoaa useaan suuntaan — Google ei ole varma, mistä sivu kertoo.`, 'Valitse sivulle 1–3 ydinteemaa ja rakenna otsikot ja tekstit niiden ympärille. Muut aiheet kannattaa siirtää omille sivuilleen.'));
    score += 12;
  } else {
    checks.push(ck('Sisällön selkeys', 'fail', `Sivusto puhuu liian monesta asiasta — hakukone ei osaa yhdistää sitä mihinkään hakuun.`, 'Jaa sisältö aiheittain omille sivuilleen niin, että jokaisella sivulla on yksi selkeä pääaihe. Silloin Google osaa näyttää sivut oikeille hakijoille.'));
  }

  // --- 4. Myyntivalmius (kielitietoinen) ---
  max += 25;
  const FI_COMMERCIAL = ['ota yhteyttä', 'varaa', 'tilaa', 'pyydä tarjous', 'hinnat', 'hinta', 'palvelu', 'palvelut', 'ratkaisu', 'ratkaisut', 'asiakkaat', 'yritys', 'yrityksille', 'liiketoiminta', 'myynti', 'kasvu', 'tulos', 'tuloksia', 'tuotto', 'sijoitus'];
  const FI_INFO = ['blogi', 'artikkeli', 'opas', 'ohje', 'vinkit', 'näin teet', 'mikä on', 'mitä tarkoittaa', 'usein kysytyt', 'faq', 'wiki'];
  const EN_COMMERCIAL = ['contact us', 'get started', 'book a demo', 'request a quote', 'pricing', 'price', 'plans', 'free trial', 'sign up', 'subscribe', 'buy now', 'add to cart', 'service', 'services', 'solution', 'solutions', 'customers', 'business', 'enterprise', 'revenue', 'growth', 'roi', 'results'];
  const EN_INFO = ['blog', 'article', 'guide', 'tutorial', 'tips', 'how to', 'what is', 'learn more', 'faq', 'wiki', 'documentation', 'resources'];

  const commercialSignals = isEnglish ? EN_COMMERCIAL : FI_COMMERCIAL;
  const infoSignals = isEnglish ? EN_INFO : FI_INFO;
  const commercialCount = commercialSignals.filter(t => bodyText.includes(t)).length;
  const infoCount = infoSignals.filter(t => bodyText.includes(t)).length;

  if (commercialCount >= 5 && infoCount <= 3) {
    checks.push(ck('Myyntivalmius', 'pass', `Sivusto ohjaa kävijän kohti yhteydenottoa — palvelut, hinnat ja toimintakehotukset ovat selkeästi esillä.`));
    score += 25;
  } else if (commercialCount >= 3) {
    checks.push(ck('Myyntivalmius', 'warn', `Sivustolla on myyntisisältöä, mutta kävijä ei välttämättä ymmärrä mitä tehdä seuraavaksi.`, 'Lisää palvelukuvausten yhteyteen selkeä toimintakehotus, esimerkiksi "Pyydä tarjous" tai "Varaa keskustelu", ja pidä yhteystiedot näkyvillä.'));
    score += 15;
  } else {
    checks.push(ck('Myyntivalmius', 'fail', `Sivusto kertoo, mutta ei myy — kävijä saa tietoa mutta ei syytä ottaa yhteyttä.`, 'Kerro selkeästi, mitä tarjoatte, kenelle ja miten pääsee alkuun. Lisää sivulle näkyvä toimintakehotus ja yhteystiedot.'));
  }

  return cat('keywords', 'Avainsanat', 'Tuoko sivusto ostavia asiakkaita vai satunnaisia kävijöitä?', score, max, checks, 2);
}

function cat(id, label, desc, score, max, checks, weight) {
  return { id, label, description: desc, score: max > 0 ? Math.round((score / max) * 100) : 0, checks, weight };
}

function ck(label, status, message, tip) {
  return { label, status, message, tip: tip || null };
}

function trunc(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function makeSummary(score) {
  if (score >= 85) return 'Sivustosi perusta on vahva. Hienosäädöllä näkyvyydestä saa vielä enemmän irti asiakashankintaan.';
  if (score >= 60) return 'Hyvä lähtötilanne, jossa on selkeitä kehityskohteita. Pienilläkin korjauksilla näkyvyys voi kasvaa selvästi.';
  if (score >= 35) return 'Sivustossa on paljon hyödyntämätöntä potentiaalia. Kun tärkeimmät kohdat korjataan oikeassa järjestyksessä, näkyvyys paranee nopeasti.';
  return 'Sivustossa on paljon kasvuvaraa. Perusteiden korjaaminen on nopein tapa saada lisää näkyvyyttä ja yhteydenottoja.';
}

app.listen(PORT, () => {
  console.log(`SEO Checker running at http://localhost:${PORT}`);
});
