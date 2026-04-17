// popup.js
// Status-indicator popup voor de Verkoopklaar Coach extensie.

const statusEl = document.getElementById('status-text');
const statusLabel = document.getElementById('status-label-text');
const hintEl = document.getElementById('hint');
const stopBtn = document.getElementById('stop-btn');

const MEETING_URL_RE = /^https:\/\/(preview|app)\.verkoopjezaak\.nl\/client\/[^/]+\/meetings\/[^/]+\/join/;

function setClass(name) {
  statusEl.className = name;
}

function render({ sessionState, onMeetingTab }) {
  if (sessionState.state === 'active') {
    statusLabel.textContent = 'Sessie actief - aan het opnemen';
    hintEl.textContent = sessionState.meetingId ? `Meeting: ${sessionState.meetingId.slice(0, 8)}` : '';
    setClass('active');
    stopBtn.style.display = 'block';
    return;
  }
  if (sessionState.state === 'error') {
    statusLabel.textContent = 'Fout';
    hintEl.textContent = sessionState.message || 'Onbekende fout';
    setClass('error');
    stopBtn.style.display = 'none';
    return;
  }
  if (onMeetingTab) {
    statusLabel.textContent = 'Verbonden, klaar om te starten';
    hintEl.textContent = 'Klik "Coach starten" in het panel rechts.';
    setClass('ready');
  } else {
    statusLabel.textContent = 'Niet op een Verkoopklaar meeting';
    hintEl.textContent = 'Open een /meetings/*/join pagina.';
    setClass('default');
  }
  stopBtn.style.display = 'none';
}

(async () => {
  // Vraag sessie-status op en bepaal of huidige tab een meeting-pagina is.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onMeetingTab = MEETING_URL_RE.test(tab?.url || '');

  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
    const sessionState = response ?? { state: 'idle' };
    render({ sessionState, onMeetingTab });
  });
})();

stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP_SESSION' }, () => {
    render({ sessionState: { state: 'idle' }, onMeetingTab: false });
  });
});
