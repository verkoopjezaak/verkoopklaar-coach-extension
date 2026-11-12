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

// ---- Pending start na ontbrekende activeTab-invocatie ----------------------
// Chrome staat chrome.tabCapture.getMediaStreamId({targetTabId}) alleen toe op
// een tab waarvoor de extensie zelf is "aangeroepen" (icoon-klik, sneltoets of
// contextmenu) - een klik op een knop OP DE WEBPAGINA telt daar niet voor mee,
// ook al heeft de extensie host_permissions voor die pagina. Start de coach
// dus rechtstreeks vanaf de web-app (het normale pad, via content-script.js)
// zonder dat het extensie-icoon ooit is aangeklikt, dan weigert Chrome met
// "Extension has not been invoked for the current page (see activeTab
// permission)." Bewaar die mislukte poging hier zodat het enkel OPENEN van de
// popup (dat wél als invocatie telt en meteen activeTab verleent) 'm alsnog
// automatisch hervat, zonder dat de gebruiker nogmaals iets hoeft te starten.
const ACTIVE_TAB_REQUIRED_RE = /activeTab|has not been invoked/i;
async function getPendingStart(tabId) {
  if (tabId == null) return null;
  const { pendingStarts } = await chrome.storage.session.get('pendingStarts');
  return (pendingStarts ?? {})[tabId] ?? null;
}
async function setPendingStart(tabId, payload) {
  if (tabId == null) return;
  const { pendingStarts } = await chrome.storage.session.get('pendingStarts');
  const map = pendingStarts ?? {};
  if (payload) map[tabId] = payload;
  else delete map[tabId];
  await chrome.storage.session.set({ pendingStarts: map });
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
const MEETING_URL_RE = /^https:\/\/(preview|app)\.verkoopjezaak\.nl\/client\/[^/]+\/(meetings\/(?!new(?:[/?#]|$))[^/?#]+|lead-meeting\/[^/]+\/advisor-join)/;

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
// Content-script injecteren op een tab die (na SPA-navigatie) op een meeting-
// pagina staat. Manifest-content_scripts draaien alleen bij een volledige
// paginalaad; navigeert de web-app van dashboard naar advisor-join zonder
// herlaad, dan zou er anders nooit een content-script komen en blijft de popup
// op "Wacht op meeting-context..." hangen. Het script heeft een eigen
// injectie-guard, dus dubbel injecteren is onschadelijk.
async function ensureContentScript(tabId, url) {
  if (!urlIsMeetingPage(url)) return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-script.js'],
    });
    return true;
  } catch (err) {
    console.warn('[coach-ext/bg] content-script injecteren mislukt:', err?.message ?? err);
    return false;
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' || changeInfo.url) {
    void refreshTabIcon(tabId, tab.url);
  }
  // changeInfo.url komt ook bij history.pushState (SPA-routewissel).
  if (changeInfo.url) {
    if (urlIsMeetingPage(changeInfo.url)) {
      void ensureContentScript(tabId, changeInfo.url);
    } else {
      // Weg van de meetingpagina: oude context weggooien, anders toont de
      // popup straks een verouderde meeting als "ontvangen".
      void deleteTabContext(tabId);
    }
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
  void setPendingStart(tabId, null);
});

// ---- Message-router --------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Mic-device-voorkeur (1.0.26). Jitsi-label komt via content-script; de
  // handmatige override komt uit de popup (chrome.storage.local). Offscreen
  // kan chrome.storage niet lezen en vraagt het hier op (GET_MIC_DEVICE).
  if (message.type === 'SET_MIC_DEVICE') {
    (async () => {
      await chrome.storage.session.set({
        micDevice: { label: message.label ?? null, deviceId: message.deviceId ?? null },
      });
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (message.type === 'GET_MIC_DEVICE') {
    (async () => {
      const { micDevice } = await chrome.storage.session.get('micDevice');
      const { micOverrideLabel } = await chrome.storage.local.get('micOverrideLabel');
      sendResponse({
        jitsiLabel: micDevice?.label ?? null,
        overrideLabel: typeof micOverrideLabel === 'string' && micOverrideLabel ? micOverrideLabel : null,
      });
    })();
    return true;
  }

  if (message.type === 'SET_CONTEXT') {
    (async () => {
      const tabId = sender.tab?.id;
      if (tabId != null) {
        // Oude foutstand (bv. reconnect_failed) mag een nieuwe meeting niet blokkeren.
        const cur = await getSessionState();
        if (cur.state === 'error') await setSessionState({ ...DEFAULT_SESSION_STATE });
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

  // Popup vraagt om (verse) meeting-context voor een tab: zorg dat het
  // content-script er is en laat dat de pagina om een context-publish vragen.
  if (message.type === 'REQUEST_CONTEXT') {
    (async () => {
      const tabId = message.tabId;
      if (tabId == null) { sendResponse({ ok: false, error: 'tabId ontbreekt' }); return; }
      let url = null;
      try { url = (await chrome.tabs.get(tabId))?.url ?? null; } catch { /* tab weg */ }
      if (!urlIsMeetingPage(url)) { sendResponse({ ok: false, error: 'geen meetingpagina' }); return; }
      const injected = await ensureContentScript(tabId, url);
      let reply = null;
      try {
        reply = await chrome.tabs.sendMessage(tabId, { type: 'REQUEST_CONTEXT' });
      } catch (err) {
        sendResponse({ ok: false, injected, error: err?.message ?? String(err) });
        return;
      }
      sendResponse({ ok: true, injected, handshake: reply?.handshake ?? null });
    })();
    return true;
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

  if (message.type === 'CONFERENCE_END') {
    handleConferenceEnd()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error('[coach-ext] CONFERENCE_END fout:', err);
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  // Popup is zojuist geopend (= een echte extensie-invocatie, verleent
  // activeTab voor de huidige tab). Was er een eerdere Start-poging vanaf de
  // webpagina die daarop wachtte, hervat die nu vanzelf.
  if (message.type === 'RESUME_PENDING_START') {
    (async () => {
      const tabId = message.tabId;
      const pending = await getPendingStart(tabId);
      if (!pending) { sendResponse({ ok: true, resumed: false }); return; }
      try {
        await handleStartSession({ ...pending, tabIdHint: tabId });
        await setPendingStart(tabId, null);
        // Buiten de normale ACK-flow van content-script.js om (deze hervatting
        // liep niet via COACH_EXT_REQUEST_TOKEN): meld de pagina rechtstreeks
        // dat de sessie alsnog gestart is.
        chrome.tabs.sendMessage(tabId, { type: 'COACH_EXT_RESUMED' }).catch(() => { /* content-script kan weg zijn */ });
        sendResponse({ ok: true, resumed: true });
      } catch (err) {
        console.error('[coach-ext] RESUME_PENDING_START fout:', err);
        sendResponse({ ok: false, resumed: true, error: err.message });
      }
    })();
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

async function handleStartSession({ coachToken, meetingId, supabaseUrl, nonce, tabIdHint }) {
  await setSessionState({ state: 'idle', meetingId, tabId: null, message: null });

  // Teardown van eventuele oude offscreen-context zodat een nieuwe tabCapture
  // op dezelfde tab niet faalt met "Cannot capture a tab with an active stream".
  stopKeepAlive();
  try {
    await chrome.runtime.sendMessage({ type: 'STOP_AUDIO' });
  } catch { /* offscreen bestond niet, prima */ }
  await closeOffscreenDocument().catch(() => { /* ignore */ });

  let activeTab = null;
  if (tabIdHint != null) {
    try { activeTab = await chrome.tabs.get(tabIdHint); } catch { activeTab = null; }
  }
  if (!activeTab) {
    [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  if (!activeTab?.id) {
    throw new Error('Geen actieve tab gevonden');
  }

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: activeTab.id,
    });
  } catch (err) {
    const msg = err?.message || String(err);
    if (ACTIVE_TAB_REQUIRED_RE.test(msg)) {
      await setPendingStart(activeTab.id, { coachToken, meetingId, supabaseUrl, nonce });
      throw new Error(
        'ACTIVE_TAB_REQUIRED: Klik eenmalig op het Verkoopklaar Coach-icoon in de werkbalk. '
        + 'De coach start dan automatisch, deze knop hoeft daarna niet nogmaals.',
      );
    }
    throw err;
  }
  if (!streamId) {
    throw new Error('tabCapture.getMediaStreamId leverde geen stream-ID op');
  }
  await setPendingStart(activeTab.id, null);

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
  await setPendingStart(endedTabId, null);
  if (endedTabId) {
    chrome.tabs.get(endedTabId, (tab) => {
      if (!chrome.runtime.lastError && tab) void refreshTabIcon(tab.id, tab.url);
    });
  }
}

async function handleConferenceEnd() {
  // Videoconferentie beëindigd: laat offscreen eerst het videoConferenceLeft-
  // signaal over de coach-WS sturen (server sluit dan streams + sessie), en ruim
  // daarna dezelfde staat op als bij een gewone stop. CONFERENCE_END_AUDIO stopt
  // de audio zelf, dus geen aparte STOP_AUDIO nodig.
  stopKeepAlive();
  try {
    await chrome.runtime.sendMessage({ type: 'CONFERENCE_END_AUDIO' });
  } catch {
    // Offscreen document al gesloten of nooit gestart — geen probleem.
  }
  await closeOffscreenDocument().catch(() => { /* ignore */ });
  const cur = await getSessionState();
  const endedTabId = cur.tabId;
  await setSessionState({ ...DEFAULT_SESSION_STATE });
  // Ook een eventuele bewaarde (nog niet hervatte) activeTab-poging voor deze
  // tab opruimen: het gesprek is voorbij, een latere popup-open mag 'm niet
  // meer alsnog starten met een inmiddels verlopen coachToken.
  await setPendingStart(endedTabId, null);
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
  await setPendingStart(endedTabId, null);
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
