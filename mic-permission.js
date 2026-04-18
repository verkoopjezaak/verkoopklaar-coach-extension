// mic-permission.js
// Dedicated tab-context om eenmalig microfoon-permissie te vragen.
// Popup werkt niet: Chrome sluit het popup-venster zodra het
// permissie-dialoog focus krijgt. Een gewone tab blijft open.

const statusEl = document.getElementById('status');
const retryBtn = document.getElementById('retry-btn');

async function requestMic() {
  statusEl.className = 'status pending';
  statusEl.textContent = 'Bezig met autoriseren...';
  retryBtn.style.display = 'none';

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    statusEl.className = 'status ok';
    statusEl.textContent = 'Gelukt. Deze tab sluit zo automatisch.';
    setTimeout(() => {
      window.close();
    }, 1500);
  } catch (err) {
    statusEl.className = 'status error';
    statusEl.textContent = `Autorisatie mislukt: ${err.message || err.name}. Open chrome://settings/content/microphone om handmatig toestemming te geven voor de extensie, en probeer opnieuw.`;
    retryBtn.style.display = 'inline-block';
  }
}

retryBtn.addEventListener('click', () => { void requestMic(); });

// Direct bij open proberen
void requestMic();
