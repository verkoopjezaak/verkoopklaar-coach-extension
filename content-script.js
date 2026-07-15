// content-script.js
// Wordt geïnjecteerd op de Verkoopklaar meeting-join pagina's.
// Taak 8: pagina-detectie en handshake tussen web-app en service worker.

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

// Luister op WS_EVENT relays van de service worker en forward naar de webapp.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'COACH_EXT_WS_EVENT' && message.payload) {
    postToPage('COACH_EXT_WS_EVENT', { payload: message.payload });
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
