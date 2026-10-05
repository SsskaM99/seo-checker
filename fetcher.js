// Sivun haku analyysiä varten: osoitteen tarkistus, uudelleenohjaukset, bottisuojausten
// tunnistus, merkistön tunnistus ja robots.txt/sitemap-tiedot.

const dns = require('dns').promises;
const net = require('net');

const TOTAL_TIMEOUT_MS = 15000;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 6;

// Ensin tunnistettava otsake. Jos sivusto torjuu sen (401/403), yritetään kerran
// tavallisella selainotsakkeella — samalla tavalla kuin kävijän selain hakisi sivun.
const UA_TOOL = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 SEOSalesChecker/1.0 (+https://seosales.fi)';
const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

const BASE_HEADERS = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fi-FI,fi;q=0.9,en;q=0.8',
};

class FetchError extends Error {
  constructor(code, message, httpStatus = 502) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function normalizeUrl(input) {
  let raw = String(input || '').trim();
  if (!raw) throw new FetchError('invalid_url', 'Syötä verkkosivun osoite, esimerkiksi yritys.fi.', 400);
  const hadProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  if (!hadProtocol) raw = 'https://' + raw;
  let u;
  try { u = new URL(raw); } catch {
    throw new FetchError('invalid_url', 'Osoite ei ole kelvollinen. Tarkista kirjoitusasu, esimerkiksi yritys.fi.', 400);
  }
  if (!['http:', 'https:'].includes(u.protocol)) {
    throw new FetchError('invalid_url', 'Analysoida voi vain verkkosivuja (http- tai https-osoitteita).', 400);
  }
  u.hash = '';
  if (!u.hostname.includes('.') && !u.hostname.startsWith('[')) {
    throw new FetchError('invalid_url', 'Osoitteesta puuttuu pääte, esimerkiksi yritys.fi.', 400);
  }
  return { url: u, hadProtocol };
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19));
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateIp(v6.slice(7));
  return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') ||
    v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb');
}

// Estää palvelimen käytön sisäverkon osoitteiden kurkkimiseen (SSRF).
async function assertPublicHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new FetchError('blocked_address', 'Tätä osoitetta ei voi analysoida.', 400);
  }
  let addrs;
  if (net.isIP(host)) addrs = [{ address: host }];
  else {
    try { addrs = await dns.lookup(host, { all: true }); }
    catch { throw new FetchError('dns', `Osoitetta ${host} ei löytynyt. Tarkista kirjoitusasu.`, 400); }
  }
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) {
    throw new FetchError('blocked_address', 'Tätä osoitetta ei voi analysoida.', 400);
  }
}

// Tunnistaa bottisuojauksen välisivut (Cloudflare, Vercel, Akamai ym.).
function detectBotProtection(status, headers, bodySnippet) {
  if (headers.get('cf-mitigated') === 'challenge') return 'Cloudflare';
  if (headers.get('x-vercel-mitigated')) return 'Vercel';
  const s = bodySnippet.toLowerCase();
  if (s.includes('vercel security checkpoint')) return 'Vercel';
  if (s.includes('<title>just a moment') || s.includes('cf-browser-verification') || s.includes('challenges.cloudflare.com')) return 'Cloudflare';
  if ([401, 403, 429, 503].includes(status)) {
    const server = (headers.get('server') || '').toLowerCase();
    if (server.includes('akamai')) return 'Akamai';
    if (server.includes('cloudflare')) return 'Cloudflare';
    if (s.includes('captcha') || s.includes('access denied') || s.includes('bot protection') || s.includes('request blocked')) return 'bottisuojaus';
  }
  return null;
}

function charsetFrom(contentType, headBytes) {
  const m = /charset=["']?([\w-]+)/i.exec(contentType || '');
  if (m) return m[1];
  const head = Buffer.from(headBytes).toString('latin1');
  const meta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  return meta ? meta[1] : 'utf-8';
}

async function readBody(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) { reader.cancel().catch(() => {}); break; }
    chunks.push(value);
  }
  const out = new Uint8Array(Math.min(total, maxBytes));
  let off = 0;
  for (const c of chunks) { out.set(c.subarray(0, out.length - off), off); off += c.length; if (off >= out.length) break; }
  return out;
}

function decode(bytes, contentType) {
  const cs = charsetFrom(contentType, bytes.subarray(0, 4096));
  try { return new TextDecoder(cs).decode(bytes); }
  catch { return new TextDecoder('utf-8').decode(bytes); }
}

// Seuraa uudelleenohjauksia käsin, jotta jokainen välietappi tarkistetaan
// ja evästeet kulkevat mukana (osa sivustoista ohjaa ensin evästeen asettavalle sivulle).
async function fetchFollow(startUrl, userAgent, signal) {
  let current = new URL(startUrl);
  const cookies = new Map();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(current.hostname);
    const headers = { ...BASE_HEADERS, 'User-Agent': userAgent };
    if (cookies.size) headers['Cookie'] = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(current, { headers, redirect: 'manual', signal });
    for (const sc of res.headers.getSetCookie?.() || []) {
      const [pair] = sc.split(';');
      const i = pair.indexOf('=');
      if (i > 0) cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      res.body?.cancel().catch(() => {});
      current = new URL(res.headers.get('location'), current);
      if (!['http:', 'https:'].includes(current.protocol)) throw new FetchError('fetch_failed', 'Sivusto ohjasi osoitteeseen, jota ei voi analysoida.');
      continue;
    }
    return { res, finalUrl: current.href };
  }
  throw new FetchError('fetch_failed', 'Sivusto ohjaa kävijän kehässä osoitteesta toiseen, joten sivua ei voitu avata.');
}

function networkError(err, host) {
  if (err instanceof FetchError) return err;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') {
    return new FetchError('timeout', `Sivuston ${host} lataus kesti yli 15 sekuntia. Kokeile hetken kuluttua uudelleen.`, 504);
  }
  const code = err.cause?.code || '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new FetchError('dns', `Osoitetta ${host} ei löytynyt. Tarkista kirjoitusasu.`, 400);
  if (code.startsWith('CERT_') || code.includes('SSL') || code.includes('TLS') || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
    return new FetchError('tls', `Sivuston ${host} suojausvarmenne ei ole kunnossa, joten selaimet varoittavat kävijöitä. Tämä kannattaa korjata ensimmäisenä.`);
  }
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') {
    return new FetchError('fetch_failed', `Sivusto ${host} ei vastannut. Tarkista, että sivusto on toiminnassa.`);
  }
  return new FetchError('fetch_failed', `Sivustoa ${host} ei voitu avata. Tarkista osoite ja kokeile uudelleen.`);
}

async function fetchPage(input) {
  const { url, hadProtocol } = normalizeUrl(input);
  const signal = AbortSignal.timeout(TOTAL_TIMEOUT_MS);
  const host = url.hostname;
  const t0 = Date.now();

  let attempt;
  try {
    attempt = await fetchFollow(url.href, UA_TOOL, signal);
  } catch (err) {
    const e = networkError(err, host);
    // Ilman protokollaa syötetty osoite: jos https ei toimi lainkaan, kokeillaan http.
    if (!hadProtocol && ['fetch_failed', 'tls'].includes(e.code)) {
      try { attempt = await fetchFollow('http://' + url.host + url.pathname + url.search, UA_TOOL, signal); }
      catch { throw e; }
    } else throw e;
  }

  let { res, finalUrl } = attempt;
  let bytes, responseTimeMs;
  try {
    if (res.status === 401 || res.status === 403) {
      res.body?.cancel().catch(() => {});
      ({ res, finalUrl } = await fetchFollow(finalUrl, UA_BROWSER, signal));
    }
    responseTimeMs = Date.now() - t0;
    bytes = await readBody(res, MAX_BYTES);
  } catch (err) { throw networkError(err, host); }

  const contentType = res.headers.get('content-type') || '';
  const snippet = Buffer.from(bytes.subarray(0, 20000)).toString('latin1');
  const protection = detectBotProtection(res.status, res.headers, snippet);
  if (protection) {
    throw new FetchError('bot_protection',
      `Sivusto ${host} käyttää bottisuojausta (${protection}), joka estää automaattiset tarkistukset. Se on isoilla sivustoilla yleistä eikä kerro näkyvyydestä mitään. Voimme käydä sivuston läpi yhdessä keskustelussa.`);
  }
  if (res.status === 404 || res.status === 410) {
    throw new FetchError('not_found', 'Sivua ei löytynyt (404). Tarkista osoite tai kokeile sivuston etusivua.');
  }
  if (res.status >= 500) {
    throw new FetchError('server_error', `Sivuston palvelin vastasi virheellä (${res.status}). Kokeile hetken kuluttua uudelleen.`);
  }
  if (!res.ok) {
    throw new FetchError('http_error', `Sivusto ei päästänyt analyysiä sisään (virhekoodi ${res.status}).`);
  }
  if (contentType && !/text\/html|application\/xhtml/i.test(contentType)) {
    throw new FetchError('not_html', 'Osoite ei johda verkkosivulle (esimerkiksi tiedosto tai rajapinta). Syötä sivuston osoite.', 400);
  }

  return {
    html: decode(bytes, contentType),
    finalUrl,
    status: res.status,
    responseTimeMs,
    // Julkaisualustan tunnistusta varten.
    headers: Object.fromEntries(['server', 'x-powered-by', 'x-generator', 'x-wix-request-id', 'x-shopify-stage', 'x-drupal-cache', 'x-hubspot-correlation-id']
      .map(h => [h, res.headers.get(h)]).filter(([, v]) => v)),
  };
}

// Hakee pienen tekstitiedoston (robots.txt, sitemap). Palauttaa null, jos tiedostoa ei ole.
async function fetchText(url, maxBytes = 512 * 1024) {
  try {
    const { res } = await fetchFollow(url, UA_TOOL, AbortSignal.timeout(6000));
    if (!res.ok) { res.body?.cancel().catch(() => {}); return null; }
    const text = decode(await readBody(res, maxBytes), res.headers.get('content-type'));
    return { text, contentType: res.headers.get('content-type') || '' };
  } catch { return null; }
}

// Tekoälyhakujen ja -mallien botit. search = vaikuttaa suoraan näkymiseen vastauksissa.
const AI_BOTS = [
  { ua: 'OAI-SearchBot', name: 'ChatGPT-haku', search: true },
  { ua: 'ChatGPT-User', name: 'ChatGPT', search: true },
  { ua: 'PerplexityBot', name: 'Perplexity', search: true },
  { ua: 'Claude-SearchBot', name: 'Claude-haku', search: true },
  { ua: 'GPTBot', name: 'OpenAI GPTBot', search: false },
  { ua: 'ClaudeBot', name: 'Anthropic ClaudeBot', search: false },
  { ua: 'Google-Extended', name: 'Google Gemini', search: false },
  { ua: 'CCBot', name: 'Common Crawl', search: false },
];

function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let current = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'sitemap') { if (val) sitemaps.push(val); continue; }
    if (key === 'user-agent') {
      if (!lastWasAgent) { current = { agents: [], disallowRoot: false, allowRoot: false }; groups.push(current); }
      current.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'disallow' && val === '/') current.disallowRoot = true;
    if (key === 'allow' && val === '/') current.allowRoot = true;
  }
  const groupFor = ua => groups.find(g => g.agents.includes(ua.toLowerCase())) || groups.find(g => g.agents.includes('*'));
  const blocksAll = ua => { const g = groupFor(ua); return !!g && g.disallowRoot && !g.allowRoot; };
  return {
    sitemaps,
    blocksAll,
    blockedAiBots: AI_BOTS.filter(b => blocksAll(b.ua)),
  };
}

async function fetchSiteFiles(finalUrl) {
  const origin = new URL(finalUrl).origin;
  const [robotsRes, llmsRes] = await Promise.all([
    fetchText(`${origin}/robots.txt`),
    fetchText(`${origin}/llms.txt`, 64 * 1024),
  ]);
  // llms.txt: Markdown-tiivistelmä tekoälyille. Puuttuvan tiedoston tilalle palautettu HTML-sivu ei kelpaa.
  const llmsOk = !!llmsRes && !/^\s*</.test(llmsRes.text) && !/text\/html/i.test(llmsRes.contentType) && llmsRes.text.trim().length >= 30;
  // Osa palvelimista palauttaa puuttuvan tiedoston tilalle HTML-sivun — sitä ei lasketa.
  const robotsValid = !!robotsRes && !/^\s*</.test(robotsRes.text) && !/text\/html/i.test(robotsRes.contentType);
  const robots = robotsValid ? parseRobots(robotsRes.text) : null;

  const candidates = [...new Set([...(robots?.sitemaps || []), `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`])].slice(0, 4);
  let sitemapOk = false;
  for (const sm of candidates) {
    let smUrl;
    try { smUrl = new URL(sm, origin).href; } catch { continue; }
    const r = await fetchText(smUrl, 64 * 1024);
    if (r && /<(urlset|sitemapindex)[\s>]/i.test(r.text)) { sitemapOk = true; break; }
  }

  return { robotsOk: robotsValid, robots, sitemapOk, llmsOk };
}

module.exports = { fetchPage, fetchSiteFiles, FetchError, AI_BOTS, parseRobots, isPrivateIp };
