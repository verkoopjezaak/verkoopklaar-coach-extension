// offscreen.js
// Offscreen document: audio-capture kern en WebSocket verbinding.
// Draait in een verborgen document context met toegang tot getUserMedia.
// Taak 6 + 7: dual-stream capture + WebSocket URL bepalen vanuit supabaseUrl.

let audioContext = null;
let micWorkletNode = null;
let tabWorkletNode = null;
let micStream = null;
let tabStream = null;
let ws = null;

// Diagnostische counters + interval. Module-scope zodat de periodieke broadcast
// (1.0.9) dezelfde waarden ziet als de worklet-message handlers.
let tabFrameCount = 0;
let micFrameCount = 0;
let diagnosticInterval = null;

// Reconnect bookkeeping (1.0.12). Audio-streams en AudioContext blijven in
// leven over reconnects heen - alleen de WS vervangen we. Zonder dit herstelde
// de extensie niet van transient WS drops en moest gebruiker handmatig opnieuw
// starten.
let reconnectAttempts = 0;
let reconnectTimer = null;
let stopRequested = false;
let lastSessionArgs = null; // { jwt, meetingId, supabaseUrl }
let lastCloseInfo = { code: null, reason: null, clean: null };
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BASE_DELAY_MS = 1000;

// Lees de worklet-code als string voor Blob URL (omzeilt CSP in offscreen context).
// Alternatief: verwijs naar worklet-processor.js via relatief pad.
// In offscreen document werkt chrome.runtime.getURL() voor extensie-resources.
const WORKLET_URL = chrome.runtime.getURL('worklet-processor.js');

// Bouwt de WebSocket URL op basis van de Supabase-project URL.
// Taak 7: WebSocket URL bepalen vanuit supabaseUrl.
function buildWsUrl(supabaseUrl, meetingId, jwt) {
  // Converteer https:// naar wss://
  const wsBase = supabaseUrl.replace(/^https?:\/\//, 'wss://');
  const params = new URLSearchParams({ meeting_id: meetingId, token: jwt });
  return `${wsBase}/functions/v1/coach-stream?${params.toString()}`;
}

// Open alleen de WebSocket (niet de audio-pipeline). Wordt gebruikt bij
// eerste start + bij reconnects zodat streams/worklets behouden blijven.
function openWebSocket({ jwt, meetingId, supabaseUrl }, isReconnect = false) {
  const wsUrl = buildWsUrl(supabaseUrl, meetingId, jwt);
  ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    console.log(`[coach-ext/offscreen] WebSocket verbonden${isReconnect ? ' (reconnect)' : ''}`);
    reconnectAttempts = 0;
    lastCloseInfo = { code: null, reason: null, clean: null };
  };

  ws.onerror = (err) => {
    console.error('[coach-ext/offscreen] WebSocket fout:', err);
  };

  ws.onclose = (ev) => {
    lastCloseInfo = { code: ev?.code ?? null, reason: ev?.reason ?? null, clean: ev?.wasClean ?? null };
    console.log(`[coach-ext/offscreen] WebSocket gesloten: code=${lastCloseInfo.code} reason=${lastCloseInfo.reason} clean=${lastCloseInfo.clean}`);
    chrome.runtime.sendMessage({
      type: 'WS_EVENT',
      payload: { type: 'closed', code: lastCloseInfo.code, reason: lastCloseInfo.reason, clean: lastCloseInfo.clean },
    }).catch(() => { /* ignore */ });

    // Reconnect-logica. Alleen doen als:
    // - gebruiker geen stop heeft aangevraagd
    // - de audio-pipeline nog leeft
    // - we nog pogingen over hebben
    if (stopRequested) return;
    if (!audioContext || !lastSessionArgs) return;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      chrome.runtime.sendMessage({
        type: 'WS_EVENT',
        payload: { type: 'error', code: 'reconnect_failed', message: `Reconnect mislukt na ${MAX_RECONNECT_ATTEMPTS} pogingen (code=${lastCloseInfo.code})` },
      }).catch(() => { /* ignore */ });
      // Ook audio-pipeline volledig afsluiten zodat tabCapture vrij komt en
      // de volgende start-poging niet op "Cannot capture a tab with an active
      // stream" loopt.
      void stopAudio();
      return;
    }
    reconnectAttempts += 1;
    const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempts - 1); // 1s, 2s, 4s
    console.log(`[coach-ext/offscreen] Reconnect poging ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} over ${delay}ms`);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (stopRequested) return;
      openWebSocket(lastSessionArgs, true);
    }, delay);
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    try {
      const parsed = JSON.parse(ev.data);
      chrome.runtime.sendMessage({ type: 'WS_EVENT', payload: parsed }).catch(() => { /* ignore */ });
    } catch { /* negeer niet-JSON frames */ }
  };
}

async function startAudio({ streamId, jwt, meetingId, supabaseUrl }) {
  // 1. Tab-audio ophalen via chromeMediaSource.
  // BELANGRIJK: Chrome vereist voor tabCapture in offscreen documents dat je
  // zowel audio als video constraints opgeeft, anders komt er geen data
  // binnen. De video-track stoppen we direct omdat we hem niet nodig hebben.
  // Zie: https://developer.chrome.com/docs/extensions/reference/api/tabCapture
  tabStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
  });
  // Video-track NIET stoppen: Chrome's tabCapture silence-t de audio-flow als
  // we direct .stop() aanroepen op de video-track. Disable + detach volstaat
  // om geen CPU te verspillen aan video-rendering zonder de audio stroom te
  // onderbreken (bevestigd via 1.0.9 diagnostic: met .stop() slechts 1.5
  // frames/sec i.p.v. de verwachte 10).
  tabStream.getVideoTracks().forEach((t) => { t.enabled = false; });
  console.log('[coach-ext/offscreen] tabStream audio tracks:', tabStream.getAudioTracks().length);

  // 2. Microfoon-audio ophalen. In offscreen document vereist dit dat de
  // microfoon-permissie al eerder is goedgekeurd voor de extensie (via popup
  // gesture of chrome://settings). Bij fout blijven we door op alleen tab.
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    console.log('[coach-ext/offscreen] micStream audio tracks:', micStream.getAudioTracks().length);
  } catch (err) {
    console.warn('[coach-ext/offscreen] Microfoon niet beschikbaar:', err.message);
    chrome.runtime.sendMessage({
      type: 'WS_EVENT',
      payload: { type: 'error', code: 'mic_denied', message: `Microfoon niet beschikbaar: ${err.message}` },
    }).catch(() => { /* ignore */ });
    micStream = null;
  }

  // 3. AudioContext aanmaken
  audioContext = new AudioContext({ sampleRate: 48000 });
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  // 4. AudioWorklet laden via extensie-URL (geen remote code vereist)
  await audioContext.audioWorklet.addModule(WORKLET_URL);

  // 5. WebSocket openen via herbruikbare helper (zie openWebSocket boven).
  stopRequested = false;
  reconnectAttempts = 0;
  lastSessionArgs = { jwt, meetingId, supabaseUrl };
  openWebSocket(lastSessionArgs, false);

  // 6. Tab-audio worklet (source 0x02).
  // BELANGRIJK: naast de worklet moet de source ook naar audioContext.destination
  // worden geconnect, anders mute Chrome de tab-audio voor de gebruiker EN
  // stopt de capture-flow. Dit zorgt dat Maarten de klant hoort én dat de
  // audio-stream actief blijft.
  const tabAudioTracks = tabStream.getAudioTracks();
  if (tabAudioTracks.length > 0) {
    tabWorkletNode = new AudioWorkletNode(audioContext, 'coach-pcm-worklet-labeled', {
      processorOptions: { sourceLabel: 0x02 },
    });
    tabWorkletNode.port.onmessage = (ev) => {
      if (ev.data && ev.data.buffer instanceof ArrayBuffer && ws?.readyState === WebSocket.OPEN) {
        const frame = buildMultiplexFrame(ev.data.source, ev.data.buffer);
        ws.send(frame);
        tabFrameCount++;
        if (tabFrameCount === 10 || tabFrameCount === 100) {
          console.log(`[coach-ext/offscreen] tab frames verzonden: ${tabFrameCount}`);
        }
      }
    };
    const tabSource = audioContext.createMediaStreamSource(tabStream);
    tabSource.connect(tabWorkletNode);
    tabSource.connect(audioContext.destination); // houd afspelen actief
  } else {
    console.warn('[coach-ext/offscreen] tabStream heeft GEEN audio tracks');
  }

  // 7. Mic-audio worklet (source 0x01), indien beschikbaar
  if (micStream) {
    const micAudioTracks = micStream.getAudioTracks();
    if (micAudioTracks.length > 0) {
      micWorkletNode = new AudioWorkletNode(audioContext, 'coach-pcm-worklet-labeled', {
        processorOptions: { sourceLabel: 0x01 },
      });
      micWorkletNode.port.onmessage = (ev) => {
        if (ev.data && ev.data.buffer instanceof ArrayBuffer && ws?.readyState === WebSocket.OPEN) {
          const frame = buildMultiplexFrame(ev.data.source, ev.data.buffer);
          ws.send(frame);
          micFrameCount++;
          if (micFrameCount === 10 || micFrameCount === 100) {
            console.log(`[coach-ext/offscreen] mic frames verzonden: ${micFrameCount}`);
          }
        }
      };
      const micSource = audioContext.createMediaStreamSource(micStream);
      micSource.connect(micWorkletNode);
      // Mic NIET naar destination connecten - anders krijgt Maarten zijn eigen
      // stem terug via de luidspreker (echo).
    }
  }

  console.log('[coach-ext/offscreen] Audio-capture gestart');

  // 8. Diagnostische broadcast (1.0.9). Elke 2s sturen we de actuele state
  // door naar de service worker, die het weer via WS_EVENT → content-script
  // → webapp relayt. Hiermee zien we zonder DevTools of tabCapture audio-tracks
  // levert, of de AudioContext draait, of ws open is, en of frames toenemen.
  if (diagnosticInterval) clearInterval(diagnosticInterval);
  diagnosticInterval = setInterval(() => {
    const payload = {
      type: 'ext_diagnostic',
      audioContextState: audioContext?.state ?? 'none',
      tabAudioTracks: tabStream?.getAudioTracks().length ?? 0,
      micAudioTracks: micStream?.getAudioTracks().length ?? 0,
      tabFrameCount,
      micFrameCount,
      wsReadyState: ws?.readyState ?? -1,
      reconnectAttempts,
      lastCloseCode: lastCloseInfo.code,
      lastCloseReason: lastCloseInfo.reason,
      timestamp: Date.now(),
    };
    chrome.runtime.sendMessage({ type: 'WS_EVENT', payload }).catch(() => { /* ignore */ });
  }, 2000);
}

// Bouwt multiplexed binary frame: 1-byte source-header + PCM16 data.
// Zelfde formaat als useLiveCoach.ts in de web-app.
function buildMultiplexFrame(source, pcm16Buffer) {
  const frame = new Uint8Array(1 + pcm16Buffer.byteLength);
  frame[0] = source; // 0x01 = mic, 0x02 = tab
  frame.set(new Uint8Array(pcm16Buffer), 1);
  return frame.buffer;
}

async function stopAudio() {
  stopRequested = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  lastSessionArgs = null;
  reconnectAttempts = 0;

  // Stop diagnostic broadcast.
  if (diagnosticInterval) {
    clearInterval(diagnosticInterval);
    diagnosticInterval = null;
  }
  tabFrameCount = 0;
  micFrameCount = 0;

  // Stop worklets
  try { micWorkletNode?.disconnect(); } catch { /* ignore */ }
  try { tabWorkletNode?.disconnect(); } catch { /* ignore */ }
  micWorkletNode = null;
  tabWorkletNode = null;

  // Stop streams
  micStream?.getTracks().forEach((t) => t.stop());
  tabStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
  tabStream = null;

  // Sluit AudioContext
  try { await audioContext?.close(); } catch { /* ignore */ }
  audioContext = null;

  // Sluit WebSocket
  try {
    ws?.send(JSON.stringify({ type: 'stop' }));
    ws?.close();
  } catch { /* ignore */ }
  ws = null;

  console.log('[coach-ext/offscreen] Audio-capture gestopt');
}

// Luister op berichten van de service worker
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'START_AUDIO') {
    const { streamId, jwt, meetingId, supabaseUrl } = message;
    startAudio({ streamId, jwt, meetingId, supabaseUrl })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error('[coach-ext/offscreen] START_AUDIO fout:', err);
        sendResponse({ ok: false, error: err.message });
      });
    return true; // asynchrone response
  }

  if (message.type === 'STOP_AUDIO') {
    stopAudio()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error('[coach-ext/offscreen] STOP_AUDIO fout:', err);
        sendResponse({ ok: false, error: err.message });
      });
    return true; // asynchrone response
  }

  return false;
});
