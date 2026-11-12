// offscreen.js
// Offscreen document: audio-capture kern en WebSocket verbinding.
// Draait in een verborgen document context met toegang tot getUserMedia.
// Taak 6 + 7: dual-stream capture + WebSocket URL bepalen vanuit supabaseUrl.

let audioContext = null;
// Plan B (1.0.25): losse AudioContext voor de mic-pipeline. De stille-sink-fix
// (1.0.24, zie wireMicWorklet) deelde nog altijd één AudioContext + worklet-
// module met de tab-pipeline. Mocht Jitsi/Chrome die gedeelde context zelf
// beinvloeden (bijv. tijdelijk suspenden) tijdens de conferentie, dan isoleert
// dit de mic volledig: eigen context, eigen geladen worklet-module, eigen
// stille sink. De tab-pipeline (audioContext) blijft ongewijzigd.
let micAudioContext = null;
let micContextWatchdog = null;
const MIC_CONTEXT_WATCHDOG_MS = 5000;
let micWorkletNode = null;
let micSourceNode = null;
let tabWorkletNode = null;
let micStream = null;
let tabStream = null;
// Jitsi-mute (1.0.22): de coach-mic is een eigen getUserMedia en weet niets van
// de Jitsi-mute. Zonder deze koppeling luisterde de coach door terwijl Maarten
// gemute was, en pikte de klant (speakers/telefoon in dezelfde kamer) op als
// 'advisor'. De webapp stuurt de mute-status door; wij zetten alleen de audio-
// tracks op enabled=false (stream blijft open, dus geen re-permission).
let micMuted = false;
let ws = null;

// Diagnostische counters + interval. Module-scope zodat de periodieke broadcast
// (1.0.9) dezelfde waarden ziet als de worklet-message handlers.
let tabFrameCount = 0;
let micFrameCount = 0;
// Niveau-diagnostiek (1.0.24): RMS per bron over het laatste diagnostiek-
// venster (2 s). Hiermee is "adviseur-audio valt weg" (Exit Scan Ondmand
// 2026-08-27: mic leverde stubs zolang de tab speelde, volle zinnen zodra de
// prospect weg was) hard te meten: levert de mic signaal tijdens double-talk,
// of drukt Chrome's echo-/ruisonderdrukking hem weg.
const level = {
  mic: { sum: 0, peak: 0, n: 0 },
  tab: { sum: 0, peak: 0, n: 0 },
};
function trackLevel(kind, rms) {
  if (typeof rms !== 'number' || !Number.isFinite(rms)) return;
  const l = level[kind];
  l.sum += rms;
  l.n += 1;
  if (rms > l.peak) l.peak = rms;
}
function flushLevel(kind) {
  const l = level[kind];
  const out = { avg: l.n > 0 ? Number((l.sum / l.n).toFixed(4)) : 0, peak: Number(l.peak.toFixed(4)), chunks: l.n };
  l.sum = 0; l.peak = 0; l.n = 0;
  return out;
}
let diagnosticInterval = null;

// Reconnect bookkeeping (1.0.12). Audio-streams en AudioContext blijven in
// leven over reconnects heen - alleen de WS vervangen we. Zonder dit herstelde
// de extensie niet van transient WS drops en moest gebruiker handmatig opnieuw
// starten.
let reconnectAttempts = 0;
let reconnectTimer = null;
let stopRequested = false;
let lastSessionArgs = null; // { coachToken, meetingId, supabaseUrl, nonce }
let lastCloseInfo = { code: null, reason: null, clean: null };
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 10000;
const RECONNECT_GIVE_UP_MS = 10 * 60 * 1000; // stil blijven proberen, gesprek mag niet stranden
let reconnectSince = null;

// App-level heartbeat (1.0.17). Zonder verkeer sluiten sommige proxies een idle
// WebSocket (vermoedelijke 76s-kill tijdens stiltes). Stuur elke 20s een ping
// zodat de upstream-verbinding warm blijft, ook als er even geen audio-frames
// gaan. De server (coach-stream) antwoordt met pong en pingt zelf ook terug.
let heartbeatTimer = null;
const HEARTBEAT_INTERVAL_MS = 20000;

function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'ping', ts: Date.now() })); } catch { /* ignore */ }
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// Lees de worklet-code als string voor Blob URL (omzeilt CSP in offscreen context).
// Alternatief: verwijs naar worklet-processor.js via relatief pad.
// In offscreen document werkt chrome.runtime.getURL() voor extensie-resources.
const WORKLET_URL = chrome.runtime.getURL('worklet-processor.js');

// Coach-mic ZONDER Chrome-audioprocessing (1.0.26). Diagnose 2026-08-27 (sessie
// 6acd193d): de advisor-stubs ("En je hebt", "Zou je dus", "mee") waren Deepgram-
// finals met volle 3-4 s-vensters en een mic-streamklok die exact op de wandklok
// liep. Frames kwamen dus continu en realtime aan; de INHOUD was weggedrukt.
// Oorzaak: met echoCancellation/noiseSuppression/autoGainControl = true zet
// Chrome's AEC3 zijn residu-onderdrukking op deze capture zodra er een actief
// far-end-signaal wordt gerenderd. Met een tweede Jitsi-deelnemer rendert
// Chrome continu remote-audio (ook stilte) en speelt de tab-tak hieronder de
// tab-audio nog eens af: de mic werd tot losse woorden onderdrukt. Zonder
// tweede deelnemer wordt niets gerenderd en was de mic schoon. Jitsi houdt zijn
// eigen bewerkte mic voor de call; deze mic dient alleen de transcriptie.
// Speaker-echo van de prospect op de mic vangt de server-side EchoBuffer af.
// 1.0.27: autoGainControl weer AAN. Prod 2026-08-27 14:05: een verre mic
// zonder AGC leverde praktisch stilte (nul adviseur-finals). AEC en NS
// blijven uit (die drukten de inhoud weg, zie hierboven).
const MIC_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: true,
};

// Device-keuze (1.0.26). Live-test 2026-08-27 13:27: de extensie luisterde naar
// Chrome's standaardapparaat (headset op het bureau) terwijl Maarten in de
// Snowball sprak die Jitsi gebruikte: alleen luide flarden kwamen door. De
// webapp stuurt het Jitsi-mic-label (SET_MIC_DEVICE); de popup kan een
// handmatige override zetten. Voorrang: override > Jitsi-label > default.
// deviceId's zijn per origin, dus we zoeken hier zelf op label.
let micPref = { jitsiLabel: null, overrideLabel: null };
let micDeviceInfo = { label: null, source: 'default', matched: false, requested: null };
// 1.0.27: laatste acquire-fout (zichtbaar in ext_diagnostic.micError). Een mic
// die stil wegvalt is precies wat 2026-08-27 14:05 gebeurde: nul adviseur-
// utterances zonder enige melding.
let micError = null;
// 1.0.27: reacquires geserialiseerd. SET_MIC_DEVICE (bij sessiestart) en
// MIC_OVERRIDE_CHANGED (popup) konden tegelijk met de eerste acquire of met
// elkaar lopen; elke reacquire stopte de stream van de ander.
let micOpChain = Promise.resolve();
let micStartupDone = false;
let micPendingReacquire = false;

function normLabel(s) { return String(s ?? '').trim().toLowerCase(); }

function setMicError(stage, err) {
  const msg = `${stage}: ${err?.name ?? 'Error'}${err?.message ? ` ${err.message}` : ''}`;
  micError = { stage, message: msg, at: Date.now() };
  console.error(`[coach-ext/offscreen] mic ${msg}`);
  broadcast({ type: 'ext_mic_error', stage, message: msg });
}

async function fetchMicPref() {
  try {
    const resp = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'GET_MIC_DEVICE' }, (r) => {
        if (chrome.runtime.lastError) resolve(null); else resolve(r ?? null);
      });
    });
    if (resp) {
      micPref = { jitsiLabel: resp.jitsiLabel ?? null, overrideLabel: resp.overrideLabel ?? null };
    }
  } catch { /* ignore */ }
}

// Zoekt het extensie-eigen deviceId bij het gewenste label. Exacte match
// eerst, dan bevat-match (Chrome varieert soms in prefix/suffix zoals
// "Default - " of "(0d8c:0005)"). Bij een bevat-match slaan we de virtuele
// "default"/"communications"-ingang over als er ook een fysieke match is.
async function resolveMicDeviceId() {
  const requested = micPref.overrideLabel || micPref.jitsiLabel || null;
  const source = micPref.overrideLabel ? 'override' : micPref.jitsiLabel ? 'jitsi' : 'default';
  if (!requested) return { deviceId: null, source, matched: false, requested: null, inputs: 0 };
  let inputs = [];
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    inputs = all.filter((d) => d.kind === 'audioinput' && d.label);
  } catch (err) {
    console.warn('[coach-ext/offscreen] enumerateDevices faalde:', err?.message);
  }
  const want = normLabel(requested);
  const exact = inputs.find((d) => normLabel(d.label) === want);
  const looseAll = inputs.filter((d) => normLabel(d.label).includes(want) || want.includes(normLabel(d.label)));
  const loose = exact
    || looseAll.find((d) => d.deviceId !== 'default' && d.deviceId !== 'communications')
    || looseAll[0];
  if (!loose) {
    console.warn(`[coach-ext/offscreen] mic "${requested}" niet gevonden (${inputs.length} inputs met label), val terug op default`);
    return { deviceId: null, source, matched: false, requested, inputs: inputs.length };
  }
  return { deviceId: loose.deviceId, source, matched: true, requested, inputs: inputs.length };
}

function stopTracks(stream) {
  try { stream?.getTracks().forEach((t) => { try { t.stop(); } catch { /* ignore */ } }); } catch { /* ignore */ }
}

// Verwerft de coach-mic. Mag NOOIT stil falen (1.0.27):
//  1. enumerateDevices geeft in het offscreen-document pas labels zodra er
//     een actieve stream is; zonder labels matcht de Jitsi-/override-mic
//     nooit en bleef de extensie stil op Chrome's standaardapparaat hangen.
//     Daarom eerst een default-stream openen, dan enumereren.
//  2. getUserMedia met deviceId exact kan OverconstrainedError/NotReadable
//     geven: terugvallen op default met MIC_CONSTRAINTS.
//  3. Faalt ook dat (bijv. constraints niet toegestaan): {audio:true}.
// Elke fout gaat naar console.error + ext_diagnostic.micError.
async function acquireMicStream() {
  await fetchMicPref();
  const wantsSpecific = !!(micPref.overrideLabel || micPref.jitsiLabel);
  let stream = null;
  let lastErr = null;

  const gum = async (constraints, stage) => {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
    } catch (err) {
      lastErr = err;
      setMicError(stage, err);
      return null;
    }
  };

  // Stap A: default-stream (ontsluit labels; is meteen de fallback).
  let defaultStream = await gum(MIC_CONSTRAINTS, 'getUserMedia(default)');
  if (!defaultStream) defaultStream = await gum(true, 'getUserMedia(audio:true)');
  if (!defaultStream) throw lastErr ?? new Error('getUserMedia faalde');

  // Stap B: gewenste mic opzoeken (labels zijn nu beschikbaar) en openen.
  let pick = { deviceId: null, source: 'default', matched: false, requested: null, inputs: 0 };
  if (wantsSpecific) {
    pick = await resolveMicDeviceId();
    const defaultLabel = defaultStream.getAudioTracks()[0]?.label ?? '';
    if (pick.deviceId && pick.requested && normLabel(defaultLabel) && normLabel(defaultLabel) === normLabel(pick.requested)) {
      // De default IS al de gevraagde mic: geen tweede open nodig.
      stream = defaultStream;
      defaultStream = null;
    } else if (pick.deviceId) {
      const specific = await gum({ ...MIC_CONSTRAINTS, deviceId: { exact: pick.deviceId } }, 'getUserMedia(deviceId)');
      if (specific) {
        stream = specific;
        stopTracks(defaultStream);
        defaultStream = null;
      } else {
        pick.matched = false;
      }
    }
  }
  if (!stream) {
    stream = defaultStream;
    defaultStream = null;
  }

  const label = stream.getAudioTracks()[0]?.label ?? null;
  micDeviceInfo = { label, source: pick.matched ? pick.source : 'default', matched: pick.matched, requested: pick.requested, inputs: pick.inputs };
  if (pick.matched) micError = null;
  console.log(`[coach-ext/offscreen] coach-mic: "${label}" (bron=${micDeviceInfo.source}, gevraagd=${pick.requested ?? '-'}, match=${pick.matched}, inputs=${pick.inputs})`);
  return stream;
}

// Wat Chrome werkelijk toepaste (getSettings) voor de diagnostiek-broadcast.
function micTrackSettings() {
  const t = micStream?.getAudioTracks?.()[0];
  if (!t || typeof t.getSettings !== 'function') return null;
  const s = t.getSettings();
  return {
    echoCancellation: s.echoCancellation ?? null,
    noiseSuppression: s.noiseSuppression ?? null,
    autoGainControl: s.autoGainControl ?? null,
    sampleRate: s.sampleRate ?? null,
  };
}

// Bouwt de WebSocket URL op basis van de Supabase-project URL.
// Taak 7: WebSocket URL bepalen vanuit supabaseUrl.
function buildWsUrl(supabaseUrl, meetingId, coachToken) {
  // Converteer https:// naar wss://
  const wsBase = supabaseUrl.replace(/^https?:\/\//, 'wss://');
  const params = new URLSearchParams({ meeting_id: meetingId, token: coachToken });
  return `${wsBase}/functions/v1/coach-stream?${params.toString()}`;
}

// Open alleen de WebSocket (niet de audio-pipeline). Wordt gebruikt bij
// eerste start + bij reconnects zodat streams/worklets behouden blijven.
function openWebSocket({ coachToken, meetingId, supabaseUrl, nonce }, isReconnect = false) {
  const wsUrl = buildWsUrl(supabaseUrl, meetingId, coachToken);
  ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    console.log(`[coach-ext/offscreen] WebSocket verbonden${isReconnect ? ' (reconnect)' : ''}`);
    reconnectAttempts = 0;
    reconnectSince = null;
    lastCloseInfo = { code: null, reason: null, clean: null };
    startHeartbeat();
    // Bij een reconnect kan de mic-track tijdens de drop zijn gestorven; her-acquire.
    if (isReconnect) void ensureMicHealthy();
  };

  ws.onerror = (err) => {
    console.error('[coach-ext/offscreen] WebSocket fout:', err);
  };

  ws.onclose = (ev) => {
    stopHeartbeat();
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
    if (reconnectSince === null) reconnectSince = Date.now();
    if (Date.now() - reconnectSince > RECONNECT_GIVE_UP_MS) {
      chrome.runtime.sendMessage({
        type: 'WS_EVENT',
        payload: { type: 'error', code: 'reconnect_failed', message: `Reconnect mislukt na ${reconnectAttempts} pogingen (code=${lastCloseInfo.code})` },
      }).catch(() => { /* ignore */ });
      // Signaleer background dat de sessie definitief kapot is, zodat
      // sessionState van 'active' naar 'error' gaat (anders blijft popup
      // "Sessie actief" tonen terwijl er niks meer gebeurt).
      chrome.runtime.sendMessage({
        type: 'SESSION_FAILED',
        reason: `WebSocket reconnect mislukt (code=${lastCloseInfo.code})`,
      }).catch(() => { /* ignore */ });
      // Ook audio-pipeline volledig afsluiten zodat tabCapture vrij komt en
      // de volgende start-poging niet op "Cannot capture a tab with an active
      // stream" loopt.
      void stopAudio();
      return;
    }
    reconnectAttempts += 1;
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempts - 1), RECONNECT_MAX_DELAY_MS);
    console.log(`[coach-ext/offscreen] Reconnect poging ${reconnectAttempts} over ${delay}ms`);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (stopRequested) return;
      // Haal voor reconnect de meest recente gescopeerde coach-token op. De
      // webapp publiceert iedere vier minuten, vóór de vijfminuten-expiry.
      chrome.runtime.sendMessage({ type: 'GET_FRESH_CONTEXT' }, (response) => {
        if (response?.coachToken && response?.meetingId && response?.nonce === nonce) {
          lastSessionArgs = {
            coachToken: response.coachToken,
            meetingId: response.meetingId,
            supabaseUrl: response.supabaseUrl || lastSessionArgs.supabaseUrl,
            nonce: response.nonce,
          };
        }
        openWebSocket(lastSessionArgs, true);
      });
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

async function startAudio({ streamId, coachToken, meetingId, supabaseUrl, nonce }) {
  micStartupDone = false;
  micPendingReacquire = false;
  micError = null;
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
    micStream = await acquireMicStream();
    console.log('[coach-ext/offscreen] micStream audio tracks:', micStream.getAudioTracks().length);
    applyMicMute(); // beginstand volgt de laatst gemelde Jitsi-mute
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
  lastSessionArgs = { coachToken, meetingId, supabaseUrl, nonce };
  openWebSocket(lastSessionArgs, false);

  // 6a. Tab-audio worklet (source 0x02).
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
      if (ev.data) trackLevel('tab', ev.data.rms);
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
    attachTrackEndedHandler(tabAudioTracks[0], 'tab');
  } else {
    console.warn('[coach-ext/offscreen] tabStream heeft GEEN audio tracks');
  }

  // 6b. Mic-audio worklet (source 0x01), indien beschikbaar, in zijn EIGEN
  //    AudioContext (plan B, 1.0.25). setupMicAudioContext maakt/hergebruikt
  //    micAudioContext en laadt de worklet-module daarin; wireMicWorklet
  //    hangt ook de track-'ended'-listener voor mic-verlies-detectie.
  if (micStream) {
    await setupMicAudioContext();
    wireMicWorklet();
  }
  // 1.0.27: pas nu mogen device-wissels de mic her-acquireren. Kwam er
  // tijdens de opbouw al een SET_MIC_DEVICE/override binnen, dan nu alsnog.
  micStartupDone = true;
  if (micPendingReacquire) {
    micPendingReacquire = false;
    scheduleReacquireMic('wissel tijdens opbouw');
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
      // Plan B (1.0.25): losse context voor de mic; 'suspended' hier wijst op
      // Chrome die de mic-graaf zelf pauzeert (de watchdog probeert resume()).
      micAudioContextState: micAudioContext?.state ?? 'none',
      tabAudioTracks: tabStream?.getAudioTracks().length ?? 0,
      micAudioTracks: micStream?.getAudioTracks().length ?? 0,
      micMuted,
      // 1.0.26: bewijs dat de mic zonder AEC/NS/AGC draait.
      micSettings: micTrackSettings(),
      // 1.0.26: welke mic werkelijk open is + of dat de gevraagde (Jitsi/override) was.
      micDevice: micDeviceInfo,
      // 1.0.27: laatste mic-fout (null = geen). Stil wegvallen is verboden.
      micError,
      tabFrameCount,
      micFrameCount,
      // RMS-niveaus (0..1) over de laatste 2 s. micLevel.avg < 0.005 terwijl
      // tabLevel.avg > 0.02 en Maarten spreekt = mic wordt weggedrukt.
      micLevel: flushLevel('mic'),
      tabLevel: flushLevel('tab'),
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

// Relay een event naar de service worker -> content-script -> webapp.
function broadcast(payload) {
  chrome.runtime.sendMessage({ type: 'WS_EVENT', payload }).catch(() => { /* ignore */ });
}

// (1.0.18) Verbind de mic-stream met de worklet. Herbruikbaar bij eerste start
// én bij her-acquire na mic-verlies. Hangt ook de track-'ended'-listener.
// Zet de mic-tracks aan/uit volgens de Jitsi-mute. Niet stoppen, alleen gaten.
function applyMicMute() {
  if (!micStream) return;
  micStream.getAudioTracks().forEach((t) => { t.enabled = !micMuted; });
}

// Plan B (1.0.25): maakt (of hergebruikt) de losse mic-AudioContext en laadt
// daarin een eigen instantie van de worklet-module. Idempotent: bij een
// reacquire (device-wissel, mic-verlies) bestaat micAudioContext meestal al
// en wordt hij hergebruikt in plaats van opnieuw geopend - alleen de
// MediaStreamSource + worklet-node worden herbouwd in wireMicWorklet().
async function setupMicAudioContext() {
  if (micAudioContext && micAudioContext.state === 'closed') {
    // Een gesloten context gooit bij createMediaStreamSource/AudioWorkletNode.
    console.warn('[coach-ext/offscreen] micAudioContext was closed, nieuwe context');
    micAudioContext = null;
  }
  if (!micAudioContext) {
    micAudioContext = new AudioContext({ sampleRate: 48000 });
    await micAudioContext.audioWorklet.addModule(WORKLET_URL);
  }
  if (micAudioContext.state === 'suspended') {
    await micAudioContext.resume();
  }
  startMicContextWatchdog();
}

// Chrome kan een AudioContext in een offscreen document tussentijds suspenden
// (bijv. zodra de conferentie het venster/tab niet als "actief" ziet). Een
// suspended context levert geen frames meer, ongeacht de stille-sink-fix.
// Deze watchdog probeert elke 5s opnieuw te resumen en logt elke poging, zodat
// zichtbaar is of dit daadwerkelijk voorkomt tijdens een live gesprek.
function startMicContextWatchdog() {
  if (micContextWatchdog) clearInterval(micContextWatchdog);
  micContextWatchdog = setInterval(() => {
    if (!micAudioContext) return;
    if (micAudioContext.state === 'suspended') {
      console.warn('[coach-ext/offscreen] micAudioContext is suspended, resume() opnieuw proberen');
      micAudioContext.resume()
        .then(() => console.log('[coach-ext/offscreen] micAudioContext.resume() gelukt, state=', micAudioContext?.state))
        .catch((err) => console.warn('[coach-ext/offscreen] micAudioContext.resume() faalde:', err?.message));
    }
  }, MIC_CONTEXT_WATCHDOG_MS);
}

function stopMicContextWatchdog() {
  if (micContextWatchdog) {
    clearInterval(micContextWatchdog);
    micContextWatchdog = null;
  }
}

function wireMicWorklet() {
  if (!micStream || !micAudioContext) return;
  const micAudioTracks = micStream.getAudioTracks();
  if (micAudioTracks.length === 0) return;
  try { micWorkletNode?.disconnect(); } catch { /* ignore */ }
  try { micSourceNode?.disconnect(); } catch { /* ignore */ }
  micWorkletNode = new AudioWorkletNode(micAudioContext, 'coach-pcm-worklet-labeled', {
    processorOptions: { sourceLabel: 0x01 },
  });
  micWorkletNode.port.onmessage = (ev) => {
    if (ev.data) trackLevel('mic', ev.data.rms);
    if (ev.data && ev.data.buffer instanceof ArrayBuffer && ws?.readyState === WebSocket.OPEN) {
      ws.send(buildMultiplexFrame(ev.data.source, ev.data.buffer));
      micFrameCount++;
    }
  };
  const micSource = micAudioContext.createMediaStreamSource(micStream);
  micSourceNode = micSource;
  micSource.connect(micWorkletNode);
  // Stille sink (1.0.24, behouden in plan B): de mic-tak hangt niet direct aan
  // micAudioContext.destination met hoorbaar volume, maar via een GainNode met
  // gain HARD 0. Dat houdt de subgraaf actief (voorkomt de oorspronkelijke
  // 1.0.24-diagnose: een onverbonden subgraaf die Chrome intermitterend laat
  // draaien) zonder hoorbare echo van de eigen stem. De Jitsi-mute-gating
  // (track.enabled in applyMicMute) zit vóór de worklet en verandert niet.
  const micSilentSink = micAudioContext.createGain();
  micSilentSink.gain.value = 0;
  micWorkletNode.connect(micSilentSink);
  micSilentSink.connect(micAudioContext.destination);
  attachTrackEndedHandler(micAudioTracks[0], 'mic');
}

// Hang een 'ended'-listener op een audio-track. Mic-verlies -> expliciet event
// naar de pagina (voedt de banner) + re-acquire-poging. Tab-verlies -> error.
function attachTrackEndedHandler(track, kind) {
  if (!track) return;
  track.addEventListener('ended', () => {
    if (stopRequested) return; // teardown, geen valse melding
    console.warn(`[coach-ext/offscreen] ${kind}-track ended`);
    if (kind === 'mic') {
      broadcast({ type: 'ext_mic_lost' });
      void scheduleReacquireMic('track ended');
    } else {
      broadcast({ type: 'error', code: 'tab_track_ended', message: 'Klant-audio (tab) is gestopt. Herstart de coach.' });
    }
  }, { once: true });
}

// Verwerf de microfoon opnieuw (bijv. na apparaat-wissel of intrekking) en
// herbouw de worklet. Best-effort; bij falen blijft de mic-lost-melding staan.
// 1.0.27: geserialiseerd via micOpChain, zodat twee wissels (of een wissel
// tijdens een mic-verlies-herstel) nooit elkaars stream stoppen. Tijdens de
// sessie-opbouw wordt de wissel geparkeerd (micPendingReacquire) en na het
// wiren alsnog uitgevoerd.
function scheduleReacquireMic(reason) {
  if (stopRequested || !audioContext) return Promise.resolve();
  if (!micStartupDone) {
    micPendingReacquire = true;
    console.log(`[coach-ext/offscreen] mic-reacquire geparkeerd tot na opbouw (${reason})`);
    return Promise.resolve();
  }
  micOpChain = micOpChain.then(() => reacquireMic(reason)).catch(() => { /* al gelogd */ });
  return micOpChain;
}

async function reacquireMic(reason = '') {
  if (stopRequested || !audioContext) return;
  const oldStream = micStream;
  try {
    // Nieuwe stream EERST openen, dan pas de oude stoppen: faalt de nieuwe,
    // dan blijft de oude gewoon doorlopen in plaats van een dode mic.
    const fresh = await acquireMicStream();
    if (stopRequested) { stopTracks(fresh); return; }
    micStream = fresh;
    if (oldStream && oldStream !== fresh) stopTracks(oldStream);
    applyMicMute(); // mute-stand behouden over een re-acquire heen
    // Plan B: micAudioContext blijft bestaan over een device-wissel heen en
    // wordt hier hergebruikt (setupMicAudioContext is idempotent); alleen de
    // MediaStreamSource + worklet-node worden herbouwd in wireMicWorklet().
    await setupMicAudioContext();
    wireMicWorklet();
    broadcast({ type: 'ext_mic_restored' });
    console.log(`[coach-ext/offscreen] microfoon opnieuw verworven${reason ? ` (${reason})` : ''}`);
  } catch (err) {
    setMicError('reacquire', err);
    // Oude stream nog levend? Dan blijft die de bron (worklet hangt er nog aan).
    const t = oldStream?.getAudioTracks?.()[0];
    if (!t || t.readyState === 'ended') broadcast({ type: 'ext_mic_lost' });
  }
}

// Controleer bij een WS-reconnect of de mic-track nog leeft; zo niet, re-acquire.
async function ensureMicHealthy() {
  if (stopRequested || !audioContext) return;
  const track = micStream?.getAudioTracks?.()[0];
  if (!track || track.readyState === 'ended') {
    await scheduleReacquireMic('ws reconnect');
  }
}

async function stopAudio() {
  stopRequested = true;
  stopHeartbeat();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  lastSessionArgs = null;
  reconnectAttempts = 0;
  reconnectSince = null;

  // Stop diagnostic broadcast.
  if (diagnosticInterval) {
    clearInterval(diagnosticInterval);
    diagnosticInterval = null;
  }
  stopMicContextWatchdog();
  tabFrameCount = 0;
  micFrameCount = 0;

  // Stop worklets
  try { micWorkletNode?.disconnect(); } catch { /* ignore */ }
  try { micSourceNode?.disconnect(); } catch { /* ignore */ }
  try { tabWorkletNode?.disconnect(); } catch { /* ignore */ }
  micWorkletNode = null;
  micSourceNode = null;
  tabWorkletNode = null;
  micStartupDone = false;
  micPendingReacquire = false;

  // Stop streams
  micStream?.getTracks().forEach((t) => t.stop());
  tabStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
  tabStream = null;

  // Sluit AudioContexts (plan B: mic + tab zijn twee losse contexts)
  try { await audioContext?.close(); } catch { /* ignore */ }
  audioContext = null;
  try { await micAudioContext?.close(); } catch { /* ignore */ }
  micAudioContext = null;

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
    const { streamId, coachToken, meetingId, supabaseUrl, nonce } = message;
    startAudio({ streamId, coachToken, meetingId, supabaseUrl, nonce })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error('[coach-ext/offscreen] START_AUDIO fout:', err);
        sendResponse({ ok: false, error: err.message });
      });
    return true; // asynchrone response
  }

  // Jitsi-mic-label (via content-script) of popup-override gewijzigd: als het
  // effectieve gewenste label verandert, de mic opnieuw verwerven.
  if (message.type === 'SET_MIC_DEVICE' || message.type === 'MIC_OVERRIDE_CHANGED') {
    const before = micPref.overrideLabel || micPref.jitsiLabel || null;
    if (message.type === 'SET_MIC_DEVICE') micPref.jitsiLabel = message.label ?? null;
    else micPref.overrideLabel = message.label ?? null;
    const after = micPref.overrideLabel || micPref.jitsiLabel || null;
    if (normLabel(before) !== normLabel(after)) {
      if (audioContext) {
        console.log(`[coach-ext/offscreen] gewenste mic gewijzigd: "${before ?? '-'}" -> "${after ?? '-'}", opnieuw verwerven`);
        void scheduleReacquireMic(message.type);
      } else {
        // Codex #320: wissel vóór startAudio niet kwijtraken; startAudio leest
        // micPref al bij de eerste acquire, maar een lopende startAudio (zonder
        // audioContext) pakt hem via micPendingReacquire alsnog op.
        micPendingReacquire = true;
      }
    }
    return false; // background beantwoordt SET_MIC_DEVICE
  }

  if (message.type === 'SET_MIC_MUTE') {
    micMuted = !!message.muted;
    applyMicMute();
    console.log('[coach-ext/offscreen] mic', micMuted ? 'gemute (Jitsi)' : 'aan (Jitsi)');
    sendResponse({ ok: true, muted: micMuted });
    return false;
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

  if (message.type === 'CONFERENCE_END_AUDIO') {
    // Meld het videoconferentie-einde over de coach-WS VOORDAT we de socket
    // sluiten, zodat de server de streams + sessie netjes afsluit. Daarna de
    // normale audio-teardown (sluit ook de WS).
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'videoConferenceLeft' }));
      }
    } catch { /* ignore */ }
    stopAudio()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error('[coach-ext/offscreen] CONFERENCE_END_AUDIO fout:', err);
        sendResponse({ ok: false, error: err.message });
      });
    return true; // asynchrone response
  }

  return false;
});
