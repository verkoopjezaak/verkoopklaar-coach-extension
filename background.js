// background.js - Service Worker (Manifest V3)
// Centrale router voor de Verkoopklaar Coach extensie.

let sessionState = {
  state: 'idle', // 'idle' | 'active' | 'error'
  meetingId: null,
  message: null,
};

let keepAliveInterval = null;

// Wissel het toolbar-icoon afhankelijk van actieve sessie. Rood mic op wit =
// sessie actief. Wit mic op rode achtergrond = idle (geen sessie).
function setToolbarIcon(isActive) {
  const variant = isActive ? 'active' : 'idle';
  chrome.action.setIcon({
    path: {
      16: `icons/icon-${variant}-16.png`,
      48: `icons/icon-${variant}-48.png`,
      128: `icons/icon-${variant}-128.png`,
    },
  }).catch(() => { /* ignore, bv. als popup niet beschikbaar is */ });
}

// Keep-alive: voorkomt service-worker-terminatie tijdens actieve sessie.
function startKeepAlive() {
  if (keepAliveInterval) return;
  keepAliveInterval = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => { /* intentional keep-alive */ });
  }, 25000);
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

// Maak het offscreen document aan als het nog niet bestaat.
async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (existingContexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Audio-capture voor de Verkoopklaar gesprekscoach via tabCapture en getUserMedia.',
  });
}

// Sluit het offscreen document als het bestaat.
async function closeOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (existingContexts.length === 0) return;
  await chrome.offscreen.closeDocument();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'GET_STATUS') {
    sendResponse(sessionState);
    return false; // synchrone response
  }

  if (message.type === 'START_SESSION') {
    const { jwt, meetingId, supabaseUrl } = message;
    handleStartSession({ jwt, meetingId, supabaseUrl })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error('[coach-ext] START_SESSION fout:', err);
        sessionState = { state: 'error', meetingId, message: err.message };
        setToolbarIcon(false);
        sendResponse({ ok: false, error: err.message });
      });
    return true; // asynchrone response
  }

  if (message.type === 'STOP_SESSION') {
    handleStopSession()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error('[coach-ext] STOP_SESSION fout:', err);
        sendResponse({ ok: false, error: err.message });
      });
    return true; // asynchrone response
  }

  // Doorsturingen van offscreen document naar content-script worden hier niet
  // behandeld; offscreen stuurt zelf statussen via chrome.runtime.sendMessage.
  return false;
});

async function handleStartSession({ jwt, meetingId, supabaseUrl }) {
  sessionState = { state: 'idle', meetingId, message: null };

  // Haal de actieve tab op via activeTab permissie.
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id) {
    throw new Error('Geen actieve tab gevonden');
  }

  // Verkrijg stream-ID voor de tab.
  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: activeTab.id,
  });

  if (!streamId) {
    throw new Error('tabCapture.getMediaStreamId leverde geen stream-ID op');
  }

  // Zorg dat het offscreen document bestaat.
  await ensureOffscreenDocument();

  // Stuur de audio-start instructie naar het offscreen document.
  await chrome.runtime.sendMessage({
    type: 'START_AUDIO',
    streamId,
    jwt,
    meetingId,
    supabaseUrl,
  });

  sessionState = { state: 'active', meetingId, message: null };
  setToolbarIcon(true);
  startKeepAlive();
}

async function handleStopSession() {
  stopKeepAlive();

  try {
    await chrome.runtime.sendMessage({ type: 'STOP_AUDIO' });
  } catch {
    // Offscreen document al gesloten of nooit gestart — geen probleem.
  }

  await closeOffscreenDocument();
  sessionState = { state: 'idle', meetingId: null, message: null };
  setToolbarIcon(false);
}
