# Näkyvyysanalyysi – lanseerausohje

Päivitetty 7.10.2026. Tämä ohje kertoo, mikä näkyvyysanalyysi on, miten se toimii ja mitä pitää tehdä, jotta se saadaan julki seosales.fi:hin. Vaiheet tehdään järjestyksessä. Jokaisessa vaiheessa lukee, kuka sen tekee ja mistä tietää, että vaihe on valmis.

**Kuka tekee:** **Jani** = tilit, DNS ja päätökset. **Saska** = tekninen toteutus.
**Aika:** noin 2–4 tuntia, josta suurin osa kuluu odotteluun (DNS-tietueiden voimaantulo).
**Kustannukset:** käytännössä 0 €/kk. Kaikki palvelut pysyvät ilmaistasoillaan tällä käyttömäärällä (ks. kohta 8).

---

## 1. Mikä näkyvyysanalyysi on

Näkyvyysanalyysi on maksuton työkalu, jolla kuka tahansa voi tarkistaa oman verkkosivunsa näkyvyyden. Käyttäjä saa pisteet 0–100 ja konkreettiset korjausohjeet. SEO Sales saa yhteystiedot niiltä, jotka haluavat koko raportin, ja luontevan syyn ottaa yhteyttä.

### Käyttäjän polku

1. **Käyttäjä syöttää osoitteen.** Joko etusivun teaseriin tai suoraan työkalun sivulle (esim. `yritys.fi`).
2. **Analyysi valmistuu noin sekunnissa.** Käyttäjä näkee kokonaispisteet, kuuden osa-alueen pisteet ja jokaisen osa-alueen tärkeimmän havainnon.
3. **Täydet tulokset on lukittu.** Ne näkyvät sumennettuina, ja niiden päällä on sähköpostikenttä. Puhelinnumero ja uutiskirjeen tilaus ovat vapaaehtoisia.
4. **Sähköpostin antamisen jälkeen** kaikki 31 tarkistusta korjausohjeineen avautuvat.
5. **Raportti lähtee heti käyttäjän sähköpostiin.**
6. **Noin kolmen päivän päästä lähtee yksi muistutusviesti.** Siinä on kolme tärkeintä kehityskohdetta ja ehdotus maksuttomasta keskustelusta.
7. **Jani saa jokaisesta liidistä ilmoituksen sähköpostiin** (Formspree). Käyttäjän vastaukset raporttiin ja muistutukseen tulevat Janille.

### Mitä analyysi tarkistaa

| Osa-alue | Painoarvo | Esimerkkejä tarkistuksista |
|---|---|---|
| Hakukoneet | 3 | sivun otsikko, hakutuloksen kuvaus, pääotsikko, canonical, sisäiset linkit |
| Tekniikka | 2 | HTTPS, mobiili, indeksointi, vasteaika, robots.txt, sivukartta |
| Sisältö | 2 | tekstin määrä, otsikkorakenne, kuvien alt-tekstit |
| Somenäkyvyys | 1 | miltä linkki näyttää LinkedInissä ja viestisovelluksissa (Open Graph) |
| Tekoälyhaut | 2 | rakenteellinen data, tekoälybottien pääsy, llms.txt, yritystiedot, näkyykö sisältö ilman JavaScriptiä |
| Avainsanat | 2 | vastaako hakutulos sisältöä, houkutteleeko sivu vääriä kävijöitä, onko viesti selkeä, ohjaako sivu yhteydenottoon |

Kokonaispisteet ovat osa-alueiden painotettu keskiarvo. Työkalu tunnistaa myös julkaisualustan (esim. WordPress) ja näyttää WordPress-vinkit vain WordPress-sivustoille.

### Mitä tapahtuu taustalla

```
Käyttäjän selain (seosales.fi/nakyvyysanalyysi.html)
        │  "analysoi yritys.fi"
        ▼
Analyysipalvelu (Google Cloud Run)  ──hakee──▶  yritys.fi (julkinen sivu, robots.txt, sivukartta, llms.txt)
        │
        ├── raportti heti + muistutus 3 pv päähän ──▶  Resend ──▶ käyttäjän sähköposti
        └── liidi-ilmoitus ──▶  Formspree ──▶ Janin sähköposti
```

- **seosales.fi pysyy GitHub Pagesissa ennallaan.** Työkalun sivu on siellä tavallinen HTML-sivu.
- **Itse analyysi tehdään erillisellä palvelimella.** GitHub Pages ei pysty ajamaan ohjelmia, eikä selain saa tietoturvasyistä hakea toisten sivustojen sisältöä. Käyttäjä ei huomaa palvelinta mitenkään.

### Rajoitukset, jotka kannattaa tietää

- **Vain yksi sivu.** Analyysi katsoo yhden sivun, yleensä etusivun.
- **Bottisuojatut sivustot.** Osa isoista sivustoista (esim. K-Ruoka, HSL, Gigantti) estää kaikki automaattiset tarkistukset. Käyttäjä saa silloin selityksen ja linkin keskustelun varaamiseen. Testissä analyysi onnistui 28 sivustolla 40:stä, ja loput olivat bottisuojauksia tai oikeita virheitä, kuten väärin kirjoitettuja osoitteita.
- **Avainsanat ovat suuntaa antavia.** Arvio perustuu sivun tekstiin, ei hakumääriin.

---

## 2. Etusivun teaser

Teaser on uusi tumma osio etusivulle Ajankohtaista-osion jälkeen. Se tuo työkalun esiin ilman, että sitä nostetaan päänavigaatioon. Näin SEO Salesista ei synny mielikuvaa pelkästä SEO-yrityksestä.

- **Sisältö:**
  - yläotsikko "Maksuton näkyvyysanalyysi"
  - otsikko "Selvitä verkkosivusi näkyvyyden tila"
  - lyhyt teksti
  - osoitekenttä ja Analysoi-painike
  - alla teksti "Maksuton · Tulokset heti · Ei kirjautumista"
- **Toiminta:** kun kävijä kirjoittaa osoitteen ja painaa Analysoi, hän siirtyy sivulle `nakyvyysanalyysi.html?url=yritys.fi`. Analyysi käynnistyy siellä heti, eikä osoitetta tarvitse kirjoittaa uudelleen.
- **Ulkoasu:** käyttää sivuston omaa tummaa osiotyyliä, joten uutta CSS:ää tarvitaan vain lomakkeelle.
- **Tiedostot:** `docs/nakyvyysanalyysi/teaser.html` ja `teaser.css` sivuston repossa. Esikatselu: `docs/nakyvyysanalyysi/esikatselu.html`.

---

## 3. Lanseeraus vaihe kerrallaan

### Vaihe 1 – Koodi GitHubiin · Saska
Analyysipalvelu julkaistaan suoraan GitHubista.

1. Repossa `seo-checker` aja: `git push`.
2. Repo on `github.com/SsskaM99/seo-checker`. Se voi pysyä yksityisenä.

✅ **Valmis, kun** GitHubissa näkyy viimeisin commit "Tietoturvatarkastus ennen lanseerausta".

### Vaihe 2 – Formspree liidi-ilmoituksille · Jani
Analyysipalvelun levy tyhjenee aina, kun palvelin käynnistyy uudelleen. Siksi liidit pitää tallentaa Formspreehen. Samalla Jani saa jokaisesta liidistä sähköpostin.

1. Kirjaudu formspree.io:hon (sama tili kuin yhteydenottolomakkeella).
2. **New Form** → nimi "Näkyvyysanalyysi – liidit" → ilmoitukset osoitteeseen janio.lammi@gmail.com.
3. Kopioi lomakkeen tunnus. Se on osoitteen `formspree.io/f/` jälkeinen osa, esim. `xkgwabcd`.

✅ **Valmis, kun** tunnus on tallessa vaihetta 4 varten.
⚠️ **Tarkista Formspreen ilmaisversion kuukausiraja** (noin 50 lähetystä). Jos liidejä tulee enemmän, tarvitaan maksullinen taso tai muu tallennus.

### Vaihe 3 – Resend sähköposteille · Jani (DNS) + Saska
Resend lähettää raportin ja muistutuksen. Muistutuksen ajastus hoituu Resendin omalla ajastuksella, joten muuta järjestelmää ei tarvita.

1. Luo tili osoitteessa resend.com (ilmainen: 3 000 viestiä/kk, 100/vrk; yksi liidi = 2 viestiä).
2. **Domains → Add Domain** → `seosales.fi`, alueeksi **EU (Ireland)**.
3. Resend näyttää 3–4 DNS-tietuetta (SPF, DKIM ja MX). Lisää ne seosales.fi:n DNS-asetuksiin siellä, missä domain on rekisteröity.
4. Jos domainilla ei vielä ole DMARC-tietuetta, lisää TXT-tietue nimelle `_dmarc`, arvoksi `v=DMARC1; p=none;`. Se parantaa sitä, että viestit menevät perille eivätkä roskapostiin.
5. Odota, että Resendissä lukee **Verified** (minuuteista muutamaan tuntiin).
6. **API Keys → Create API Key** → oikeus "Sending access", domain seosales.fi. Kopioi avain heti, koska se näytetään vain kerran.
7. Päätä vastausosoite: mihin käyttäjän vastaus raporttiin menee (esim. janio.lammi@gmail.com).

✅ **Valmis, kun** domain on Verified ja API-avain on tallessa.
Lähettäjä on `SEO Sales <raportti@seosales.fi>`. Osoitteeseen ei tarvitse luoda postilaatikkoa, koska vastaukset ohjautuvat vastausosoitteeseen.

### Vaihe 4 – Analyysipalvelun julkaisu Google Cloud Runiin · Jani (tili) + Saska
1. Kirjaudu osoitteeseen console.cloud.google.com samalla Google-tilillä kuin Analytics.
2. Luo projekti, esim. "seosales".
3. **Billing:** liitä maksukortti. Ilmaiskiintiö riittää, mutta Google vaatii kortin.
4. **Billing → Budgets & alerts:** tee 5 €:n budjettihälytys, niin mahdollisista kuluista tulee ilmoitus heti.
5. **Cloud Run → Deploy container → Continuously deploy from a repository** → yhdistä GitHub ja valitse `seo-checker`, haara `master`.
   - Build type: **buildpacks** (Node.js, käynnistyy komennolla `npm start`)
   - Service name: `seo-checker`, region: **europe-north1 (Finland)**
   - Authentication: **Allow public access** (sivu on julkinen)
   - Minimum instances **0**, maximum instances **1**. Analyysin välimuisti ja käyttörajoitukset ovat palvelimen muistissa, joten instansseja saa olla vain yksi.
   - **Variables & Secrets** → lisää ympäristömuuttujat:

| Muuttuja | Arvo |
|---|---|
| `NODE_ENV` | `production` |
| `RESEND_API_KEY` | vaiheen 3 avain |
| `RESEND_FROM` | `SEO Sales <raportti@seosales.fi>` |
| `REPLY_TO` | vastausosoite (vaihe 3.7) |
| `FORMSPREE_KEY` | vaiheen 2 tunnus |
| `ALLOWED_ORIGINS` | `https://seosales.fi,https://www.seosales.fi` |

6. **Create.** Ensimmäinen julkaisu kestää muutaman minuutin.
7. Kopioi palvelun osoite, esim. `https://seo-checker-abc123-lz.a.run.app`.

✅ **Valmis, kun** palvelun osoite avaa selaimessa työkalun ja analyysi toimii esimerkiksi osoitteella `seosales.fi`.
Jatkossa jokainen `git push` julkaisee uuden version automaattisesti.

**Vaihtoehto: Render** (ei vaadi korttia): render.com → New → Web Service → GitHub-repo → Build `npm ci`, Start `npm start`, Instance type **Free** → samat ympäristömuuttujat. Haittapuoli: palvelin nukahtaa 15 minuutin käyttötauon jälkeen, ja silloin ensimmäinen analyysi kestää 30–60 sekuntia.

### Vaihe 5 – Testaa palvelin · Saska
1. Avaa palvelun osoite ja analysoi `seosales.fi`.
2. Anna oma sähköpostiosoite ja tarkista:
   - raportti tulee perille, eikä roskapostiin
   - viesti näyttää hyvältä Gmailissa, Outlookissa ja puhelimella
   - vastaus raporttiin menee vastausosoitteeseen
   - Formspreestä tulee liidi-ilmoitus
   - Resendin **Emails**-listalla muistutus näkyy ajastettuna (Scheduled). Peru testimuistutus: avaa viesti → Cancel.
3. Aja stressitesti pilvipalvelinta vasten: `node scripts/stress-test.mjs https://<palvelun osoite>`. Pilvestä bottiestoja tulee todennäköisesti enemmän kuin paikalliselta koneelta.

✅ **Valmis, kun** kaikki yllä oleva toimii.

### Vaihe 6 – Työkalun sivu seosales.fi:hin · Saska
1. Repossa `seo-checker`: `node scripts/build-site-page.mjs https://<palvelun osoite>`.
2. Skripti tekee tiedoston `dist/nakyvyysanalyysi.html`, jossa on:
   - palvelun osoite
   - sivuston omat polut logolle ja faviconille
   - canonical-osoite
   - sisäiset linkit samaan välilehteen
3. Kopioi tiedosto seosales.fi:n juureen, livesivuston repoon.

✅ **Valmis, kun** `seosales.fi/nakyvyysanalyysi.html` toimii. Testaa myös `seosales.fi/nakyvyysanalyysi.html?url=seosales.fi`.

### Vaihe 7 – Teaser etusivulle · Saska tai Jani
1. Lisää `teaser.html`-tiedoston osio etusivulle heti Ajankohtaista-osion jälkeen, ennen riviä `<!-- WHY -->`.
2. Lisää `teaser.css`:n sisältö `styles.css`:n loppuun ja kasvata tyylitiedoston versionumeroa (`styles.css?v=…`), jotta selaimet hakevat uuden version.
3. Tarkista etusivu työpöydällä ja puhelimella.

✅ **Valmis, kun** teaser näkyy ja Analysoi-painike vie työkaluun, jossa analyysi käynnistyy.

### Vaihe 8 – Tietosuojaseloste · Jani
1. Lisää `docs/nakyvyysanalyysi/tietosuoja-lisays.md`:n teksti tietosuojaselosteeseen.
2. Täytä hakasulkeissa olevat kohdat: hosting-palvelu (Google Cloud) ja säilytysajat.

✅ **Valmis, kun** seloste on päivitetty. Työkalun sähköpostiportissa on jo linkki selosteeseen.

### Vaihe 9 – Pienet korjaukset seosales.fi:hin · Saska tai Jani
- **llms.txt:** kopioi `docs/nakyvyysanalyysi/llms.txt` seosales.fi:n juureen. Työkalu huomauttaa sen puuttumisesta, ja moni kokeilee työkalua ensin SEO Salesin omalla sivulla.
- **Favicon:** `seosales.fi/favicon.svg` palauttaa nyt 404-virheen, vaikka sivut viittaavat siihen. Lisää tiedosto juureen tai korjaa polku.

✅ **Valmis, kun** `seosales.fi/llms.txt` avautuu ja selaimen välilehdellä näkyy kuvake.

### Vaihe 10 – Lopputarkistus ennen julkistusta · molemmat
- [ ] Analyysi toimii etusivun teaserista alkaen puhelimella ja tietokoneella.
- [ ] Raportti tulee perille, ja muistutus näkyy Resendissä ajastettuna.
- [ ] Formspree-ilmoitus tulee Janille.
- [ ] Tietosuojaseloste on päivitetty.
- [ ] Budjettihälytys on päällä Google Cloudissa.
- [ ] Testiliidit ja testimuistutukset on poistettu tai peruttu.

### Vaihe 11 – Ensimmäinen viikko
- Seuraa Formspree-ilmoituksia ja Resendin toimitusraportteja (Delivered / Bounced).
- Katso Cloud Runin lokeista (Logs) virheitä, esim. hakusanalla "epäonnistui".
- Jos sama sivusto ei aukea monelle käyttäjälle, se on todennäköisesti bottisuojattu. Käyttäjä saa silloin keskustelulinkin.

---

## 4. Sähköpostit ja muistutus

- **Raportti** lähtee heti, kun käyttäjä antaa sähköpostin. Aihe: "Näkyvyysanalyysi: yritys.fi – 77/100". Sisältö:
  - pisteet
  - korjattavat ja huomioitavat kohdat ohjeineen, tärkeimmät ensin
  - yhteenveto kunnossa olevista
  - allekirjoitus "Jani, SEO Sales" ja painike "Varaa maksuton keskustelu"
- **Muistutus** lähtee kerran, 3 päivän päästä. Aihe: "Mitä yritys.fi-analyysin tuloksista kannattaa tehdä ensin?". Sisältö: kolme tärkeintä kehityskohdetta ja ehdotus keskustelusta.
- **Muistutuksen peruminen:** jos asiakas varaa keskustelun ennen muistutusta, peru viesti Resendissä: Emails → viesti → Cancel.
- **Viive:** muutetaan ympäristömuuttujalla `FOLLOWUP_DAYS` (enintään 30 päivää, Resendin raja).
- **Tekstien muokkaus:** tekstit ovat tiedostossa `server.js` (funktiot `buildReportHTML` ja `buildFollowupHTML`). Esikatselu paikallisesti:
  - `/api/report-preview?url=yritys.fi`
  - `/api/followup-preview?url=yritys.fi`
  - Ilman Resend-avainta viestit tallentuvat `outbox/`-kansioon.
- **Väärinkäytön esto:** viestit rakennetaan aina palvelimen omista tuloksista, joten SEO Salesin nimissä ei voi lähettää kenenkään muun kirjoittamaa tekstiä. Samaan osoitteeseen lähtee enintään 3 raporttia vuorokaudessa.

## 5. Tietoturva

Tarkastettu ja testattu 7.10.2026 (`npm run test:security`, 41 tarkistusta):
- **Palvelinta ei voi käyttää sisäverkon tai pilven sisäisten osoitteiden kurkkimiseen.** Estetyt osoitteet tarkistetaan vielä yhteyden avaamisen hetkellä, ja vain tavalliset verkkosivuportit ovat sallittuja.
- **Käyttörajoitukset:**
  - analyysejä enintään 20 / 10 min / IP-osoite
  - sähköpostin antamisia enintään 5 / 10 min / IP-osoite
  - raportteja enintään 3 / vrk / vastaanottaja
- **Palvelinta voivat kutsua vain seosales.fi-sivut** (CORS).
- **Tiedostot ja virheet:** liidit, lokit ja asetukset eivät ole julkisesti saatavilla, eikä virheilmoituksissa näy teknisiä yksityiskohtia.
- **Riippuvuudet:** ei tunnettuja haavoittuvuuksia (`npm audit`).
- **Avaimet** (Resend ja Formspree) ovat vain hostingin ympäristömuuttujissa, eivät koodissa.

## 6. Ylläpito ja vianetsintä

| Tilanne | Mitä tehdä |
|---|---|
| Raportti ei tule perille | Resend → Emails: näkyykö viesti, ja onko tila Bounced? Tarkista roskaposti ja domainin Verified-tila. |
| Työkalu sanoo "Yhteys analyysipalveluun katkesi" | Cloud Run → seo-checker → Logs. Tarkista, että `ALLOWED_ORIGINS` sisältää sivun osoitteen. |
| Sivusto "käyttää bottisuojausta" | Normaalia isoilla sivustoilla. Voidaan katsoa käsin keskustelussa. |
| Liidi-ilmoituksia ei tule | Formspree-tunnus (`FORMSPREE_KEY`) ja kuukausiraja. |
| Muutos koodiin | `npm test` ja `npm run test:security` ennen `git push`:ia. Cloud Run julkaisee automaattisesti. |

## 7. Avoimet päätökset (Jani)

- **Sähköpostiportti:** pyydetäänkö sähköposti ennen täysiä tuloksia (nyt), ei lainkaan, vai välimuoto, jossa kolme tärkeintä korjausta näkyy heti?
- **Viestien nimi:** lähtevätkö viestit Janin nimissä? Allekirjoitus on nyt "Jani, SEO Sales".
- **Uutiskirje:** mihin uutiskirjeen tilaajat viedään? Nyt tilaus tallentuu Formspree-ilmoitukseen.
- **Pisteytys:** tiukennetaanko sitä? Nyt seosales.fi saa 97/100 ja useimmat sivustot 75–95.
- **Työkalusivun ulkoasu:** saako sivu oman kevyen ylätunnisteensa (nyt) vai seosales.fi:n koko navigaation?

## 8. Kustannukset

| Palvelu | Ilmaistaso | Riittääkö |
|---|---|---|
| Google Cloud Run | 2 milj. pyyntöä ja 180 000 vCPU-sekuntia / kk | Kyllä, moninkertaisesti. Kuvan tallennuksesta voi tulla muutama sentti. |
| Resend | 3 000 viestiä / kk, 100 / vrk | Kyllä, noin 50 liidiä vuorokaudessa |
| Formspree | noin 50 lähetystä / kk (tarkista) | Alkuun kyllä |
| GitHub Pages | ilmainen | Kyllä |
