const express = require('express');
const cheerio = require('cheerio');
const path = require('path');
const fs = require('fs');

const app = express();
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

app.post('/api/check', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL puuttuu' });

  let targetUrl = url.trim();
  if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;

  try { new URL(targetUrl); }
  catch { return res.status(400).json({ error: 'Virheellinen URL' }); }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const fetchStart = Date.now();
    const response = await fetch(targetUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'SEOSalesChecker/1.0 (+https://seosales.fi)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'fi,en;q=0.9',
      },
      redirect: 'follow',
    });
    const responseTimeMs = Date.now() - fetchStart;
    clearTimeout(timeout);

    if (!response.ok) return res.status(502).json({ error: `Sivusto vastasi virheellä: ${response.status}` });

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      return res.status(400).json({ error: 'URL ei palauttanut HTML-sivua' });
    }

    const html = await response.text();

    // Tarkista robots.txt ja sitemap rinnakkain
    const parsedOrigin = new URL(targetUrl).origin;
    const [robotsOk, sitemapOk] = await Promise.all([
      fetch(`${parsedOrigin}/robots.txt`, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'SEOSalesChecker/1.0' } })
        .then(r => r.ok && (r.headers.get('content-type') || '').includes('text/plain'))
        .catch(() => false),
      fetch(`${parsedOrigin}/sitemap.xml`, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'SEOSalesChecker/1.0' } })
        .then(r => r.ok && ((r.headers.get('content-type') || '').includes('xml') || (r.headers.get('content-type') || '').includes('text/')))
        .catch(() => false),
    ]);

    const results = analyze(html, targetUrl, { responseTimeMs, robotsOk, sitemapOk });

    saveAnalysis({
      url: targetUrl,
      score: results.score,
      categories: results.categories.map(c => ({ id: c.id, score: c.score })),
      timestamp: new Date().toISOString(),
    });

    res.json(results);
  } catch (err) {
    if (err.name === 'AbortError') return res.status(504).json({ error: 'Sivuston lataus kesti liian kauan (yli 15 s)' });
    return res.status(502).json({ error: `Sivustoa ei voitu hakea: ${err.message}` });
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

function buildReportHTML({ url, score, summary, categories }) {
  const date = new Date().toLocaleDateString('fi-FI');
  const cats = Array.isArray(categories) ? categories : [];
  const allChecks = cats.flatMap(c => (c.checks || []).map(ch => ({ ...ch, catLabel: c.label })));
  const fails = allChecks.filter(c => c.status === 'fail');
  const warns = allChecks.filter(c => c.status === 'warn');
  const passes = allChecks.filter(c => c.status === 'pass');
  const CTA_URL = 'https://seosales.fi/yhteys.html';

  const catScoreBlock = cats.map(c => `
    <td style="text-align:center;padding:12px 8px;width:${Math.floor(100/Math.max(cats.length,1))}%">
      <div style="font-size:28px;font-weight:700;color:${scoreHex(c.score)}">${c.score}</div>
      <div style="font-size:12px;color:#807F88;text-transform:uppercase;letter-spacing:0.06em;margin-top:4px">${esc(c.label)}</div>
    </td>`).join('');

  const issueBlock = (items, sectionTitle, color) => {
    if (!items.length) return '';
    let html = `
    <tr><td style="padding:32px 40px 8px">
      <h2 style="font-size:18px;font-weight:600;color:${color};margin:0">${sectionTitle} (${items.length})</h2>
    </td></tr>`;
    items.forEach(ch => {
      html += `
    <tr><td style="padding:16px 40px">
      <div style="border-left:3px solid ${color};padding-left:16px">
        <div style="font-size:15px;font-weight:600;color:#17161C;margin-bottom:4px">${esc(ch.label)}</div>
        <div style="font-size:14px;color:#34333C;line-height:1.6">${esc(ch.message)}</div>
        ${ch.tip ? `<div style="font-size:13px;color:#807F88;margin-top:6px;line-height:1.5"><strong>Miten korjata:</strong> ${esc(ch.tip)}</div>` : ''}
        <div style="margin-top:10px">
          <a href="${CTA_URL}" style="font-size:12px;color:#6D4AFF;text-decoration:none;font-weight:600;letter-spacing:0.03em">Haluatko, ett&auml; k&auml;ymme t&auml;m&auml;n yhdess&auml; l&auml;pi? Varaa maksuton tapaaminen &rarr;</a>
        </div>
      </div>
    </td></tr>`;
    });
    return html;
  };

  const passBlock = passes.length ? `
    <tr><td style="padding:32px 40px 8px">
      <h2 style="font-size:18px;font-weight:600;color:#27AE60;margin:0">N&auml;m&auml; ovat kunnossa</h2>
    </td></tr>
    <tr><td style="padding:8px 40px 16px">
      ${passes.map(ch => `<div style="font-size:14px;color:#34333C;padding:5px 0;line-height:1.5">&#10003; ${esc(ch.label)}: ${esc(ch.message)}</div>`).join('')}
    </td></tr>` : '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#F5F5F7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F5F5F7;padding:24px 0">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.06)">

  <!-- Header -->
  <tr><td style="background:#17161C;padding:28px 40px;text-align:center">
    <div style="font-size:20px;font-weight:700;color:#FFFFFF;letter-spacing:-0.02em">SEO Sales</div>
    <div style="font-size:13px;color:#C6C2D1;margin-top:4px">N&auml;kyvyysanalyysi</div>
  </td></tr>

  <!-- Score hero -->
  <tr><td style="padding:32px 40px 12px;text-align:center">
    <div style="font-size:13px;color:#807F88;margin-bottom:8px">${esc(url)}</div>
    <div style="font-size:13px;color:#807F88;margin-bottom:20px">Tarkistettu: ${date}</div>
    <div style="display:inline-block;width:100px;height:100px;border-radius:50%;border:6px solid ${scoreHex(score)};text-align:center;line-height:88px">
      <span style="font-size:36px;font-weight:700;color:${scoreHex(score)}">${score}</span>
    </div>
    <div style="font-size:14px;font-weight:600;color:${scoreHex(score)};margin-top:8px">${scoreLabel(score)}</div>
    ${summary ? `<div style="font-size:14px;color:#807F88;margin-top:8px;line-height:1.5">${esc(summary)}</div>` : ''}
  </td></tr>

  <!-- Category scores -->
  <tr><td style="padding:16px 24px 24px">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>${catScoreBlock}</tr>
    </table>
  </td></tr>

  <!-- Divider -->
  <tr><td style="padding:0 40px"><div style="border-top:1.5px solid #E8E8EC"></div></td></tr>

  <!-- Critical issues -->
  ${issueBlock(fails, 'Kriittiset ongelmat', '#C0392B')}

  <!-- Warnings -->
  ${issueBlock(warns, 'Huomioitavaa', '#E67E22')}

  <!-- Passing -->
  ${passBlock}

  <!-- Divider -->
  <tr><td style="padding:16px 40px 0"><div style="border-top:1.5px solid #E8E8EC"></div></td></tr>

  <!-- Bottom CTA -->
  <tr><td style="padding:36px 40px;text-align:center;background:#17161C">
    <div style="font-size:22px;font-weight:700;color:#FFFFFF;margin-bottom:8px">N&auml;kyvyys kuntoon &mdash; yhdess&auml;</div>
    <div style="font-size:14px;color:#C6C2D1;line-height:1.6;margin-bottom:20px;max-width:440px;margin-left:auto;margin-right:auto">
      T&auml;m&auml; analyysi kattaa perusteet. Tapaamisessa p&auml;&auml;st&auml;&auml;n syvemm&auml;lle &mdash; k&auml;ymme l&auml;pi juuri teid&auml;n yritykselle t&auml;rkeimm&auml;t kehityskohteet ja rakennamme suunnitelman.
    </div>
    <a href="${CTA_URL}" style="display:inline-block;background:#FFFFFF;color:#17161C;font-size:13px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;padding:14px 32px;border-radius:8px;text-decoration:none">Varaa maksuton tapaaminen</a>
  </td></tr>

  <!-- Footer -->
  <tr><td style="padding:20px 40px;text-align:center">
    <div style="font-size:12px;color:#807F88">
      <a href="https://seosales.fi" style="color:#6D4AFF;text-decoration:none">SEO Sales</a> &mdash; n&auml;kyvyydest&auml; kasvuun
    </div>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

app.post('/api/lead', (req, res) => {
  const { email, phone, newsletter, url, score, categories, summary } = req.body;
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

  const reportHtml = buildReportHTML({ url: lead.url, score: lead.score, summary, categories });

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

app.get('/api/report-preview', async (req, res) => {
  const testUrl = req.query.url || 'https://esimerkki.fi';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const fetchStart = Date.now();
    const response = await fetch(testUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'SEOSalesChecker/1.0', 'Accept': 'text/html' },
      redirect: 'follow',
    });
    clearTimeout(timeout);
    const responseTimeMs = Date.now() - fetchStart;
    const html = await response.text();

    const parsedOrigin = new URL(testUrl).origin;
    const [robotsOk, sitemapOk] = await Promise.all([
      fetch(`${parsedOrigin}/robots.txt`, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'SEOSalesChecker/1.0' }, redirect: 'follow' })
        .then(r => r.ok && (r.headers.get('content-type') || '').includes('text/plain'))
        .catch(() => false),
      fetch(`${parsedOrigin}/sitemap.xml`, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'SEOSalesChecker/1.0' }, redirect: 'follow' })
        .then(r => r.ok && ((r.headers.get('content-type') || '').includes('xml') || (r.headers.get('content-type') || '').includes('text/')))
        .catch(() => false),
    ]);

    const data = analyze(html, testUrl, { responseTimeMs, robotsOk, sitemapOk });
    const reportHtml = buildReportHTML({ url: data.url, score: data.score, summary: data.summary, categories: data.categories });
    res.send(reportHtml);
  } catch (err) {
    res.status(500).send('Virhe: ' + err.message);
  }
});

function analyze(html, url, extra = {}) {
  const $ = cheerio.load(html);
  const parsedUrl = new URL(url);

  const seo = analyzeSEO($, url);
  const technical = analyzeTechnical($, url, extra);
  const content = analyzeContent($);
  const social = analyzeSocial($);
  const ai = analyzeAI($);
  const lang = $('html').attr('lang') || '';
  const keywords = analyzeKeywords($, lang);

  const categories = [seo, technical, content, social, ai, keywords];
  const totalWeight = categories.reduce((s, c) => s + c.weight, 0);
  const overallScore = Math.round(categories.reduce((s, c) => s + c.score * c.weight, 0) / totalWeight);

  return {
    url,
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

function analyzeSEO($, url) {
  const checks = [];
  let score = 0, max = 0;

  const title = $('title').first().text().trim();
  max += 15;
  if (!title) {
    checks.push(ck('Title-tagi', 'fail', 'Title-tagi puuttuu kokonaan.', 'Lisää <title> sivulle — se on tärkein yksittäinen SEO-elementti.'));
  } else if (title.length < 30) {
    checks.push(ck('Title-tagi', 'warn', `Title on lyhyt (${title.length} merkkiä).`, 'Suositeltu pituus on 50–60 merkkiä.'));
    score += 7;
  } else if (title.length > 60) {
    checks.push(ck('Title-tagi', 'warn', `Title on pitkä (${title.length} merkkiä).`, 'Google katkaisee yleensä yli 60 merkin titlet.'));
    score += 9;
  } else {
    checks.push(ck('Title-tagi', 'pass', `Title on hyvä (${title.length} merkkiä).`));
    score += 15;
  }

  const desc = $('meta[name="description"]').attr('content')?.trim() || '';
  max += 15;
  if (!desc) {
    checks.push(ck('Meta description', 'fail', 'Meta description puuttuu.', 'Meta description näkyy hakutuloksissa ja vaikuttaa klikkausprosenttiin.'));
  } else if (desc.length < 70) {
    checks.push(ck('Meta description', 'warn', `Description on lyhyt (${desc.length} merkkiä).`, 'Suositeltu pituus on 140–160 merkkiä.'));
    score += 7;
  } else if (desc.length > 160) {
    checks.push(ck('Meta description', 'warn', `Description on pitkä (${desc.length} merkkiä).`, 'Google katkaisee yleensä yli 160 merkin descriptionit.'));
    score += 9;
  } else {
    checks.push(ck('Meta description', 'pass', `Meta description on hyvä (${desc.length} merkkiä).`));
    score += 15;
  }

  const h1s = $('h1');
  max += 10;
  if (h1s.length === 0) {
    checks.push(ck('H1-otsikko', 'fail', 'H1-otsikko puuttuu.', 'Jokaisella sivulla tulisi olla täsmälleen yksi H1-otsikko.'));
  } else if (h1s.length > 1) {
    checks.push(ck('H1-otsikko', 'warn', `Sivulla on ${h1s.length} H1-otsikkoa.`, 'Suosituksena on yksi H1 per sivu.'));
    score += 5;
  } else {
    checks.push(ck('H1-otsikko', 'pass', `H1 löytyy: "${trunc(h1s.first().text().trim(), 60)}"`));
    score += 10;
  }

  const canonical = $('link[rel="canonical"]').attr('href') || '';
  max += 10;
  if (!canonical) {
    checks.push(ck('Canonical-URL', 'warn', 'Canonical-tagi puuttuu.', 'Canonical estää duplikaattiongelmia hakutuloksissa.'));
  } else {
    checks.push(ck('Canonical-URL', 'pass', 'Canonical-URL on asetettu.'));
    score += 10;
  }

  const links = $('a[href]');
  let internal = 0, external = 0;
  links.each((_, el) => {
    const href = $(el).attr('href') || '';
    if (/^(#|javascript:|mailto:|tel:)/.test(href)) return;
    try {
      const lUrl = new URL(href, url);
      if (lUrl.hostname === new URL(url).hostname) internal++; else external++;
    } catch { internal++; }
  });
  max += 10;
  if (internal === 0) {
    checks.push(ck('Sisäiset linkit', 'warn', 'Sisäisiä linkkejä ei löytynyt.', 'Sisäiset linkit auttavat hakukoneita ymmärtämään sivuston rakennetta.'));
  } else {
    checks.push(ck('Sisäiset linkit', 'pass', `${internal} sisäistä, ${external} ulkoista linkkiä.`));
    score += 10;
  }

  return cat('seo', 'SEO', 'Hakukonenäkyvyys', score, max, checks, 3);
}

function analyzeTechnical($, url, extra = {}) {
  const checks = [];
  let score = 0, max = 0;

  max += 20;
  if (url.startsWith('https://')) {
    checks.push(ck('HTTPS', 'pass', 'Sivusto käyttää suojattua HTTPS-yhteyttä.'));
    score += 20;
  } else {
    checks.push(ck('HTTPS', 'fail', 'Sivusto ei käytä HTTPS:ää.', 'HTTPS on ranking-signaali ja välttämätön käyttäjien luottamuksen kannalta.'));
  }

  const viewport = $('meta[name="viewport"]').attr('content') || '';
  max += 15;
  if (!viewport) {
    checks.push(ck('Mobiilioptimointi', 'fail', 'Viewport-metatagi puuttuu.', 'Lisää viewport-meta jotta sivusto skaalautuu mobiilissa.'));
  } else {
    checks.push(ck('Mobiilioptimointi', 'pass', 'Viewport on asetettu mobiililaitteille.'));
    score += 15;
  }

  const lang = $('html').attr('lang') || '';
  max += 10;
  if (!lang) {
    checks.push(ck('Kieliasetus', 'warn', 'HTML lang-attribuutti puuttuu.', 'Kieliasetus auttaa hakukoneita ja ruudunlukijoita.'));
  } else {
    checks.push(ck('Kieliasetus', 'pass', `Kieli asetettu: "${lang}".`));
    score += 10;
  }

  const robotsMeta = $('meta[name="robots"]').attr('content') || '';
  max += 10;
  if (robotsMeta.includes('noindex')) {
    checks.push(ck('Indeksointi', 'fail', 'Sivulla on noindex — hakukoneet eivät indeksoi sivua.', 'Poista noindex jos haluat sivun näkyvän hakutuloksissa.'));
  } else {
    checks.push(ck('Indeksointi', 'pass', 'Sivu sallii hakukoneindeksoinnin.'));
    score += 10;
  }

  const charset = $('meta[charset]').attr('charset') || $('meta[http-equiv="Content-Type"]').attr('content') || '';
  max += 10;
  if (!charset && !$('meta[charset]').length) {
    checks.push(ck('Merkistökoodaus', 'warn', 'Charset-määrittelyä ei löytynyt.', 'Lisää <meta charset="UTF-8"> sivun alkuun.'));
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
      checks.push(ck('Vasteaika', 'warn', `Palvelimen vasteaika on kohtalainen (${ms} ms).`, 'Alle 800 ms vasteaika parantaa käyttäjäkokemusta ja hakukonenäkyvyyttä.'));
      score += 8;
    } else {
      checks.push(ck('Vasteaika', 'fail', `Palvelin vastaa hitaasti (${ms} ms).`, 'Hidas sivusto menettää kävijöitä ja hakukonesijoituksia. Alle 2 sekunnin vasteaika on tavoite.'));
    }
  }

  // Robots.txt
  if (extra.robotsOk != null) {
    max += 10;
    if (extra.robotsOk) {
      checks.push(ck('Robots.txt', 'pass', 'Robots.txt-tiedosto löytyi — hakukoneet tietävät mitä indeksoida.'));
      score += 10;
    } else {
      checks.push(ck('Robots.txt', 'warn', 'Robots.txt-tiedostoa ei löytynyt.', 'Robots.txt kertoo hakukoneille mitkä osat sivustosta indeksoidaan. Sen puuttuminen ei estä indeksointia, mutta voi johtaa turhien sivujen indeksointiin.'));
    }
  }

  // Sitemap
  if (extra.sitemapOk != null) {
    max += 10;
    if (extra.sitemapOk) {
      checks.push(ck('Sivukartta', 'pass', 'XML-sivukartta löytyi — hakukoneet löytävät kaikki sivut.'));
      score += 10;
    } else {
      checks.push(ck('Sivukartta', 'warn', 'XML-sivukarttaa (sitemap.xml) ei löytynyt.', 'Sivukartta auttaa hakukoneita löytämään ja indeksoimaan kaikki sivut tehokkaammin.'));
    }
  }

  return cat('technical', 'Tekninen', 'Tekniset perusteet', score, max, checks, 2);
}

function analyzeContent($) {
  const checks = [];
  let score = 0, max = 0;

  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const wordCount = bodyText.split(/\s+/).length;
  max += 20;
  if (wordCount < 100) {
    checks.push(ck('Sisällön määrä', 'fail', `Noin ${wordCount} sanaa.`, 'Vähintään 300 sanaa on hyvä lähtökohta.'));
  } else if (wordCount < 300) {
    checks.push(ck('Sisällön määrä', 'warn', `Noin ${wordCount} sanaa — voisi olla enemmän.`, '500+ sanaa mahdollistaa paremman sijoittumisen.'));
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
    checks.push(ck('Otsikkorakenne', 'fail', 'Sivulla ei ole yhtään otsikkoa.', 'Lisää otsikkorakenne (H1–H6) jäsentämään sisältöä.'));
  } else if (!hierarchyOk) {
    checks.push(ck('Otsikkorakenne', 'warn', 'Otsikkotasot hyppäävät (esim. H2 → H4).', 'Pidä rakenne loogisena: H1 → H2 → H3.'));
    score += 7;
  } else {
    checks.push(ck('Otsikkorakenne', 'pass', `${headings.length} otsikkoa, rakenne on looginen.`));
    score += 15;
  }

  const images = $('img');
  const noAlt = images.filter((_, el) => {
    const alt = $(el).attr('alt');
    return alt === undefined || alt.trim() === '';
  });
  max += 15;
  if (images.length === 0) {
    checks.push(ck('Kuvien alt-tekstit', 'warn', 'Sivulla ei ole kuvia.', 'Kuvat voivat parantaa käyttökokemusta.'));
    score += 7;
  } else if (noAlt.length > 0) {
    checks.push(ck('Kuvien alt-tekstit', 'fail', `${noAlt.length}/${images.length} kuvalta puuttuu alt-teksti.`, 'Alt-tekstit parantavat saavutettavuutta ja hakukonenäkyvyyttä.'));
    score += Math.round(15 * (1 - noAlt.length / images.length));
  } else {
    checks.push(ck('Kuvien alt-tekstit', 'pass', `Kaikilla ${images.length} kuvalla on alt-teksti.`));
    score += 15;
  }

  return cat('content', 'Sisältö', 'Sisällön laatu', score, max, checks, 2);
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
    checks.push(ck('Open Graph', 'fail', 'Open Graph -tagit puuttuvat.', 'OG-tagit määrittävät miltä sivusi näyttää jaettaessa sosiaalisessa mediassa.'));
  } else if (ogCount < 3) {
    const missing = [];
    if (!ogTitle) missing.push('og:title');
    if (!ogDesc) missing.push('og:description');
    if (!ogImage) missing.push('og:image');
    checks.push(ck('Open Graph', 'warn', `Osittain kunnossa. Puuttuu: ${missing.join(', ')}.`, 'Lisää puuttuvat OG-tagit.'));
    score += Math.round(30 * ogCount / 3);
  } else {
    checks.push(ck('Open Graph', 'pass', 'og:title, og:description ja og:image löytyvät.'));
    score += 30;
  }

  const twCard = $('meta[name="twitter:card"]').attr('content') || '';
  const twTitle = $('meta[name="twitter:title"]').attr('content') || '';
  max += 20;
  if (!twCard && !twTitle) {
    checks.push(ck('Twitter/X-kortit', 'warn', 'Twitter Card -tagit puuttuvat.', 'Lisää twitter:card ja twitter:title jakonäkymän parantamiseksi.'));
  } else {
    checks.push(ck('Twitter/X-kortit', 'pass', 'Twitter Card -tagit löytyvät.'));
    score += 20;
  }

  const favicon = $('link[rel="icon"]').length || $('link[rel="shortcut icon"]').length;
  max += 10;
  if (!favicon) {
    checks.push(ck('Favicon', 'warn', 'Favicon puuttuu.', 'Favicon näkyy selainvälilehdessä ja hakutuloksissa.'));
  } else {
    checks.push(ck('Favicon', 'pass', 'Favicon on asetettu.'));
    score += 10;
  }

  return cat('social', 'Sosiaalinen', 'Jakamisnäkyvyys', score, max, checks, 1);
}

function analyzeAI($) {
  const checks = [];
  let score = 0, max = 0;

  const jsonLd = $('script[type="application/ld+json"]');
  max += 25;
  if (jsonLd.length === 0) {
    checks.push(ck('Rakenteellinen data', 'warn', 'JSON-LD-merkintöjä ei löytynyt.', 'Schema.org-merkinnät auttavat tekoälyjä ymmärtämään sivuston sisällön.'));
  } else {
    checks.push(ck('Rakenteellinen data', 'pass', `${jsonLd.length} JSON-LD-lohkoa löytyi.`));
    score += 25;
  }

  const headingTexts = [];
  $('h2,h3,h4').each((_, el) => headingTexts.push($(el).text().trim()));
  const questionHeadings = headingTexts.filter(t => /\?$/.test(t) || /^(miksi|miten|mitä|milloin|kuinka|what|how|why|when)/i.test(t));
  max += 25;
  if (questionHeadings.length === 0) {
    checks.push(ck('Kysymysmuotoiset otsikot', 'warn', 'Kysymysmuotoisia otsikoita ei löytynyt.', 'Kysymys-vastaus-muotoinen sisältö parantaa näkyvyyttä tekoälyhauissa ja FAQ-snippeteissä.'));
  } else {
    checks.push(ck('Kysymysmuotoiset otsikot', 'pass', `${questionHeadings.length} kysymysmuotoista otsikkoa löytyi.`));
    score += 25;
  }

  const faqSchema = jsonLd.toArray().some(el => {
    try { return JSON.stringify($(el).html()).includes('FAQPage'); } catch { return false; }
  });
  max += 15;
  if (faqSchema) {
    checks.push(ck('FAQ-schema', 'pass', 'FAQPage-schema löytyi — tukee hakutulosten rich snippettejä.'));
    score += 15;
  } else {
    checks.push(ck('FAQ-schema', 'warn', 'FAQPage-schemaa ei löytynyt.', 'FAQ-schema voi tuoda lisänäkyvyyttä hakutuloksiin.'));
  }

  const metaRobots = $('meta[name="robots"]').attr('content') || '';
  max += 15;
  if (metaRobots.includes('noai') || metaRobots.includes('noimageai')) {
    checks.push(ck('Tekoälypääsy', 'warn', 'Sivusto estää tekoälybotteja.', 'Jos haluat näkyä tekoälyhauissa, tarkista robots-asetukset.'));
  } else {
    checks.push(ck('Tekoälypääsy', 'pass', 'Sivusto sallii tekoälybottien pääsyn.'));
    score += 15;
  }

  return cat('ai', 'Tekoälynäkyvyys', 'GEO & AI Visibility', score, max, checks, 2);
}

function analyzeKeywords($, pageLang) {
  const checks = [];
  let score = 0, max = 0;

  const isEnglish = (pageLang || '').toLowerCase().startsWith('en');

  const FI_STOP = new Set(['ja','on','ei','se','että','ole','oli','ovat','tai','kun','niin','kuin','mutta','myös','voi','olla','jos','tämä','tässä','sen','sitä','joka','nämä','niitä','jossa','hän','he','me','te','ne','jne','eli','sekä','vai','tms','yli','alle','kanssa','mukaan','joiden','jonka','jotka','joita','niiden','tämän','näiden','siitä','näitä','niissä','joissa','enemmän','vähemmän','hyvin','erittäin','todella','melko','aivan','ihan','siis','kaikki','kaikkia','kaikista','jokainen','muu','muut','muita','jokin','joku','mitä','mikä','missä','miten','miksi','kuka','koska','paljon','vain','aina','usein','myöhemmin','ennen','jälkeen','edes','vielä','nyt','sitten','täällä','siellä','tänne','sinne','tähän','siihen','näin','noin','siten','kuten','esim','mm','yms','ym','www','http','https','com','html','the','and','for','you','with','this','that','are','from','your','all','not','was','will','can','has','been','have','had','but','our','one','their','more','about','which','when','would','there','each','than','its','into','also','how','other','what','some','them','these','most','may','then','very','just','any','new','only','such','over','many','well','between','much','both','own','still','before','after','through','should','back','where','even','too','off','out','got','get','did','made','say','down','long','find','here','way','two','now']);

  const bodyText = $('body').text().replace(/\s+/g, ' ').toLowerCase();
  const words = bodyText.match(/[a-zäöåéü]{3,}/g) || [];
  const filtered = words.filter(w => !FI_STOP.has(w) && w.length >= 4);
  const totalTerms = filtered.length;

  // Minimisisältökynnys — liian vähän tekstiä -> ei luotettavaa analyysiä
  if (totalTerms < 30) {
    checks.push(ck('Sisällön määrä', 'fail', 'Sivustolla on liian vähän tekstisisältöä avainsana-analyysiin.', 'Hakukoneet tarvitsevat riittävästi tekstiä ymmärtääkseen, mistä sivu kertoo. Alle 100 sanaa ei riitä.'));
    return cat('keywords', 'Avainsanat', 'Löytävätkö oikeat asiakkaat sivustosi?', 5, 100, checks, 2);
  }

  const freq = {};
  filtered.forEach(w => { freq[w] = (freq[w] || 0) + 1; });
  const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
  const topKeywords = sorted.slice(0, 20).map(([w]) => w);

  const title = ($('title').text() || '').toLowerCase();
  const desc = ($('meta[name="description"]').attr('content') || '').toLowerCase();
  const h1 = $('h1').first().text().toLowerCase();
  const metaText = `${title} ${desc} ${h1}`;

  // --- 1. Hakutuloksen otsikko ---
  max += 25;
  const metaTopMatch = topKeywords.slice(0, 5).filter(kw => metaText.includes(kw)).length;
  if (metaTopMatch >= 3) {
    checks.push(ck('Hakutuloksen otsikko', 'pass', `Sivun otsikko ja kuvaus vastaavat sivun sisältöä hyvin (${metaTopMatch}/5 ydintermiä löytyy).`));
    score += 25;
  } else if (metaTopMatch >= 1) {
    checks.push(ck('Hakutuloksen otsikko', 'warn', `Sivun otsikko ja kuvaus vastaavat sisältöä vain osittain (${metaTopMatch}/5 ydintermiä).`, 'Kun otsikko ja kuvaus heijastavat sivun oikeita teemoja, Google näyttää sivun oikeille hakijoille.'));
    score += 12;
  } else {
    checks.push(ck('Hakutuloksen otsikko', 'fail', 'Sivun otsikko ja kuvaus eivät kerro Googlelle, mistä sivu oikeasti kertoo.', 'Hakijat näkevät otsikon ja kuvauksen ennen kuin klikkaavat — ne ratkaisevat, tuleeko kävijöitä.'));
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
    { terms: ['ilmainen', 'ilmaiseksi', 'ilmaista', 'maksuton', 'free'], label: '"ilmainen"-hakusanat', reason: 'Ilmaista etsivät harvoin ostavat — sivusto voi kerätä väärää yleisöä.', skipIf: ['ecommerce'] },
    { terms: ['työ', 'työpaikka', 'rekry', 'avoimet', 'palkka', 'ura', 'työnhaku'], label: 'työnhaku-hakusanat', reason: 'Työnhakijat löytävät sivuston, vaikka he eivät ole potentiaalisia asiakkaita.', skipIf: ['recruitment'] },
    { terms: ['koulutus', 'kurssi', 'opiskelu', 'tutkinto', 'oppiminen', 'oppia'], label: 'opiskelu-hakusanat', reason: 'Opiskelijat ja tiedonhakijat harvoin ostavat palveluita.', skipIf: ['education'] },
    { terms: ['kokemuksia', 'arvostelu', 'arvostelut', 'review', 'vertailu'], label: 'vertailu-hakusanat', reason: 'Vertailuhakijat ovat vasta tiedonhakuvaiheessa eivätkä yleensä ota yhteyttä.', skipIf: ['review'] },
    { terms: ['ohje', 'opas', 'tutorial', 'miten', 'kuinka'], label: 'tee-se-itse -hakusanat', reason: 'Itse tekemisestä kiinnostuneet eivät yleensä osta palvelua.', skipIf: ['education', 'media'] },
  ];

  max += 25;
  const foundTraps = [];
  TRAP_PATTERNS.forEach(pattern => {
    if (pattern.skipIf && pattern.skipIf.some(p => detectedPurpose.has(p))) return;
    const found = pattern.terms.filter(t => bodyText.includes(t));
    if (found.length > 0) {
      const count = found.reduce((s, t) => s + (bodyText.split(t).length - 1), 0);
      const ratio = count / totalTerms;
      if (count >= 5 && ratio >= 0.005) foundTraps.push({ ...pattern, found, count });
    }
  });

  if (foundTraps.length === 0) {
    checks.push(ck('Väärät kävijät', 'pass', 'Sivusto ei houkuttele väärää yleisöä — sisältö puhuttelee oikeita kävijöitä.'));
    score += 25;
  } else if (foundTraps.length <= 2) {
    const detail = foundTraps.map(t => t.label).join(' ja ');
    checks.push(ck('Väärät kävijät', 'warn', `Sivustolla on sanoja, jotka voivat tuoda vääriä kävijöitä: ${detail}.`, foundTraps[0].reason));
    score += 12;
  } else {
    const detail = foundTraps.map(t => t.label).join(', ');
    checks.push(ck('Väärät kävijät', 'fail', `Sivusto voi näkyä hauissa, jotka tuovat kävijöitä jotka eivät osta: ${detail}.`, 'Oikeat hakusanat ratkaisevat, tuleeko sivustolle potentiaalisia asiakkaita vai satunnaisia kävijöitä.'));
  }

  // --- 3. Sisällön selkeys ---
  max += 25;
  const top5Concentration = sorted.slice(0, 5).reduce((s, [, c]) => s + c, 0) / Math.max(totalTerms, 1);

  if (top5Concentration >= 0.08) {
    checks.push(ck('Sisällön selkeys', 'pass', `Sivusto kertoo selkeästi yhdestä aiheesta — Google ymmärtää mistä on kyse.`));
    score += 25;
  } else if (top5Concentration >= 0.04) {
    checks.push(ck('Sisällön selkeys', 'warn', `Sivuston viesti hajoaa useaan suuntaan — Google ei ole varma, mistä sivu kertoo.`, 'Kun sivusto keskittyy muutamaan ydinteemaan, se nousee paremmin hakutuloksissa.'));
    score += 12;
  } else {
    checks.push(ck('Sisällön selkeys', 'fail', `Sivusto puhuu liian monesta asiasta — hakukone ei osaa yhdistää sitä mihinkään hakuun.`, 'Selkeä fokus muutamaan ydinteemaan auttaa Googlea näyttämään sivuston oikeille hakijoille.'));
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
    checks.push(ck('Myyntivalmius', 'warn', `Sivustolla on myyntisisältöä, mutta kävijä ei välttämättä ymmärrä mitä tehdä seuraavaksi.`, 'Selkeämmät toimintakehotukset ja palvelukuvaukset auttavat kävijöitä ottamaan yhteyttä.'));
    score += 15;
  } else {
    checks.push(ck('Myyntivalmius', 'fail', `Sivusto kertoo, mutta ei myy — kävijä saa tietoa mutta ei syytä ottaa yhteyttä.`, 'Kävijä tarvitsee selkeän syyn toimia: mitä tarjoat, kenelle ja miten pääsee alkuun.'));
  }

  return cat('keywords', 'Avainsanat', 'Löytävätkö oikeat asiakkaat sivustosi?', score, max, checks, 2);
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
  if (score >= 85) return 'Sivustosi perusteet ovat hyvällä mallilla. Systemaattisella optimoinnilla tuloksia voi parantaa entisestään.';
  if (score >= 60) return 'Kohtuullinen lähtötilanne — selkeitä kehityskohtia löytyy. Pienetkin parannukset voivat tuoda merkittävästi lisää näkyvyyttä.';
  if (score >= 35) return 'Useita puutteita, jotka todennäköisesti vaikuttavat näkyvyyteen. Systemaattinen optimointi kannattaa aloittaa heti.';
  return 'Merkittäviä puutteita näkyvyyden perusteissa. Sivustolla on paljon hyödyntämätöntä potentiaalia.';
}

app.listen(PORT, () => {
  console.log(`SEO Checker running at http://localhost:${PORT}`);
});
