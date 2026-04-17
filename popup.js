// popup.js
// Status-indicator popup voor de Verkoopklaar Coach extensie.

const statusText = document.getElementById('status-text');
const stopBtn = document.getElementById('stop-btn');

function renderStatus(status) {
  if (!status || status.state === 'idle') {
    statusText.textContent = 'Geen actieve sessie';
    statusText.className = 'idle';
    stopBtn.style.display = 'none';
    return;
  }

  if (status.state === 'active') {
    const label = status.meetingId
      ? `Sessie actief: ${status.meetingId}`
      : 'Sessie actief';
    statusText.textContent = label;
    statusText.className = 'active';
    stopBtn.style.display = 'block';
    return;
  }

  if (status.state === 'error') {
    statusText.textContent = `Fout: ${status.message || 'onbekend'}`;
    statusText.className = 'error';
    stopBtn.style.display = 'none';
    return;
  }
}

// Vraag status op bij service worker
chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
  if (chrome.runtime.lastError) {
    renderStatus({ state: 'error', message: chrome.runtime.lastError.message });
    return;
  }
  renderStatus(response);
});

// Stop-knop
stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP_SESSION' }, () => {
    renderStatus({ state: 'idle' });
    stopBtn.style.display = 'none';
  });
});
