// popup.js
// Status + start/stop knoppen voor de Verkoopklaar Coach extensie.
// De popup is de primaire trigger: een klik hier telt als extension-invocation
// waarmee activeTab permissies geldig worden voor chrome.tabCapture.

const statusEl = document.getElementById('status-text');
const statusLabel = document.getElementById('status-label-text');
const hintEl = document.getElementById('hint');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const versionEl = document.getElementById('version');

const MEETING_URL_RE = /^https:\/\/(preview|app)\.verkoopjezaak\.nl\/client\/[^/]+\/meetings\/[^/]+\/join/;

let currentTab = null;
let currentContext = null; // { jwt, meetingId, supabaseUrl }

function setClass(name) {
  statusEl.className = name;
}

function render({ sessionState, onMeetingTab, hasContext }) {
  startBtn.style.display = 'none';
  stopBtn.style.display = 'none';

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

  render({ sessionState, onMeetingTab, hasContext: !!currentContext });
}

startBtn.addEventListener('click', async () => {
  if (!currentContext || !currentTab?.id) return;
  startBtn.disabled = true;
  statusLabel.textContent = 'Starten...';
  hintEl.textContent = '';

  // Mic-permissie afdwingen vanuit user-gesture context (popup klik).
  // Offscreen document kan silent falen op getUserMedia als de permissie niet
  // eerder expliciet is gevraagd. Door de prompt hier te triggeren wordt hij
  // eenmalig gegrant voor de extensie-origin en erft offscreen hem daarna.
  try {
    const micProbe = await navigator.mediaDevices.getUserMedia({ audio: true });
    micProbe.getTracks().forEach((t) => t.stop());
  } catch (err) {
    startBtn.disabled = false;
    statusLabel.textContent = 'Microfoon geweigerd';
    hintEl.textContent = 'Sta microfoon toe via het Chrome-icoontje links in de adresbalk.';
    setClass('error');
    return;
  }

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

stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP_SESSION' }, () => {
    refresh();
  });
});

const manifest = chrome.runtime.getManifest();
versionEl.textContent = `v${manifest.version}`;

refresh();
