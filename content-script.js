// content-script.js
// Wordt geïnjecteerd op de Verkoopklaar meeting-join pagina's.
// Taak 8: pagina-detectie en handshake tussen web-app en service worker.
//
// Injectie gebeurt op twee manieren:
//   1. via manifest content_scripts bij een volledige paginalaad op een
//      meeting-URL;
//   2. programmatisch door background.js (chrome.scripting) wanneer de SPA
//      zonder herlaad naar een meeting-URL navigeert (dashboard -> advisor-join).
// Beide paden kunnen elkaar kruisen; de guard hieronder zorgt dat het script
// per document maar één keer luistert. Bij een tweede injectie kondigen we ons
// alleen opnieuw aan, zodat de web-app (die dan opnieuw pingt) de handshake
// alsnog rondmaakt.

if (globalThis.__vkCoachContentScriptLoaded) {
  // Al actief in dit document: alleen opnieuw aankondigen (zonder nonce, de
  // pagina antwoordt met een nieuwe PING) en verder niets dubbel registreren.
  globalThis.__vkCoachAnnounceReady?.();
} else {
globalThis.__vkCoachContentScriptLoaded = true;

// Taak 7: bepaal de Supabase-project URL op basis van de huidige hostname.
const isPreview = location.hostname.includes('preview');
const supabaseUrl = isPreview
  ? 'https://qmkuqyzqpokjzpnwbvzu.supabase.co'
  : 'https://zkpcahogliwakywbsews.supabase.co';

// Per page-load challenge. De pagina kiest de nonce; de extensie echoot hem in
// ieder antwoord. Dit voorkomt dat stale of willekeurige protocolberichten een
// actieve handshake kunnen overnemen. De token zelf is daarnaast kortlevend en
// meetinggebonden.
let activeNonce = null;

function postToPage(type, payload = {}, nonce = activeNonce) {
  window.postMessage({ type, ...payload, ...(nonce ? { nonce } : {}) }, window.location.origin);
}

// Stap 1: kondig aanwezigheid aan. De initiële berichten zijn alleen backwards
// compatible detecties; de veilige flow start pas na een PING met nonce.
function announceReady(nonce = activeNonce) {
  postToPage('COACH_EXT_READY', {}, nonce);
}
globalThis.__vkCoachAnnounceReady = () => announceReady(null);
announceReady();
setTimeout(announceReady, 500);
setTimeout(announceReady, 1500);
setTimeout(announceReady, 3500);

// Stap 2: Luister op berichten van de web-app.
window.addEventListener('message', (ev) => {
  // Accepteer alleen berichten van de eigen pagina.
  if (ev.source !== window) return;
  if (ev.origin !== window.location.origin) return;
  const data = ev.data;
  if (!data || typeof data.type !== 'string') return;

  // Webapp mag ping sturen om te checken of extensie aanwezig is.
  if (data.type === 'COACH_EXT_PING') {
    if (typeof data.nonce !== 'string' || data.nonce.length < 16) return;
    activeNonce = data.nonce;
    announceReady(activeNonce);
    return;
  }

  // Na de PING moet ieder bericht aan exact dezelfde page-loadnonce zijn
  // gebonden. Berichten zonder of met een andere nonce worden genegeerd.
  if (!activeNonce || data.nonce !== activeNonce) return;

  if (data.type === 'COACH_EXT_REQUEST_TOKEN') {
    handleStartRequest(data);
    return;
  }

  if (data.type === 'COACH_EXT_STOP') {
    handleStopRequest();
    return;
  }

  // Videoconferentie beëindigd (Jitsi videoConferenceLeft/readyToClose, door de
  // web-app doorgestuurd). Forward naar de service worker zodat die het einde
  // over de coach-WS meldt en de sessie netjes afsluit (voorkomt dat post-call-
  // audio nog wordt getranscribeerd).
  // Jitsi-mute-status van de webapp (audioMuteStatusChanged / isAudioMuted).
  // Het offscreen-document zet de coach-mic-tracks op enabled=false bij mute.
  if (data.type === 'COACH_EXT_MIC_MUTE') {
    chrome.runtime.sendMessage({ type: 'SET_MIC_MUTE', muted: !!data.muted }).catch(() => { /* ignore */ });
    return;
  }

  // Jitsi-mic-device van de webapp (1.0.26): label + (origin-gebonden) deviceId.
  // Background bewaart het; offscreen ontvangt hetzelfde bericht live en
  // her-acquireert de mic als het label verandert.
  if (data.type === 'COACH_EXT_MIC_DEVICE') {
    chrome.runtime.sendMessage({
      type: 'SET_MIC_DEVICE',
      label: typeof data.label === 'string' ? data.label : null,
      deviceId: typeof data.deviceId === 'string' ? data.deviceId : null,
    }).catch(() => { /* ignore */ });
    return;
  }

  if (data.type === 'COACH_EXT_CONFERENCE_END') {
    chrome.runtime.sendMessage({ type: 'CONFERENCE_END' }).catch(() => { /* ignore */ });
    return;
  }

  // Webapp publiceert een kortlevende coach-token + meetingId zodat de popup
  // kan starten. Een Supabase-sessie-JWT wordt nooit ontvangen of opgeslagen.
  if (data.type === 'COACH_EXT_SET_CONTEXT') {
    chrome.runtime.sendMessage({
      type: 'SET_CONTEXT',
      coachToken: data.coachToken,
      meetingId: data.meetingId,
      supabaseUrl,
      nonce: activeNonce,
    }).catch(() => { /* ignore */ });
    return;
  }
});

// Stap 3: Verwerk start-verzoek van web-app.
function handleStartRequest(data) {
  const { coachToken, meetingId } = data;

  if (!coachToken || !meetingId) {
    postToPage('COACH_EXT_ERROR', {
      message: 'coachToken of meetingId ontbreekt in COACH_EXT_REQUEST_TOKEN',
    });
    return;
  }

  // Bevestig ontvangst aan de web-app.
  postToPage('COACH_EXT_ACK');

  // Stuur START_SESSION naar service worker.
  chrome.runtime.sendMessage(
    { type: 'START_SESSION', coachToken, meetingId, supabaseUrl, nonce: activeNonce },
    (response) => {
      if (chrome.runtime.lastError) {
        postToPage('COACH_EXT_ERROR', {
          message: chrome.runtime.lastError.message,
        });
        return;
      }

      if (response?.ok) {
        // Stap 4: Sessie succesvol gestart.
        postToPage('COACH_EXT_SESSION_STARTED');
      } else {
        // Stap 5: Fout van service worker.
        postToPage('COACH_EXT_ERROR', {
          message: response?.error || 'Onbekende fout bij starten van sessie',
        });
      }
    }
  );
}

// Luister op relays van de service worker en forward naar de webapp.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'COACH_EXT_WS_EVENT' && message.payload) {
    postToPage('COACH_EXT_WS_EVENT', { payload: message.payload });
    return;
  }
  // Een eerdere Start-poging (COACH_EXT_REQUEST_TOKEN) liep vast op de
  // activeTab-eis van tabCapture; de popup is inmiddels geopend (= invocatie)
  // en de service worker heeft de sessie alsnog gestart. Deze melding loopt
  // buiten de normale ACK-flow van handleStartRequest om.
  if (message?.type === 'COACH_EXT_RESUMED') {
    postToPage('COACH_EXT_RESUMED');
    return;
  }
  // De popup vraagt (via background) om de meeting-context. Is de handshake
  // al rond (activeNonce), dan vraagt de pagina om een verse context-publish.
  // Zo niet, dan kondigen we ons opnieuw aan zodat de pagina opnieuw pingt en
  // de handshake alsnog start. Antwoord meldt welk pad we namen.
  if (message?.type === 'REQUEST_CONTEXT') {
    if (activeNonce) {
      postToPage('COACH_EXT_REQUEST_CONTEXT');
      sendResponse({ ok: true, handshake: 'active' });
    } else {
      announceReady(null);
      sendResponse({ ok: true, handshake: 'pending' });
    }
    return;
  }
});

// Stop-verzoek verwerken.
function handleStopRequest() {
  chrome.runtime.sendMessage({ type: 'STOP_SESSION' }, () => {
    if (chrome.runtime.lastError) {
      console.warn('[coach-ext/content] STOP_SESSION fout:', chrome.runtime.lastError.message);
    }
  });
}
} // einde injectie-guard
