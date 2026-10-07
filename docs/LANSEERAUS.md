# Näkyvyysanalyysi – lanseerauksen tarkistuslista

Päivitetty 7.10.2026.

## Valmiina

- [x] Analyysi: 31 tarkistusta kuudessa osa-alueessa; stressitesti 28/40 sivustoa (loput bottisuojauksia tai oikeita virheitä)
- [x] Selkeät suomenkieliset virheilmoitukset, bottisuojatuille sivustoille keskustelulinkki
- [x] Tietoturva: sisäverkon osoitteiden esto, käyttörajoitukset (analyysi 20 / 10 min, liidi 5 / 10 min per IP), sähköpostit rakennetaan palvelimen omista tuloksista
- [x] Copy, raportin ilme (videopaneeli), korjausohjeet, saavutettavuus (axe: 0 rikkomusta)
- [x] Raporttisähköposti (heti) ja muistutus (ajastettu 3 päivän päähän Resendissä)
- [x] Sähköpostipolun testi: `npm test` (21 tarkistusta, ei lähetä oikeita viestejä)
- [x] Tietosuojaseloste-linkki sähköpostiportissa, uutiskirjesuostumus ei oletuksena valittuna

## Ennen lanseerausta (estää julkaisun)

1. **Hosting** – päätös Google Cloud Run vs. Render, sitten julkaisu.
   - Cloud Run: `gcloud run deploy seo-checker --source . --region europe-north1 --max-instances 1 --set-env-vars NODE_ENV=production,...`
   - `--max-instances 1`: analyysin välimuisti ja käyttörajoitukset ovat palvelimen muistissa.
2. **Resend**
   - Tili ja domainin `seosales.fi` varmennus (SPF- ja DKIM-tietueet DNS:ään).
   - Ympäristömuuttujat: `RESEND_API_KEY`, `RESEND_FROM`, `REPLY_TO` (Janin osoite).
3. **Formspree liidien tallennukseksi** – `FORMSPREE_KEY`. Pilvipalvelimen levy tyhjenee uudelleenkäynnistyksessä, joten `leads.json` ei säily.
4. **Tietosuojaseloste** – päivitettävä kattamaan työkalu:
   - mitä kerätään: sähköposti, puhelin (vapaaehtoinen), analysoitu osoite, uutiskirjesuostumus
   - mihin käytetään: raportti, yksi muistutusviesti, yhteydenotto
   - säilytysaika
   - käsittelijät: Resend, Formspree, hosting (tiedonsiirto EU:n ulkopuolelle)
5. **Sivu seosales.fi:hin** (esim. `/nakyvyysanalyysi`) ja teaser etusivulle.
   - Sivulla `window.SEO_CHECKER_API = 'https://<palvelimen osoite>'`.
   - Palvelimelle `ALLOWED_ORIGINS=https://seosales.fi,https://www.seosales.fi`.
6. **seosales.fi:lle llms.txt** – työkalu huomauttaa sen puuttumisesta, ja moni kokeilee työkalua ensin SEO Salesin omalla sivulla.
7. **Lopputesti tuotannossa**
   - Oma sähköposti, raportti Gmailissa ja Outlookissa (myös mobiili), roskapostikansio.
   - Vastaus raporttiin menee Janille.
   - Muistutus näkyy Resendissä ajastettuna; peru testimuistutus.
   - `node scripts/stress-test.mjs https://<palvelimen osoite>`: pilvestä tulee todennäköisesti enemmän bottiestoja.

## Lanseerauksen jälkeen (suositellaan)

- [ ] PNG-logo sähköposteihin (SVG ei näy kaikissa sähköpostiohjelmissa); kohta merkitty `buildReportHTML`-funktioon
- [ ] Kevyempi video (nyt 11,6 Mt)
- [ ] Sivunopeus Googlen PageSpeed-rajapinnasta: tekee Tekniikka-osa-alueesta erottelevan (nyt lähes kaikki 100)
- [ ] Somekanavat: linkit LinkedIniin ym. ja `sameAs` rakenteellisessa datassa
- [ ] Analytiikkatapahtumat (GA4): analyysi aloitettu / valmis / sähköposti annettu
- [ ] Kalibrointi: UKK-merkintöjen painoarvo (Google rajasi niiden näkymisen 2023)

## Avoimet päätökset (Jani)

- Sähköposti ennen täysiä tuloksia, ilman, vai välimuoto (3 tärkeintä heti)?
- Lähtevätkö viestit Janin nimissä? Allekirjoitus on nyt "Jani, SEO Sales".
- Pitääkö pisteytyksen olla tiukempi? (seosales.fi 97/100, useimmat sivustot 75–95)
- Uutiskirjelista: mihin tilaajat viedään?
- Muistutus vain kerran (nyt) vai myöhemmin toinen?

## Ylläpito

- **Muistutuksen peruminen:** jos asiakas varaa keskustelun ennen muistutusta, peru ajastettu viesti Resendin hallintapaneelista (Emails → Scheduled).
- **Viestien esikatselu ilman Resendiä:** ilman `RESEND_API_KEY`:tä viestit tallennetaan `outbox/`-kansioon.
- **Kehityksen esikatselut:** `/api/report-preview?url=…` ja `/api/followup-preview?url=…` (pois käytöstä, kun `NODE_ENV=production`).

## Ympäristömuuttujat

| Muuttuja | Pakollinen | Kuvaus |
|---|---|---|
| `RESEND_API_KEY` | kyllä | Resendin API-avain |
| `RESEND_FROM` | kyllä | esim. `SEO Sales <raportti@seosales.fi>` |
| `REPLY_TO` | suositus | Osoite, johon vastaukset menevät |
| `FORMSPREE_KEY` | kyllä | Formspree-lomakkeen tunnus liidi-ilmoituksille |
| `NODE_ENV` | kyllä | `production` sulkee esikatselut |
| `ALLOWED_ORIGINS` | – | Oletus `https://seosales.fi,https://www.seosales.fi` |
| `FOLLOWUP_DAYS` | – | Muistutuksen viive, oletus 3 |
| `RATE_MAX` | – | Analyysejä per IP 10 minuutissa, oletus 20 |
| `DATA_DIR` | – | Liidien ja lokien kansio, oletus sovelluksen kansio |
| `PORT` | – | Hosting asettaa automaattisesti |
