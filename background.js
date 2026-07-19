// background.js - Service Worker (Manifest V3)
// Centrale router voor de Verkoopklaar Coach extensie.
//
// MV3-hardening (1.0.18): een service worker kan tussen events worden
// gesuspendeerd, waarna in-memory state verdwijnt. sessionState en tabContexts
// leven daarom in chrome.storage.session (overleeft worker-herstart binnen de
// browsersessie). De keepalive gebruikt chrome.alarms i.p.v. een setInterval
// (die wordt bij suspensie gewist). Zo overleeft de token-refresh + WS_EVENT-
// relay een worker-herstart, de hoofdverdachte voor wegvallende mic-audio.

const DEFAULT_SESSION_STATE = {
  state: 'idle', // 'idle' | 'active' | 'error'
  meetingId: null,
  tabId: null,
  message: null,
};

// ---- Persistente state via chrome.storage.session -------------------------
async function getSessionState() {
  const { sessionState } = await chrome.storage.session.get('sessionState');
  return sessionState ?? { ...DEFAULT_SESSION_STATE };
}
async function setSessionState(next) {
  await chrome.storage.session.set({ sessionState: next });
}
async function getTabContexts() {
  const { tabContexts } = await chrome.storage.session.get('tabContexts');
  return tabContexts ?? {};
}
async function getTabContext(tabId) {
  if (tabId == null) return null;
  const map = await getTabContexts();
  return map[tabId] ?? null;
}
async function setTabContext(tabId, ctx) {
  const map = await getTabContexts();
  map[tabId] = ctx;
  await chrome.storage.session.set({ tabContexts: map });
}
async function deleteTabContext(tabId) {
  const map = await getTabContexts();
  if (map[tabId]) {
    delete map[tabId];
    await chrome.storage.session.set({ tabContexts: map });
  }
}

// ---- Toolbar-icoon ---------------------------------------------------------
// Drie states: default (grijs), ready (groen), active (rood).
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
const MEETING_URL_RE = /^https:\/\/(preview|app)\.verkoopjezaak\.nl\/client\/[^/]+\/(meetings\/[^/]+\/join|lead-meeting\/[^/]+\/advisor-join)/;

function urlIsMeetingPage(url) {
  return typeof url === 'string' && MEETING_URL_RE.test(url);
}

// Zet het juiste icoon per tab op basis van URL en sessie-status.
async function refreshTabIcon(tabId, url) {
  const s = await getSessionState();
  if (s.state === 'active' && s.tabId === tabId) {
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
    void refreshTabIcon(tabId, tab.url);
  }
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) return;
    void refreshTabIcon(tabId, tab.url);
  });
});

// ---- Keepalive via chrome.alarms ------------------------------------------
// Het wekken van de worker door de alarm is zelf de keepalive; de handler hoeft
// niets te doen. chrome.alarms overleeft worker-suspensie, setInterval niet.
const KEEPALIVE_ALARM = 'coach-keepalive';
function startKeepAlive() {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
}
function stopKeepAlive() {
  chrome.alarms.clear(KEEPALIVE_ALARM).catch(() => { /* ignore */ });
}
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) { /* wake = keepalive, geen actie nodig */ }
});

// ---- Offscreen document ----------------------------------------------------
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

async function closeOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (existingContexts.length === 0) return;
  await chrome.offscreen.closeDocument();
}

// Ruim context op wanneer een tab sluit.
chrome.tabs.onRemoved.addListener((tabId) => {
  void deleteTabContext(tabId);
});

// ---- Message-router --------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SET_CONTEXT') {
    (async () => {
      const tabId = sender.tab?.id;
      if (tabId != null) {
        await setTabContext(tabId, {
          coachToken: message.coachToken,
          meetingId: message.meetingId,
          supabaseUrl: message.supabaseUrl,
          nonce: message.nonce,
          updatedAt: Date.now(),
        });
      }
      sendResponse({ ok: true });
    })();
    return true; // async response
  }

  if (message.type === 'GET_CONTEXT') {
    (async () => {
      const tabId = message.tabId ?? sender.tab?.id;
      const ctx = await getTabContext(tabId);
      sendResponse({ context: ctx });
    })();
    return true;
  }

  if (message.type === 'SESSION_FAILED') {
    (async () => {
      // Offscreen heeft opgegeven na reconnect-falen. Update sessionState zodat
      // de popup 'Fout' toont met Reset-knop in plaats van 'Sessie actief'.
      const cur = await getSessionState();
      const endedTabId = cur.tabId;
      await setSessionState({
        state: 'error',
        meetingId: cur.meetingId,
        tabId: endedTabId,
        message: message.reason || 'Sessie verbroken',
      });
      stopKeepAlive();
      if (endedTabId) {
        chrome.tabs.get(endedTabId, (tab) => {
          if (!chrome.runtime.lastError && tab) void refreshTabIcon(tab.id, tab.url);
        });
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === 'GET_FRESH_CONTEXT') {
    (async () => {
      // Offscreen vraagt bij reconnect om de meest recente kortlevende coach-token.
      const s = await getSessionState();
      const ctx = await getTabContext(s.tabId);
      sendResponse({
        coachToken: ctx?.coachToken ?? null,
        meetingId: ctx?.meetingId ?? s.meetingId,
        supabaseUrl: ctx?.supabaseUrl ?? null,
        nonce: ctx?.nonce ?? null,
      });
    })();
    return true;
  }

  if (message.type === 'WS_EVENT') {
    (async () => {
      // Relay coach-stream events van offscreen naar de meeting-tab.
      const s = await getSessionState();
      if (s.tabId != null) {
        chrome.tabs.sendMessage(s.tabId, {
          type: 'COACH_EXT_WS_EVENT',
          payload: message.payload,
        }).catch(() => { /* content-script kan weg zijn */ });
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === 'GET_STATUS') {
    (async () => {
      sendResponse(await getSessionState());
    })();
    return true;
  }

  if (message.type === 'START_SESSION') {
    const { coachToken, meetingId, supabaseUrl, nonce } = message;
    handleStartSession({ coachToken, meetingId, supabaseUrl, nonce })
      .then(() => sendResponse({ ok: true }))
      .catch(async (err) => {
        console.error('[coach-ext] START_SESSION fout:', err);
        await setSessionState({ state: 'error', meetingId, tabId: null, message: err.message });
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const t = tabs[0];
          if (t) void refreshTabIcon(t.id, t.url);
        });
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  if (message.type === 'STOP_SESSION') {
    handleStopSession()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error('[coach-ext] STOP_SESSION fout:', err);
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  if (message.type === 'RESET_SESSION') {
    handleResetSession()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error('[coach-ext] RESET_SESSION fout:', err);
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  return false;
});

async function handleStartSession({ coachToken, meetingId, supabaseUrl, nonce }) {
  await setSessionState({ state: 'idle', meetingId, tabId: null, message: null });

  // Teardown van eventuele oude offscreen-context zodat een nieuwe tabCapture
  // op dezelfde tab niet faalt met "Cannot capture a tab with an active stream".
  stopKeepAlive();
  try {
    await chrome.runtime.sendMessage({ type: 'STOP_AUDIO' });
  } catch { /* offscreen bestond niet, prima */ }
  await closeOffscreenDocument().catch(() => { /* ignore */ });

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id) {
    throw new Error('Geen actieve tab gevonden');
  }

  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: activeTab.id,
  });
  if (!streamId) {
    throw new Error('tabCapture.getMediaStreamId leverde geen stream-ID op');
  }

  await ensureOffscreenDocument();

  const audioResponse = await chrome.runtime.sendMessage({
    type: 'START_AUDIO',
    streamId,
    coachToken,
    meetingId,
    supabaseUrl,
    nonce,
  });

  if (!audioResponse?.ok) {
    await closeOffscreenDocument().catch(() => { /* ignore */ });
    throw new Error(audioResponse?.error || 'Offscreen audio-capture faalde');
  }

  await setSessionState({ state: 'active', meetingId, tabId: activeTab.id, message: null });
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
  const cur = await getSessionState();
  const endedTabId = cur.tabId;
  await setSessionState({ ...DEFAULT_SESSION_STATE });
  if (endedTabId) {
    chrome.tabs.get(endedTabId, (tab) => {
      if (!chrome.runtime.lastError && tab) void refreshTabIcon(tab.id, tab.url);
    });
  }
}

async function handleResetSession() {
  // Zelfde cleanup als stop, maar werkt ongeacht huidige sessionState.
  stopKeepAlive();
  try { await chrome.runtime.sendMessage({ type: 'STOP_AUDIO' }); } catch { /* offscreen ontbreekt */ }
  await closeOffscreenDocument().catch(() => { /* ignore */ });
  const cur = await getSessionState();
  const endedTabId = cur.tabId;
  await setSessionState({ ...DEFAULT_SESSION_STATE });
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const t = tabs[0];
    if (t) void refreshTabIcon(t.id, t.url);
  });
  if (endedTabId) {
    chrome.tabs.get(endedTabId, (tab) => {
      if (!chrome.runtime.lastError && tab) void refreshTabIcon(tab.id, tab.url);
    });
  }
}
