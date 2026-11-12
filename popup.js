// popup.js
// Checkpoints-georiënteerde UI: tab OK? meeting-context? mic toestemming?
// Start is pas klikbaar als alle drie groen zijn. Reset-knop voor panic-undo.

const checkTab = document.getElementById('check-tab');
const textTab = document.getElementById('text-tab');
const checkContext = document.getElementById('check-context');
const textContext = document.getElementById('text-context');
const checkMic = document.getElementById('check-mic');
const textMic = document.getElementById('text-mic');
const currentStateEl = document.getElementById('current-state');
const hintEl = document.getElementById('hint');

const startBtn = document.getElementById('start-btn');
const micBtn = document.getElementById('mic-btn');
const stopBtn = document.getElementById('stop-btn');
const resetBtn = document.getElementById('reset-btn');
const resetNote = document.getElementById('reset-note');
const versionEl = document.getElementById('version');

const MEETING_URL_RE = /^https:\/\/(preview|app)\.verkoopjezaak\.nl\/client\/[^/]+\/(meetings\/(?!new(?:[/?#]|$))[^/?#]+|lead-meeting\/[^/]+\/advisor-join)/;

let currentTab = null;
let currentContext = null;

function setCheck(el, state, ok, pending, error) {
  el.classList.remove('ok', 'pending', 'missing', 'error');
  if (state === 'ok') { el.classList.add('ok'); el.textContent = '✓'; }
  else if (state === 'pending') { el.classList.add('pending'); el.textContent = '…'; }
  else if (state === 'error') { el.classList.add('error'); el.textContent = '✗'; }
  else { el.classList.add('missing'); el.textContent = '·'; }
}

function render({ sessionState, onMeetingTab, hasContext, micPermission }) {
  startBtn.style.display = 'none';
  stopBtn.style.display = 'none';
  micBtn.style.display = 'none';
  resetBtn.style.display = 'none';
  resetNote.style.display = 'none';

  // Checkpoint 1: zit gebruiker op een meeting-join pagina?
  setCheck(checkTab, onMeetingTab ? 'ok' : 'missing');
  textTab.textContent = onMeetingTab ? 'Op meeting-pagina' : 'Open een meeting-pagina';

  // Checkpoint 2: heeft de webapp een gescopeerde coach-token + meetingId gepusht?
  if (!onMeetingTab) {
    setCheck(checkContext, 'missing');
    textContext.textContent = 'Meeting-context (wacht op pagina)';
  } else if (hasContext) {
    setCheck(checkContext, 'ok');
    textContext.textContent = 'Meeting-context ontvangen';
  } else {
    setCheck(checkContext, 'pending');
    textContext.textContent = 'Wacht op meeting-context...';
  }

  // Checkpoint 3: microfoon geautoriseerd?
  if (micPermission === 'granted') {
    setCheck(checkMic, 'ok');
    textMic.textContent = 'Microfoon geautoriseerd';
  } else if (micPermission === 'denied') {
    setCheck(checkMic, 'error');
    textMic.textContent = 'Microfoon geweigerd (klik om opnieuw)';
  } else {
    setCheck(checkMic, 'missing');
    textMic.textContent = 'Microfoon autoriseren';
  }

  // Actieve sessie
  if (sessionState.state === 'active') {
    currentStateEl.className = 'active';
    currentStateEl.textContent = '● Sessie actief, aan het opnemen';
    hintEl.textContent = '';
    stopBtn.style.display = 'block';
    resetBtn.style.display = 'block';
    resetNote.style.display = 'block';
    return;
  }

  // Foutstaat
  if (sessionState.state === 'error') {
    currentStateEl.className = 'error';
    currentStateEl.textContent = '● Fout: ' + (sessionState.message || 'onbekend');
    hintEl.textContent = 'Klik Reset om de extensie-staat op te ruimen en opnieuw te proberen.';
    resetBtn.style.display = 'block';
    resetNote.style.display = 'block';
    return;
  }

  // Idle: toon juiste knop op basis van vereisten
  currentStateEl.className = '';
  currentStateEl.textContent = 'Niet actief';

  if (micPermission !== 'granted') {
    micBtn.style.display = 'block';
    hintEl.textContent = 'Autoriseer eerst de microfoon. Daarna kun je de coach starten.';
    return;
  }

  if (!onMeetingTab) {
    hintEl.textContent = 'Open een Verkoopklaar meeting (/meetings/*/join).';
    return;
  }

  if (!hasContext) {
    hintEl.textContent = 'Herlaad de meeting-pagina als dit blijft staan.';
    return;
  }

  // Alles groen: start klikbaar
  startBtn.style.display = 'block';
  startBtn.disabled = false;
  hintEl.textContent = 'Alles klaar. Klik "Coach starten".';
}

// Max één REQUEST_CONTEXT per 2 s (de refresh-tik), zodat we de pagina niet
// bestoken zolang de context nog onderweg is.
let lastContextRequestAt = 0;
function requestContext(tabId) {
  const now = Date.now();
  if (now - lastContextRequestAt < 1900) return;
  lastContextRequestAt = now;
  chrome.runtime.sendMessage({ type: 'REQUEST_CONTEXT', tabId }, () => {
    if (chrome.runtime.lastError) { /* tab of content-script weg: volgende tik opnieuw */ }
  });
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
    // Geen context terwijl we wél op een meetingpagina staan: actief opvragen
    // (request/response) in plaats van alleen wachten. Background zorgt dat
    // het content-script aanwezig is (SPA-navigatie) en vraagt de pagina om
    // een verse publish; de volgende refresh-tik pikt de context dan op.
    if (!currentContext && onMeetingTab && sessionState.state !== 'active') {
      requestContext(tab.id);
    }
  }

  let micPermission = 'prompt';
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    micPermission = status.state;
  } catch { /* fallback: niet gegrant */ }

  render({ sessionState, onMeetingTab, hasContext: !!currentContext, micPermission });
}

startBtn.addEventListener('click', () => {
  if (!currentContext || !currentTab?.id) return;
  startBtn.disabled = true;
  currentStateEl.textContent = 'Starten...';
  hintEl.textContent = '';

  chrome.runtime.sendMessage(
    {
      type: 'START_SESSION',
      coachToken: currentContext.coachToken,
      meetingId: currentContext.meetingId,
      supabaseUrl: currentContext.supabaseUrl,
      nonce: currentContext.nonce,
      initiatorTabId: currentTab.id,
    },
    (response) => {
      startBtn.disabled = false;
      if (response?.ok) {
        refresh();
      } else {
        currentStateEl.className = 'error';
        currentStateEl.textContent = '● Start mislukt';
        hintEl.textContent = response?.error || 'Onbekende fout. Probeer Reset.';
      }
    }
  );
});

// Handmatige mic-override (1.0.26): label in chrome.storage.local; leeg =
// automatisch (volgt het Jitsi-mic-label). Offscreen krijgt MIC_OVERRIDE_CHANGED
// en her-acquireert direct als er een sessie loopt.
const micSelect = document.getElementById('mic-select');
async function fillMicSelect() {
  if (!micSelect) return;
  let inputs = [];
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    inputs = all.filter((d) => d.kind === 'audioinput' && d.label);
  } catch { /* geen permissie: alleen "Automatisch" */ }
  const { micOverrideLabel } = await chrome.storage.local.get('micOverrideLabel');
  while (micSelect.options.length > 1) micSelect.remove(1);
  for (const d of inputs) {
    const opt = document.createElement('option');
    opt.value = d.label;
    opt.textContent = d.label;
    micSelect.appendChild(opt);
  }
  micSelect.value = typeof micOverrideLabel === 'string' ? micOverrideLabel : '';
  if (micSelect.value !== (micOverrideLabel || '')) micSelect.value = '';
}
micSelect?.addEventListener('change', async () => {
  const label = micSelect.value || null;
  await chrome.storage.local.set({ micOverrideLabel: label ?? '' });
  chrome.runtime.sendMessage({ type: 'MIC_OVERRIDE_CHANGED', label }).catch(() => { /* geen offscreen */ });
});
void fillMicSelect();

micBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('mic-permission.html') });
});

stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP_SESSION' }, () => {
    refresh();
  });
});

resetBtn.addEventListener('click', () => {
  currentStateEl.textContent = 'Resetten...';
  hintEl.textContent = '';
  chrome.runtime.sendMessage({ type: 'RESET_SESSION' }, () => {
    refresh();
  });
});

const manifest = chrome.runtime.getManifest();
versionEl.textContent = `v${manifest.version}`;

// Het openen van dit popup IS een extensie-invocatie (Chrome verleent daarmee
// activeTab voor de huidige tab). Was er een Start-poging vanaf de webpagina
// die daarop wachtte (COACH_EXT_ERROR: 'ACTIVE_TAB_REQUIRED...'), hervat die nu
// automatisch: de gebruiker hoeft alleen dit icoon te openen, niet ook nog
// zelf een knop in te drukken.
(async function resumePendingStart() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  chrome.runtime.sendMessage({ type: 'RESUME_PENDING_START', tabId: tab.id }, () => {
    if (chrome.runtime.lastError) { /* geen pending start: niets te doen */ }
  });
})();

refresh();
// Repoll every 2s zodat context-updates of state-changes vanzelf doorkomen
// zonder dat gebruiker de popup moet sluiten/openen.
setInterval(refresh, 2000);
