# Verkoopklaar Coach – Chrome Extensie

Tab-audio capture voor de Verkoopklaar gesprekscoach.
Vervangt de `getDisplayMedia`-dialoog (scherm-delen) door directe tab-audio capture via `chrome.tabCapture`.

---

## Vereisten

- Chrome 109 of nieuwer (Manifest V3 + offscreen API vereist)
- Toegang tot `preview.verkoopjezaak.nl` of `app.verkoopjezaak.nl`
- Ingelogd als advisor in de web-app

---

## Installatie (developer-mode sideload)

1. Open Chrome en ga naar `chrome://extensions/`
2. Schakel **Ontwikkelaarsmodus** in (toggle rechtsboven)
3. Klik **Niet-ingepakte extensie laden** (Load unpacked)
4. Selecteer de map `chrome-extension/` uit deze repo
5. De extensie verschijnt in de lijst als **Verkoopklaar Coach**
6. Het extensie-icoon verschijnt in de Chrome-toolbar (of via het puzzelstukje-menu)

---

## Testen

### Stap-voor-stap verificatie

1. Ga naar `https://preview.verkoopjezaak.nl/client/{clientId}/meetings/{meetingId}/join`
2. Open de browser-console (F12)
3. Controleer dat het bericht `COACH_EXT_READY` zichtbaar is in de console van de web-app
4. Klik **Coach starten** in het coach-panel
5. Verificeer: **geen scherm-deel-dialoog verschijnt** (dit betekent dat de extensie actief is)
6. Verificeer: transcriptie verschijnt na enkele seconden in het coach-panel

### Verwachte console-output (offscreen document)

Open via `chrome://extensions/` > Verkoopklaar Coach > **Service worker** > Inspect:

```
[coach-ext/offscreen] Audio-capture gestart
[coach-ext/offscreen] WebSocket verbonden
```

### Fallback testen

Deactiveer de extensie via `chrome://extensions/` en herlaad de meeting-pagina.
De coach-panel toont dan weer de `getDisplayMedia`-dialoog (scherm-delen).

---

## Update-procedure

1. Breng wijzigingen aan in de bestanden in `chrome-extension/`
2. Ga naar `chrome://extensions/`
3. Klik het **vernieuwen**-icoon naast Verkoopklaar Coach
4. Herlaad de meeting-pagina

---

## Hoe de extensie werkt

```
Webpagina (meeting-join)
  └── content-script.js        Detecteert extensie, relay postMessage ↔ service worker
        ↕ postMessage
  Web-app (useLiveCoach.ts)    Extensie-detectie via COACH_EXT_READY, start via COACH_EXT_REQUEST_TOKEN

        ↕ chrome.runtime.sendMessage
  background.js (service worker)
    ├── chrome.tabCapture.getMediaStreamId()  → stream-ID voor aktieve tab
    ├── chrome.offscreen.createDocument()     → start offscreen document
    └── sendMessage START_AUDIO → offscreen.js

  offscreen.js (offscreen document)
    ├── getUserMedia({ chromeMediaSource: 'tab', chromeMediaSourceId })  → tab-audio
    ├── getUserMedia({ audio: true })                                    → microfoon
    ├── AudioWorklet (worklet-processor.js)  → PCM16 encoding, source-labeling
    └── WebSocket → coach-stream edge function (zelfde backend als getDisplayMedia-pad)
```

### Berichtprotocol (postMessage)

| Van | Naar | Type | Inhoud |
|-----|------|------|--------|
| content-script | web-app | `COACH_EXT_READY` | aanwezigheid extensie |
| web-app | content-script | `COACH_EXT_REQUEST_TOKEN` | `{ jwt, meetingId }` |
| content-script | web-app | `COACH_EXT_ACK` | ontvangstbevestiging |
| service worker | web-app (via content-script) | `COACH_EXT_SESSION_STARTED` | sessie actief |
| service worker | web-app (via content-script) | `COACH_EXT_ERROR` | foutbericht |
| web-app | content-script | `COACH_EXT_STOP` | stop sessie |

---

## Productie-distributie via Chrome Web Store

> Aanbevolen na succesvolle testfase door Maarten en Bernd.

### Stappen

1. **Registratie:** Maak een Google Chrome Web Store developer-account aan via [chromewebstore.google.com/devconsole](https://chromewebstore.google.com/devconsole). Eenmalige kosten: $5 USD.

2. **Privacy-beleid:** De extensie verwerkt audio-data van de gebruiker. Een privacybeleid-URL is vereist bij publicatie. Gebruik de bestaande privacypagina van Verkoopklaar, of maak een extensie-specifieke subpagina aan.

3. **Pakket maken:** Zip de `chrome-extension/` map (zonder de `.git`-map):
   ```bash
   cd verkoopklaar
   zip -r verkoopklaar-coach-extension.zip chrome-extension/
   ```

4. **Uploaden:** Ga naar de Chrome Web Store developer-console, klik **Nieuw item toevoegen** en upload de zip.

5. **Zichtbaarheid:** Kies **Niet-openbaar (unlisted)**. De extensie is alleen beschikbaar via een directe Chrome Web Store link. Niet zichtbaar in zoekresultaten.

6. **Review:** Gemiddeld 1 tot 3 werkdagen. Bij updates: opnieuw 1 tot 2 werkdagen.

7. **Installatie-link:** Deel de Chrome Web Store link met Bernd na goedkeuring.

### Tijdslijn

- **Nu:** Sideload via developer-mode (test-fase, direct bruikbaar)
- **Na succesvolle test:** Web Store-publicatie als unlisted extensie
- **Toekomst:** Overweeg host_permissions uitbreiden als de extensie op meer domeinen nodig is
