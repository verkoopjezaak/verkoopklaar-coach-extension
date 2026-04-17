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
  // Video direct stoppen - we hebben hem alleen nodig om de audio te laten flow'en.
  tabStream.getVideoTracks().forEach((t) => t.stop());
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

  // 5. WebSocket openen
  const wsUrl = buildWsUrl(supabaseUrl, meetingId, jwt);
  ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    console.log('[coach-ext/offscreen] WebSocket verbonden');
  };

  ws.onerror = (err) => {
    console.error('[coach-ext/offscreen] WebSocket fout:', err);
  };

  ws.onclose = () => {
    console.log('[coach-ext/offscreen] WebSocket gesloten');
    chrome.runtime.sendMessage({ type: 'WS_EVENT', payload: { type: 'closed' } }).catch(() => { /* ignore */ });
  };

  // Forward coach-stream berichten (utterance/interim/session_started/error/ended)
  // naar de service worker zodat die ze kan relayen naar de webapp.
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    try {
      const parsed = JSON.parse(ev.data);
      chrome.runtime.sendMessage({ type: 'WS_EVENT', payload: parsed }).catch(() => { /* ignore */ });
    } catch { /* negeer niet-JSON frames */ }
  };

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
    let tabFrameCount = 0;
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
      let micFrameCount = 0;
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
