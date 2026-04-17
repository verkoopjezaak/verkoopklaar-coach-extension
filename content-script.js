// content-script.js
// Wordt geïnjecteerd op de Verkoopklaar meeting-join pagina's.
// Taak 8: pagina-detectie en handshake tussen web-app en service worker.

// Taak 7: bepaal de Supabase-project URL op basis van de huidige hostname.
const isPreview = location.hostname.includes('preview');
const supabaseUrl = isPreview
  ? 'https://qmkuqyzqpokjzpnwbvzu.supabase.co'
  : 'https://zkpcahogliwakywbsews.supabase.co';

// Stap 1: Stuur aankondiging naar de webpagina. Herhaal paar keer zodat een
// hook die later mount het nog ziet. Plus expliciete COACH_EXT_PING antwoord.
function announceReady() {
  window.postMessage({ type: 'COACH_EXT_READY' }, '*');
}
announceReady();
setTimeout(announceReady, 500);
setTimeout(announceReady, 1500);
setTimeout(announceReady, 3500);

// Stap 2: Luister op berichten van de web-app.
window.addEventListener('message', (ev) => {
  // Accepteer alleen berichten van de eigen pagina.
  if (ev.source !== window) return;
  const data = ev.data;
  if (!data || typeof data.type !== 'string') return;

  // Webapp mag ping sturen om te checken of extensie aanwezig is.
  if (data.type === 'COACH_EXT_PING') {
    announceReady();
    return;
  }

  if (data.type === 'COACH_EXT_REQUEST_TOKEN') {
    handleStartRequest(data);
    return;
  }

  if (data.type === 'COACH_EXT_STOP') {
    handleStopRequest();
    return;
  }
});

// Stap 3: Verwerk start-verzoek van web-app.
function handleStartRequest(data) {
  const { jwt, meetingId } = data;

  if (!jwt || !meetingId) {
    window.postMessage({
      type: 'COACH_EXT_ERROR',
      message: 'jwt of meetingId ontbreekt in COACH_EXT_REQUEST_TOKEN',
    }, '*');
    return;
  }

  // Bevestig ontvangst aan de web-app.
  window.postMessage({ type: 'COACH_EXT_ACK' }, '*');

  // Stuur START_SESSION naar service worker.
  chrome.runtime.sendMessage(
    { type: 'START_SESSION', jwt, meetingId, supabaseUrl },
    (response) => {
      if (chrome.runtime.lastError) {
        window.postMessage({
          type: 'COACH_EXT_ERROR',
          message: chrome.runtime.lastError.message,
        }, '*');
        return;
      }

      if (response?.ok) {
        // Stap 4: Sessie succesvol gestart.
        window.postMessage({ type: 'COACH_EXT_SESSION_STARTED' }, '*');
      } else {
        // Stap 5: Fout van service worker.
        window.postMessage({
          type: 'COACH_EXT_ERROR',
          message: response?.error || 'Onbekende fout bij starten van sessie',
        }, '*');
      }
    }
  );
}

// Stop-verzoek verwerken.
function handleStopRequest() {
  chrome.runtime.sendMessage({ type: 'STOP_SESSION' }, () => {
    if (chrome.runtime.lastError) {
      console.warn('[coach-ext/content] STOP_SESSION fout:', chrome.runtime.lastError.message);
    }
  });
}
