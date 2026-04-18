// background.js - Service Worker (Manifest V3)
// Centrale router voor de Verkoopklaar Coach extensie.

let sessionState = {
  state: 'idle', // 'idle' | 'active' | 'error'
  meetingId: null,
  tabId: null,
  message: null,
};

// Per-tab meeting-context, gevuld door de webapp via postMessage →
// content-script → chrome.runtime.sendMessage. Popup leest hieruit om de
// start-knop te enablen zodra een meeting-tab open staat.
const tabContexts = new Map(); // tabId -> { jwt, meetingId, supabaseUrl, updatedAt }

let keepAliveInterval = null;

// Drie toolbar-icoon-states:
// - default: grijs mic, transparant. Tab is geen Verkoopklaar meeting.
// - ready:   wit mic op groen. Extensie kan koppelen maar sessie nog niet actief.
// - active:  wit mic op rood. Audio wordt daadwerkelijk opgenomen.
function setToolbarIcon(variant, tabId) {
  const path = {
    16: `icons/icon-${variant}-16.png`,
    48: `icons/icon-${variant}-48.png`,
    128: `icons/icon-${variant}-128.png`,
  };
  const details = tabId !== undefined ? { path, tabId } : { path };
  chrome.action.setIcon(details).catch(() => { /* ignore */ });
}

// URL-patroon dat ook in manifest.content_scripts.matches staat.
const MEETING_URL_RE = /^https:\/\/(preview|app)\.verkoopjezaak\.nl\/client\/[^/]+\/meetings\/[^/]+\/join/;

function urlIsMeetingPage(url) {
  return typeof url === 'string' && MEETING_URL_RE.test(url);
}

// Zet het juiste icoon per tab op basis van URL en sessie-status.
function refreshTabIcon(tabId, url) {
  if (sessionState.state === 'active' && sessionState.tabId === tabId) {
    setToolbarIcon('active', tabId);
    return;
  }
  if (urlIsMeetingPage(url)) {
    setToolbarIcon('ready', tabId);
  } else {
    setToolbarIcon('default', tabId);
  }
}

// Houd alle open tabs bij voor icoon-updates.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' || changeInfo.url) {
    refreshTabIcon(tabId, tab.url);
  }
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) return;
    refreshTabIcon(tabId, tab.url);
  });
});

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

// Ruim contexten op wanneer een tab sluit of naar andere URL navigeert.
chrome.tabs.onRemoved.addListener((tabId) => {
  tabContexts.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SET_CONTEXT') {
    const tabId = sender.tab?.id;
    if (tabId != null) {
      tabContexts.set(tabId, {
        jwt: message.jwt,
        meetingId: message.meetingId,
        supabaseUrl: message.supabaseUrl,
        updatedAt: Date.now(),
      });
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'GET_CONTEXT') {
    const tabId = message.tabId ?? sender.tab?.id;
    const ctx = tabId != null ? tabContexts.get(tabId) : null;
    sendResponse({ context: ctx ?? null });
    return false;
  }

  if (message.type === 'SESSION_FAILED') {
    // Offscreen heeft opgegeven na reconnect-falen. Update sessionState zodat
    // popup 'Fout' toont met Reset-knop in plaats van 'Sessie actief'.
    const endedTabId = sessionState.tabId;
    sessionState = {
      state: 'error',
      meetingId: sessionState.meetingId,
      tabId: endedTabId,
      message: message.reason || 'Sessie verbroken',
    };
    stopKeepAlive();
    if (endedTabId) {
      chrome.tabs.get(endedTabId, (tab) => {
        if (!chrome.runtime.lastError && tab) refreshTabIcon(tab.id, tab.url);
      });
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'GET_FRESH_CONTEXT') {
    // Offscreen vraagt bij reconnect om de meest recente webapp-gepubliceerde
    // JWT. Webapp publiceert elke 4 min; voor een langere sessie is die
    // nieuwer dan de JWT waarmee we zijn gestart.
    const tabId = sessionState.tabId;
    const ctx = tabId != null ? tabContexts.get(tabId) : null;
    sendResponse({
      jwt: ctx?.jwt ?? null,
      meetingId: ctx?.meetingId ?? sessionState.meetingId,
      supabaseUrl: ctx?.supabaseUrl ?? null,
    });
    return false;
  }

  if (message.type === 'WS_EVENT') {
    // Relay coach-stream events van offscreen naar de meeting-tab zodat de
    // webapp ze kan tonen (transcript, interim, errors, ended).
    const targetTabId = sessionState.tabId;
    if (targetTabId != null) {
      chrome.tabs.sendMessage(targetTabId, {
        type: 'COACH_EXT_WS_EVENT',
        payload: message.payload,
      }).catch(() => { /* content-script kan weg zijn */ });
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'GET_STATUS') {
    sendResponse(sessionState);
    return false; // synchrone response
  }

  if (message.type === 'START_SESSION') {
    const { jwt, meetingId, supabaseUrl, initiatorTabId } = message;
    handleStartSession({ jwt, meetingId, supabaseUrl, initiatorTabId })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error('[coach-ext] START_SESSION fout:', err);
        sessionState = { state: 'error', meetingId, tabId: null, message: err.message };
        // Bij fout: laat icoon default/ready afhankelijk van huidige tab-URL
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const t = tabs[0];
          if (t) refreshTabIcon(t.id, t.url);
        });
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

  if (message.type === 'RESET_SESSION') {
    // Harde reset: forceer idle-state, teardown offscreen, reset alle flags.
    // Gebruikt door de popup Reset-knop na een error zodat de volgende start
    // niet op residual state loopt (actieve tab-streams, oude session-id).
    handleResetSession()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error('[coach-ext] RESET_SESSION fout:', err);
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  // Doorsturingen van offscreen document naar content-script worden hier niet
  // behandeld; offscreen stuurt zelf statussen via chrome.runtime.sendMessage.
  return false;
});

async function handleStartSession({ jwt, meetingId, supabaseUrl }) {
  sessionState = { state: 'idle', meetingId, tabId: null, message: null };

  // Teardown van eventuele oude offscreen-context. Als een vorige sessie
  // crashte of de WebSocket dropte zonder stopAudio(), houdt offscreen nog
  // actieve tab-capture streams. Een nieuwe getMediaStreamId() op dezelfde
  // tab faalt dan met "Cannot capture a tab with an active stream". Voorkom
  // dat door altijd schoon te beginnen.
  stopKeepAlive();
  try {
    await chrome.runtime.sendMessage({ type: 'STOP_AUDIO' });
  } catch { /* offscreen bestond niet, prima */ }
  await closeOffscreenDocument().catch(() => { /* ignore */ });

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

  // Stuur de audio-start instructie naar het offscreen document en wacht op
  // bevestiging. Offscreen kan falen op getUserMedia, AudioWorklet of WebSocket.
  const audioResponse = await chrome.runtime.sendMessage({
    type: 'START_AUDIO',
    streamId,
    jwt,
    meetingId,
    supabaseUrl,
  });

  if (!audioResponse?.ok) {
    // Ruim offscreen op zodat een volgende poging clean begint.
    await closeOffscreenDocument().catch(() => { /* ignore */ });
    throw new Error(audioResponse?.error || 'Offscreen audio-capture faalde');
  }

  sessionState = { state: 'active', meetingId, tabId: activeTab.id, message: null };
  setToolbarIcon('active', activeTab.id);
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
  const endedTabId = sessionState.tabId;
  sessionState = { state: 'idle', meetingId: null, tabId: null, message: null };
  // Refresh icoon: als tab nog steeds een meeting-URL is, wordt hij groen (ready),
  // anders default.
  if (endedTabId) {
    chrome.tabs.get(endedTabId, (tab) => {
      if (!chrome.runtime.lastError && tab) refreshTabIcon(tab.id, tab.url);
    });
  }
}

async function handleResetSession() {
  // Zelfde cleanup als stop, maar werkt ongeacht huidige sessionState
  // (error, idle, stale). Gebruikt als panic-button in de popup.
  stopKeepAlive();
  try { await chrome.runtime.sendMessage({ type: 'STOP_AUDIO' }); } catch { /* offscreen ontbreekt */ }
  await closeOffscreenDocument().catch(() => { /* ignore */ });
  const endedTabId = sessionState.tabId;
  sessionState = { state: 'idle', meetingId: null, tabId: null, message: null };
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const t = tabs[0];
    if (t) refreshTabIcon(t.id, t.url);
  });
  // Zorg dat icoon van de vorige sessie-tab ook gerefresh wordt.
  if (endedTabId) {
    chrome.tabs.get(endedTabId, (tab) => {
      if (!chrome.runtime.lastError && tab) refreshTabIcon(tab.id, tab.url);
    });
  }
}
