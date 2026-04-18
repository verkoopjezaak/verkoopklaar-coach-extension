// popup.js
// Status + start/stop knoppen voor de Verkoopklaar Coach extensie.
// De popup is de primaire trigger: een klik hier telt als extension-invocation
// waarmee activeTab permissies geldig worden voor chrome.tabCapture.

const statusEl = document.getElementById('status-text');
const statusLabel = document.getElementById('status-label-text');
const hintEl = document.getElementById('hint');
const startBtn = document.getElementById('start-btn');
const micBtn = document.getElementById('mic-btn');
const stopBtn = document.getElementById('stop-btn');
const versionEl = document.getElementById('version');

const MEETING_URL_RE = /^https:\/\/(preview|app)\.verkoopjezaak\.nl\/client\/[^/]+\/meetings\/[^/]+\/join/;

let currentTab = null;
let currentContext = null; // { jwt, meetingId, supabaseUrl }

function setClass(name) {
  statusEl.className = name;
}

function render({ sessionState, onMeetingTab, hasContext, micPermission }) {
  startBtn.style.display = 'none';
  stopBtn.style.display = 'none';
  micBtn.style.display = 'none';

  // Toon 'Microfoon autoriseren' knop zolang permissie niet expliciet granted is.
  // 'prompt' betekent nog niet beslist, 'denied' expliciet geweigerd - in beide
  // gevallen moet gebruiker hem via de dedicated tab autoriseren.
  if (micPermission !== 'granted') {
    micBtn.style.display = 'block';
  }

  if (sessionState.state === 'active') {
    statusLabel.textContent = 'Sessie actief, aan het opnemen';
    hintEl.textContent = sessionState.meetingId ? `Meeting: ${sessionState.meetingId.slice(0, 8)}` : '';
    setClass('active');
    stopBtn.style.display = 'block';
    return;
  }
  if (sessionState.state === 'error') {
    statusLabel.textContent = 'Fout';
    hintEl.textContent = sessionState.message || 'Onbekende fout';
    setClass('error');
    if (onMeetingTab && hasContext) startBtn.style.display = 'block';
    return;
  }
  if (!onMeetingTab) {
    statusLabel.textContent = 'Niet op een Verkoopklaar meeting';
    hintEl.textContent = 'Open een /meetings/*/join pagina.';
    setClass('default');
    return;
  }
  if (!hasContext) {
    statusLabel.textContent = 'Wacht op meeting-context';
    hintEl.textContent = 'Herlaad de pagina als dit blijft staan.';
    setClass('default');
    return;
  }
  statusLabel.textContent = 'Klaar om te starten';
  hintEl.textContent = 'Klik "Coach starten" om audio op te nemen.';
  setClass('ready');
  startBtn.style.display = 'block';
}

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  const onMeetingTab = MEETING_URL_RE.test(tab?.url || '');

  const sessionState = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
      resolve(response ?? { state: 'idle' });
    });
  });

  currentContext = null;
  if (tab?.id) {
    currentContext = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'GET_CONTEXT', tabId: tab.id }, (response) => {
        resolve(response?.context ?? null);
      });
    });
  }

  // Check mic-permission voor de extensie-origin. Permissions API geeft
  // 'granted' / 'prompt' / 'denied' terug per origin. Als nog nooit granted,
  // moet gebruiker via de dedicated permissie-tab.
  let micPermission = 'prompt';
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    micPermission = status.state;
  } catch { /* fallback: treat as not granted */ }

  render({ sessionState, onMeetingTab, hasContext: !!currentContext, micPermission });
}

startBtn.addEventListener('click', async () => {
  if (!currentContext || !currentTab?.id) return;
  startBtn.disabled = true;
  statusLabel.textContent = 'Starten...';
  hintEl.textContent = '';

  // Geen mic-probe meer in popup: het popup-venster sluit zodra het Chrome
  // toestemmings-dialoog focus krijgt, waardoor getUserMedia direct cancelt
  // (false-negative "microfoon geweigerd"). Permissie wordt nu via de
  // dedicated mic-permission.html tab geregeld (mic-btn hieronder).

  chrome.runtime.sendMessage(
    {
      type: 'START_SESSION',
      jwt: currentContext.jwt,
      meetingId: currentContext.meetingId,
      supabaseUrl: currentContext.supabaseUrl,
      initiatorTabId: currentTab.id,
    },
    (response) => {
      startBtn.disabled = false;
      if (response?.ok) {
        refresh();
      } else {
        statusLabel.textContent = 'Start mislukt';
        hintEl.textContent = response?.error || 'Onbekende fout';
        setClass('error');
      }
    }
  );
});

micBtn.addEventListener('click', () => {
  // Open permissie-pagina als volwaardige tab. Alleen een echte browser-tab
  // blijft open tijdens Chrome's toestemmings-dialoog (popup of window-type
  // sluiten bij focus-verlies, waardoor getUserMedia silent cancelt).
  chrome.tabs.create({ url: chrome.runtime.getURL('mic-permission.html') });
});

stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP_SESSION' }, () => {
    refresh();
  });
});

const manifest = chrome.runtime.getManifest();
versionEl.textContent = `v${manifest.version}`;

refresh();
