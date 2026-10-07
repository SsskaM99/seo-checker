// Tekee työkalun sivusta seosales.fi:hin (GitHub Pages) sopivan version:
// analyysipalvelun osoite, sivuston omat polut ja linkit samaan välilehteen.
// Käyttö: node scripts/build-site-page.mjs https://<analyysipalvelun osoite> [tulostiedosto]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const api = (process.argv[2] || '').replace(/\/$/, '');
const out = process.argv[3] || path.join(ROOT, 'dist', 'nakyvyysanalyysi.html');
if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(api)) {
  console.error('Anna analyysipalvelun osoite, esim. https://seo-checker-abc123-lz.a.run.app');
  process.exit(1);
}

let html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const replace = (from, to) => {
  if (!html.includes(from)) throw new Error('Ei löytynyt: ' + from);
  html = html.split(from).join(to);
};

replace('href="/favicon.svg?v=2"', 'href="favicon.svg"');
replace('src="/seo-sales-logo.svg"', 'src="seo-sales-logo.svg"');
replace('<meta name="description"', '<link rel="canonical" href="https://seosales.fi/nakyvyysanalyysi.html">\n<meta name="description"');
// Sivuston sisäiset linkit avautuvat samaan välilehteen.
replace('href="https://seosales.fi" class="logo" target="_blank" rel="noopener"', 'href="index.html" class="logo"');
replace('href="https://seosales.fi" class="nav-link" target="_blank" rel="noopener"', 'href="index.html" class="nav-link"');
html = html.replace(/href="https:\/\/seosales\.fi\/yhteys\.html"( class="[^"]*")? target="_blank" rel="noopener"/g, 'href="yhteys.html"$1');
html = html.replace(/href="https:\/\/seosales\.fi\/tietosuojaseloste\.html" target="_blank" rel="noopener"/g, 'href="tietosuojaseloste.html"');
html = html.replace('<a href="https://seosales.fi" target="_blank" rel="noopener">SEO Sales</a>', '<a href="index.html">SEO Sales</a>');
// Analyysipalvelun osoite ennen sivun omaa skriptiä.
const firstScript = html.search(/\r?\n<script>\r?\n/);
if (firstScript === -1) throw new Error('Sivun skriptiä ei löytynyt');
html = html.slice(0, firstScript) + `\n<script>window.SEO_CHECKER_API = '${api}';</script>` + html.slice(firstScript);

if (/target="_blank"[^>]*>[^<]*(SEO Sales|Varaa)/.test(html)) console.warn('Huom: sivulla on vielä uuteen välilehteen avautuvia sisäisiä linkkejä.');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`Valmis: ${out}\nAnalyysipalvelu: ${api}`);
