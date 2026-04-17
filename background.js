// background.js - Service Worker (Manifest V3)
// Centrale router voor de Verkoopklaar Coach extensie.

let sessionState = {
  state: 'idle', // 'idle' | 'active' | 'error'
  meetingId: null,
  tabId: null,
  message: null,
};

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

  // Doorsturingen van offscreen document naar content-script worden hier niet
  // behandeld; offscreen stuurt zelf statussen via chrome.runtime.sendMessage.
  return false;
});

async function handleStartSession({ jwt, meetingId, supabaseUrl }) {
  sessionState = { state: 'idle', meetingId, tabId: null, message: null };

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
