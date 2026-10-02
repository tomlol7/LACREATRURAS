/* 
 * Web DAW — static, browser-only audio engine
 * Drop this file next to index.html and style.css.
 *
 * Sample URLs:
 * 1) Put local files in ./samples/ and list them here.
 * 2) Or replace the strings with CORS-enabled direct URLs.
 */
const SAMPLE_URLS = [
  { id: "kick",  name: "Kick — SpinZ",  url: "./samples/808_Spinz.wav" },
  { id: "clap",  name: "Clap — Trap",   url: "./samples/Clap_Trap.wav" },
  { id: "hat",   name: "Hat — Closed",  url: "./samples/HH_Closed.wav" },
  { id: "perc",  name: "Perc — Digital",url: "./samples/Perc_Digital.wav" },
  { id: "bass",  name: "808 — Deep",    url: "./samples/808_Deep.wav" }
];

const CONFIG = {
  tracks: 16,
  beats: 64,
  snapDefault: 0.25,
  lookaheadMs: 25,
  scheduleAheadTime: 0.10,
  maxLoadedRetries: 1
};

const state = {
  audioContext: null,
  masterGain: null,
  tracks: [],
  samples: new Map(),
  clips: [],
  selectedClipId: null,
  selectedTrackId: 1,
  tempo: 140,
  playheadBeat: 0,
  isPlaying: false,
  playAnchorContextTime: 0,
  playAnchorBeat: 0,
  schedulerTimer: null,
  scheduleSession: 0,
  scheduledSources: new Map(),
  zoom: 48,
  snap: CONFIG.snapDefault,
  sampleSelectionId: SAMPLE_URLS[0]?.id || null,
  rafId: null,
  nextClipId: 1
};

const dom = {};

function qs(id) {
  return document.getElementById(id);
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function dbToGain(db) {
  return Math.pow(10, db / 20);
}

function gainToDb(gain) {
  return 20 * Math.log10(Math.max(0.000001, gain));
}

function beatsToSeconds(beats) {
  return beats * (60 / state.tempo);
}

function secondsToBeats(sec) {
  return sec * (state.tempo / 60);
}

function snapBeat(beat) {
  const s = state.snap;
  return Math.max(0, Math.round(beat / s) * s);
}

function formatSeconds(seconds) {
  const total = Math.max(0, seconds);
  const mins = Math.floor(total / 60);
  const secs = Math.floor(total % 60);
  const ms = Math.floor((total - Math.floor(total)) * 1000);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}:${String(ms).padStart(3, "0")}`;
}

function updateMasterReadout() {
  const db = gainToDb(parseFloat(dom.masterVolume.value));
  dom.masterVolumeValue.textContent = `${db.toFixed(1)} dB`;
}

function updateTransportReadout() {
  dom.timeDisplay.textContent = formatSeconds(beatsToSeconds(state.playheadBeat));
  dom.beatDisplay.textContent = `Beat ${(state.playheadBeat + 1).toFixed(2)}`;
  dom.cursorStatus.textContent = `Cursor: ${(state.playheadBeat + 1).toFixed(2)} beats`;
}

function setEngineStatus(text, className = "") {
  dom.engineStatus.textContent = text;
  dom.engineStatus.className = `status-pill ${className}`.trim();
}

function createSyntheticImpulseResponse(ctx, seconds = 2.6, decay = 3.1) {
  const sampleRate = ctx.sampleRate;
  const length = Math.floor(seconds * sampleRate);
  const impulse = ctx.createBuffer(2, length, sampleRate);

  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      const env = Math.pow(1 - (i / length), decay);
      const earlyReflection = (i % Math.max(1, Math.floor(sampleRate * 0.017))) === 0 ? 0.18 : 0;
      data[i] = ((Math.random() * 2 - 1) * env * 0.72) + earlyReflection * (ch ? -1 : 1);
    }
  }
  return impulse;
}

function makeDistortionCurve(amount = 8) {
  const samples = 44100;
  const curve = new Float32Array(samples);
  const drive = Math.max(0, amount);
  const deg = Math.PI / 180;

  if (drive <= 0.0001) {
    for (let i = 0; i < samples; i++) {
      const x = (i * 2 / samples) - 1;
      curve[i] = x;
    }
    return curve;
  }

  /* Smooth hard-clipping / saturation transfer:
     y = (1 + k) * x / (1 + k * |x|^a), followed by tanh.
     The exponent keeps low-level material smoother while allowing
     aggressive clipping as the drive value rises. */
  const k = drive * 0.95;
  const a = 1.25 + drive * 0.0075;

  for (let i = 0; i < samples; i++) {
    const x = (i * 2 / samples) - 1;
    const shaped = ((1 + k) * x) / (1 + k * Math.pow(Math.abs(x), a));
    curve[i] = Math.tanh(shaped * (1.4 + drive * 0.018 * deg * 57.2958));
  }

  return curve;
}

function createChorus(ctx) {
  const input = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const delay = ctx.createDelay(0.25);
  const lfo = ctx.createOscillator();
  const depth = ctx.createGain();
  const rate = ctx.createGain();

  delay.delayTime.value = 0.018;
  depth.gain.value = 0.0036;
  lfo.frequency.value = 1.7;
  wet.gain.value = 0.18;
  dry.gain.value = 0.82;

  lfo.connect(depth);
  depth.connect(delay.delayTime);

  input.connect(dry);
  input.connect(delay);
  delay.connect(wet);

  const output = ctx.createGain();
  dry.connect(output);
  wet.connect(output);

  lfo.start();

  return {
    input,
    output,
    delay,
    lfo,
    depth,
    wet,
    dry,
    rate,
    setMix(value) {
      const mix = clamp(value, 0, 1);
      const t = ctx.currentTime;
      dry.gain.cancelScheduledValues(t);
      wet.gain.cancelScheduledValues(t);
      dry.gain.setTargetAtTime(Math.cos(mix * Math.PI * 0.5), t, 0.012);
      wet.gain.setTargetAtTime(Math.sin(mix * Math.PI * 0.5), t, 0.012);
    },
    setRate(hz) {
      lfo.frequency.setTargetAtTime(hz, ctx.currentTime, 0.01);
    }
  };
}

function createTrackAudio(ctx, settings = {}) {
  const input = ctx.createGain();
  const lowShelf = ctx.createBiquadFilter();
  const peak = ctx.createBiquadFilter();
  const highShelf = ctx.createBiquadFilter();

  lowShelf.type = "lowshelf";
  lowShelf.frequency.value = 140;

  peak.type = "peaking";
  peak.frequency.value = 1800;
  peak.Q.value = 0.9;

  highShelf.type = "highshelf";
  highShelf.frequency.value = 5800;

  const dryBus = ctx.createGain();
  const fxBus = ctx.createGain();

  const distortion = ctx.createWaveShaper();
  distortion.oversample = "4x";
  distortion.curve = makeDistortionCurve(settings.drive ?? 8);

  const chorus = createChorus(ctx);

  const convolver = ctx.createConvolver();
  convolver.buffer = createSyntheticImpulseResponse(ctx, 2.6, 3.1);

  const reverbWet = ctx.createGain();
  const reverbDry = ctx.createGain();

  const trackGain = ctx.createGain();
  const panner = ctx.createStereoPanner();

  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1;
  limiter.knee.value = 1;
  limiter.ratio.value = 8;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.06;

  input.connect(lowShelf);
  lowShelf.connect(peak);
  peak.connect(highShelf);

  highShelf.connect(dryBus);
  highShelf.connect(fxBus);

  fxBus.connect(distortion);
  distortion.connect(chorus.input);
  chorus.output.connect(convolver);

  const fxOut = ctx.createGain();
  convolver.connect(fxOut);

  dryBus.connect(reverbDry);
  fxOut.connect(reverbWet);

  reverbDry.connect(trackGain);
  reverbWet.connect(trackGain);

  trackGain.connect(panner);
  panner.connect(limiter);

  return {
    input,
    lowShelf,
    peak,
    highShelf,
    dryBus,
    fxBus,
    distortion,
    chorus,
    convolver,
    reverbWet,
    reverbDry,
    trackGain,
    panner,
    limiter,
    setLowShelf(db) {
      lowShelf.gain.setTargetAtTime(db, ctx.currentTime, 0.012);
    },
    setPeak(db) {
      peak.gain.setTargetAtTime(db, ctx.currentTime, 0.012);
    },
    setHighShelf(db) {
      highShelf.gain.setTargetAtTime(db, ctx.currentTime, 0.012);
    },
    setDrive(value) {
      distortion.curve = makeDistortionCurve(value);
    },
    setChorus(value) {
      chorus.setMix(value);
    },
    setReverb(value) {
      const mix = clamp(value, 0, 1);
      const t = ctx.currentTime;
      const dry = Math.cos(mix * Math.PI * 0.5);
      const wet = Math.sin(mix * Math.PI * 0.5);
      reverbDry.gain.setTargetAtTime(dry, t, 0.012);
      reverbWet.gain.setTargetAtTime(wet, t, 0.012);
    }
  };
}

async function ensureAudioContext() {
  if (!state.audioContext) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error("Web Audio API is not supported by this browser.");

    const ctx = new Ctx();
    state.audioContext = ctx;
    state.masterGain = ctx.createGain();
    state.masterGain.gain.value = parseFloat(dom.masterVolume.value);
    state.masterGain.connect(ctx.destination);

    for (const track of state.tracks) {
      createTrackChain(track);
    }
  }

  if (state.audioContext.state === "suspended") {
    await state.audioContext.resume();
  }

  setEngineStatus("ENGINE READY", "active");
}

function createTrackChain(track) {
  if (!state.audioContext || track.audio) return;
  track.audio = createTrackAudio(state.audioContext, track.fx);
  track.audio.limiter.connect(state.masterGain);
  track.audio.trackGain.gain.value = track.volume;
  track.audio.panner.pan.value = track.pan;
  syncTrackFx(track);
  applyTrackMuteSolo();
}

function makeFallbackBuffer(ctx, id) {
  const sr = ctx.sampleRate;

  const definitions = {
    kick: { duration: 0.6, start: 145, end: 45 },
    clap: { duration: 0.23 },
    hat: { duration: 0.12 },
    perc: { duration: 0.28, start: 560, end: 190 },
    bass: { duration: 1.1, start: 78, end: 44 }
  };

  const def = definitions[id] || definitions.kick;
  const buffer = ctx.createBuffer(1, Math.floor(def.duration * sr), sr);
  const data = buffer.getChannelData(0);

  let phase = 0;
  for (let i = 0; i < data.length; i++) {
    const t = i / sr;
    const p = t / def.duration;
    const env = Math.pow(1 - p, 5);

    if (id === "kick" || id === "bass" || id === "perc") {
      const f = def.start + (def.end - def.start) * Math.min(1, t / def.duration);
      phase += 2 * Math.PI * f / sr;
      data[i] = Math.sin(phase) * env * 0.95;
      if (id === "kick") data[i] += (Math.random() * 2 - 1) * Math.pow(1 - p, 18) * 0.16;
    } else if (id === "hat") {
      const hp = i > 1 ? data[i - 1] * 0.75 : 0;
      const white = (Math.random() * 2 - 1) - hp;
      data[i] = white * env * 0.42;
    } else if (id === "clap") {
      const burst = Math.random() > 0.53 ? 1 : 0;
      const noise = (Math.random() * 2 - 1) * burst;
      const tone = Math.sin(2 * Math.PI * 1850 * t) * 0.14;
      data[i] = (noise * 0.55 + tone) * Math.pow(1 - p, 2.8);
    }
  }

  return buffer;
}

async function fetchSample(sample) {
  const existing = state.samples.get(sample.id);
  if (existing?.buffer) return existing.buffer;

  const ctx = state.audioContext;
  if (!ctx) throw new Error("Audio context not initialized.");

  try {
    const response = await fetch(sample.url, { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    const decoded = await ctx.decodeAudioData(arrayBuffer);
    state.samples.set(sample.id, { ...sample, buffer: decoded, source: "remote" });
    return decoded;
  } catch (err) {
    const fallback = makeFallbackBuffer(ctx, sample.id);
    state.samples.set(sample.id, { ...sample, buffer: fallback, source: "fallback", error: err.message });
    return fallback;
  }
}

async function preloadSamples() {
  await ensureAudioContext();
  setEngineStatus("LOADING SAMPLES", "loading");

  for (const sample of SAMPLE_URLS) {
    const item = dom.sampleList.querySelector(`[data-sample-id="${CSS.escape(sample.id)}"]`);
    if (item) item.querySelector(".sample-state").textContent = "loading";

    const loaded = await fetchSample(sample);
    const result = state.samples.get(sample.id);

    if (item) {
      const stateEl = item.querySelector(".sample-state");
      stateEl.textContent = result.source === "remote" ? "ready" : "fallback";
      stateEl.classList.toggle("loaded", result.source === "remote");
      stateEl.classList.toggle("error", result.source === "fallback");
    }

    if (loaded) renderSampleItem(sample.id);
  }

  setEngineStatus("ENGINE READY", "active");
}

function getTrack(trackId) {
  return state.tracks.find(t => t.id === Number(trackId));
}

function getClip(clipId) {
  return state.clips.find(c => c.id === Number(clipId));
}

function addTrack() {
  const id = state.tracks.length + 1;
  state.tracks.push({
    id,
    name: `Track ${id}`,
    volume: 0.85,
    pan: 0,
    mute: false,
    solo: false,
    fx: {
      eqLow: 0,
      eqPeak: 0,
      eqHigh: 0,
      drive: 8,
      chorus: 0.16,
      reverb: 0.12
    },
    audio: null
  });

  renderTracks();

  if (state.audioContext) {
    createTrackChain(state.tracks[state.tracks.length - 1]);
  }
}

function createInitialTracks() {
  while (state.tracks.length < CONFIG.tracks) addTrack();
}

function renderTracks() {
  dom.trackList.innerHTML = "";
  for (const track of state.tracks) {
    const row = document.createElement("div");
    row.className = `track-row${track.id === state.selectedTrackId ? " selected" : ""}`;
    row.dataset.trackId = track.id;

    row.innerHTML = `
      <div class="track-index">${track.id}</div>
      <div class="track-name" title="${track.name}">${track.name}</div>
      <div class="track-controls">
        <button class="track-button mute-btn${track.mute ? " active" : ""}">M</button>
        <button class="track-button solo-btn${track.solo ? " active" : ""}">S</button>
        <input class="knob-input volume-knob" type="range" min="0" max="1.25" step="0.001" value="${track.volume}">
        <input class="knob-input pan-knob" type="range" min="-1" max="1" step="0.001" value="${track.pan}">
      </div>
    `;

    const volume = row.querySelector(".volume-knob");
    const pan = row.querySelector(".pan-knob");
    updateKnobVisual(volume, track.volume, 0, 1.25);
    updateKnobVisual(pan, track.pan, -1, 1);

    row.addEventListener("click", () => {
      state.selectedTrackId = track.id;
      renderTracks();
      syncInspectorFromSelection();
    });

    row.querySelector(".mute-btn").addEventListener("click", (ev) => {
      ev.stopPropagation();
      track.mute = !track.mute;
      applyTrackMuteSolo();
      renderTracks();
    });

    row.querySelector(".solo-btn").addEventListener("click", (ev) => {
      ev.stopPropagation();
      track.solo = !track.solo;
      applyTrackMuteSolo();
      renderTracks();
    });

    volume.addEventListener("input", (ev) => {
      track.volume = parseFloat(ev.target.value);
      updateKnobVisual(volume, track.volume, 0, 1.25);
      if (track.audio) track.audio.trackGain.gain.setTargetAtTime(track.volume, state.audioContext.currentTime, 0.01);
    });

    pan.addEventListener("input", (ev) => {
      track.pan = parseFloat(ev.target.value);
      updateKnobVisual(pan, track.pan, -1, 1);
      if (track.audio) track.audio.panner.pan.setTargetAtTime(track.pan, state.audioContext.currentTime, 0.01);
    });

    dom.trackList.appendChild(row);
  }
}

function updateKnobVisual(el, value, min, max) {
  if (!el) return;
  const normalized = clamp((value - min) / (max - min), 0, 1);
  const degrees = 20 + normalized * 240;
  el.style.setProperty("--knob-fill", `${degrees}deg`);
}

function applyTrackMuteSolo() {
  const anySolo = state.tracks.some(t => t.solo);
  for (const track of state.tracks) {
    const audible = !track.mute && (!anySolo || track.solo);
    if (track.audio) {
      track.audio.trackGain.gain.setTargetAtTime(
        audible ? track.volume : 0,
        state.audioContext.currentTime,
        0.01
      );
    }
  }
}

function syncTrackFx(track) {
  if (!track?.audio) return;
  track.audio.setLowShelf(track.fx.eqLow);
  track.audio.setPeak(track.fx.eqPeak);
  track.audio.setHighShelf(track.fx.eqHigh);
  track.audio.setDrive(track.fx.drive);
  track.audio.setChorus(track.fx.chorus);
  track.audio.setReverb(track.fx.reverb);
}

function renderSamples() {
  dom.sampleList.innerHTML = "";
  for (const sample of SAMPLE_URLS) {
    const el = document.createElement("div");
    el.className = "sample-item";
    el.draggable = true;
    el.dataset.sampleId = sample.id;
    el.innerHTML = `
      <span class="sample-dot"></span>
      <span class="sample-name">${sample.name}</span>
      <span class="sample-state">${state.samples.has(sample.id) ? "ready" : "idle"}</span>
    `;

    el.addEventListener("dragstart", ev => {
      state.sampleSelectionId = sample.id;
      ev.dataTransfer.effectAllowed = "copy";
      ev.dataTransfer.setData("text/plain", sample.id);
      el.classList.add("dragging");
    });

    el.addEventListener("dragend", () => el.classList.remove("dragging"));

    el.addEventListener("click", async () => {
      state.sampleSelectionId = sample.id;
      setSelectedSampleLabel();
      try {
        await ensureAudioContext();
        await fetchSample(sample);
        renderSampleItem(sample.id);
      } catch (err) {
        console.error(err);
      }
    });

    dom.sampleList.appendChild(el);
  }
}

function renderSampleItem(id) {
  const result = state.samples.get(id);
  const item = dom.sampleList.querySelector(`[data-sample-id="${CSS.escape(id)}"]`);
  if (!item || !result) return;
  const stateEl = item.querySelector(".sample-state");
  stateEl.textContent = result.source === "remote" ? "ready" : "fallback";
  stateEl.classList.toggle("loaded", result.source === "remote");
  stateEl.classList.toggle("error", result.source === "fallback");
}

function createClip(sampleId, trackId, startBeat) {
  const sample = state.samples.get(sampleId);
  if (!sample?.buffer) return null;

  const clip = {
    id: state.nextClipId++,
    sampleId,
    trackId,
    startBeat: Math.max(0, snapBeat(startBeat)),
    playbackRate: 1,
    lengthBeats: clamp(secondsToBeats(sample.buffer.duration), 0.25, 16),
    title: SAMPLE_URLS.find(s => s.id === sampleId)?.name || sampleId
  };

  state.clips.push(clip);
  state.selectedClipId = clip.id;
  state.selectedTrackId = trackId;
  renderPlaylist();
  syncInspectorFromSelection();
  return clip;
}

function renderRuler() {
  dom.ruler.style.setProperty("--beat-width", `${state.zoom}px`);
  dom.playlistContent.style.setProperty("--beat-width", `${state.zoom}px`);
  dom.ruler.innerHTML = "";

  for (let beat = 0; beat < CONFIG.beats; beat++) {
    const label = document.createElement("div");
    label.className = `ruler-label${beat % 4 === 0 ? " ruler-major" : ""}`;
    label.style.left = `${beat * state.zoom}px`;
    label.textContent = beat % 4 === 0 ? `${Math.floor(beat / 4) + 1}` : "·";
    dom.ruler.appendChild(label);
  }
}

function renderPlaylist() {
  renderRuler();
  dom.laneArea.style.width = `${CONFIG.beats * state.zoom}px`;
  dom.playlistContent.style.width = `${CONFIG.beats * state.zoom}px`;

  const fragment = document.createDocumentFragment();
  for (const track of state.tracks) {
    const row = document.createElement("div");
    row.className = "lane-row";
    row.dataset.trackId = track.id;
    fragment.appendChild(row);
  }
  dom.laneArea.replaceChildren(fragment);

  for (const clip of state.clips) {
    const row = dom.laneArea.querySelector(`.lane-row[data-track-id="${clip.trackId}"]`);
    if (!row) continue;

    const node = document.createElement("div");
    node.className = `clip${clip.id === state.selectedClipId ? " selected" : ""}`;
    node.dataset.clipId = clip.id;
    node.style.left = `${clip.startBeat * state.zoom}px`;
    node.style.width = `${Math.max(18, clip.lengthBeats * state.zoom)}px`;
    node.innerHTML = `
      <span class="clip-title">${escapeHtml(clip.title)}</span>
      <span class="clip-meta">rate ${clip.playbackRate.toFixed(2)}x</span>
    `;

    node.addEventListener("pointerdown", ev => beginClipDrag(ev, clip, node));
    node.addEventListener("click", ev => {
      ev.stopPropagation();
      state.selectedClipId = clip.id;
      state.selectedTrackId = clip.trackId;
      renderPlaylist();
      renderTracks();
      syncInspectorFromSelection();
    });

    row.appendChild(node);
  }

  let playhead = dom.laneArea.querySelector(".playhead");
  if (!playhead) {
    playhead = document.createElement("div");
    playhead.className = "playhead";
    dom.laneArea.appendChild(playhead);
  }
  playhead.style.left = `${state.playheadBeat * state.zoom}px`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function beginClipDrag(ev, clip, node) {
  if (ev.button !== 0) return;

  ev.stopPropagation();
  node.setPointerCapture(ev.pointerId);
  state.selectedClipId = clip.id;
  state.selectedTrackId = clip.trackId;

  const startClientX = ev.clientX;
  const startClientY = ev.clientY;
  const originalBeat = clip.startBeat;
  const originalTrack = clip.trackId;

  const move = moveEv => {
    const beatDelta = snapBeat((moveEv.clientX - startClientX) / state.zoom);
    const rawBeat = originalBeat + beatDelta;
    clip.startBeat = clamp(snapBeat(rawBeat), 0, CONFIG.beats - 0.125);

    const rowRect = dom.laneArea.getBoundingClientRect();
    const trackHeight = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--track-height"));
    const localY = moveEv.clientY - rowRect.top + dom.playlistViewport.scrollTop;
    const targetTrack = clamp(Math.floor(localY / trackHeight) + 1, 1, state.tracks.length);
    clip.trackId = targetTrack;

    node.style.left = `${clip.startBeat * state.zoom}px`;
    node.style.width = `${Math.max(18, clip.lengthBeats * state.zoom)}px`;

    const selectedRow = dom.laneArea.querySelector(`.lane-row[data-track-id="${clip.trackId}"]`);
    if (selectedRow) selectedRow.appendChild(node);
  };

  const up = () => {
    node.releasePointerCapture?.(ev.pointerId);
    node.removeEventListener("pointermove", move);
    node.removeEventListener("pointerup", up);
    node.removeEventListener("pointercancel", up);

    if (clip.trackId !== originalTrack) {
      state.selectedTrackId = clip.trackId;
      renderTracks();
      syncInspectorFromSelection();
    }

    renderPlaylist();
  };

  node.addEventListener("pointermove", move);
  node.addEventListener("pointerup", up);
  node.addEventListener("pointercancel", up);
}

function onLaneDragOver(ev) {
  ev.preventDefault();
  ev.dataTransfer.dropEffect = "copy";
  const row = ev.target.closest(".lane-row");
  if (row) row.classList.add("drop-target");
}

function onLaneDragLeave(ev) {
  const row = ev.target.closest(".lane-row");
  if (row) row.classList.remove("drop-target");
}

async function onLaneDrop(ev) {
  ev.preventDefault();
  document.querySelectorAll(".drop-target").forEach(n => n.classList.remove("drop-target"));

  const row = ev.target.closest(".lane-row");
  if (!row) return;

  const sampleId = ev.dataTransfer.getData("text/plain") || state.sampleSelectionId;
  if (!sampleId) return;

  try {
    await ensureAudioContext();
    const sample = SAMPLE_URLS.find(s => s.id === sampleId);
    if (!sample) return;
    await fetchSample(sample);

    const bounds = dom.laneArea.getBoundingClientRect();
    const x = ev.clientX - bounds.left + dom.playlistViewport.scrollLeft;
    const startBeat = snapBeat(x / state.zoom);
    const trackId = Number(row.dataset.trackId);
    createClip(sampleId, trackId, startBeat);
  } catch (err) {
    console.error(err);
  }
}

async function onLaneDoubleClick(ev) {
  const row = ev.target.closest(".lane-row");
  if (!row) return;

  const sampleId = state.sampleSelectionId || SAMPLE_URLS[0]?.id;
  const sample = SAMPLE_URLS.find(s => s.id === sampleId);
  if (!sample) return;

  try {
    await ensureAudioContext();
    await fetchSample(sample);
    const bounds = dom.laneArea.getBoundingClientRect();
    const x = ev.clientX - bounds.left + dom.playlistViewport.scrollLeft;
    createClip(sampleId, Number(row.dataset.trackId), snapBeat(x / state.zoom));
  } catch (err) {
    console.error(err);
  }
}

function syncInspectorFromSelection() {
  const clip = state.selectedClipId ? getClip(state.selectedClipId) : null;
  const track = getTrack(state.selectedTrackId);

  dom.selectedClipLabel.textContent = clip ? `${clip.title} • Track ${clip.trackId}` : "None";
  dom.pitchSlider.disabled = !clip;
  dom.pitchSlider.value = clip ? (12 * Math.log2(clip.playbackRate)) : 0;
  dom.pitchValue.textContent = clip ? `${(12 * Math.log2(clip.playbackRate)).toFixed(2)}` : "0.00";

  const fx = track?.fx || {};
  setInspectorSlider(dom.eqLow, dom.eqLowValue, fx.eqLow ?? 0, v => `${v.toFixed(1)} dB`);
  setInspectorSlider(dom.eqPeak, dom.eqPeakValue, fx.eqPeak ?? 0, v => `${v.toFixed(1)} dB`);
  setInspectorSlider(dom.eqHigh, dom.eqHighValue, fx.eqHigh ?? 0, v => `${v.toFixed(1)} dB`);
  setInspectorSlider(dom.drive, dom.driveValue, fx.drive ?? 8, v => `${Math.round(v)}%`);
  setInspectorSlider(dom.chorus, dom.chorusValue, fx.chorus ?? 0.16, v => `${Math.round(v * 100)}%`);
  setInspectorSlider(dom.reverb, dom.reverbValue, fx.reverb ?? 0.12, v => `${Math.round(v * 100)}%`);

  dom.selectionStatus.textContent = clip
    ? `Selected: "${clip.title}" — Track ${clip.trackId} — ${clip.playbackRate.toFixed(2)}x`
    : `Track ${track?.id || 1} selected`;
}

function setInspectorSlider(input, label, value, formatter) {
  input.value = value;
  label.textContent = formatter(value);
}

function setSelectedSampleLabel() {
  const sample = SAMPLE_URLS.find(s => s.id === state.sampleSelectionId);
  dom.selectionStatus.textContent = sample ? `Sample armed: ${sample.name}` : "No sample selected";
}

function updateSelectedClipPitch(semitones) {
  const clip = state.selectedClipId ? getClip(state.selectedClipId) : null;
  if (!clip) return;

  clip.playbackRate = Math.pow(2, Number(semitones) / 12);
  dom.pitchValue.textContent = `${Number(semitones).toFixed(2)}`;
  dom.selectionStatus.textContent = `Selected: "${clip.title}" — ${clip.playbackRate.toFixed(2)}x`;
  renderPlaylist();
}

function getCurrentPlayheadBeat() {
  if (!state.isPlaying || !state.audioContext) return state.playheadBeat;
  const elapsed = Math.max(0, state.audioContext.currentTime - state.playAnchorContextTime);
  return state.playAnchorBeat + secondsToBeats(elapsed);
}

function stopAllScheduledSources() {
  for (const source of state.scheduledSources.values()) {
    try { source.stop(); } catch (_) {}
  }
  state.scheduledSources.clear();
}

function startTransport() {
  ensureAudioContext()
    .then(() => {
      if (state.isPlaying) {
        pauseTransport();
        return;
      }

      state.isPlaying = true;
      state.playAnchorBeat = state.playheadBeat;
      state.playAnchorContextTime = state.audioContext.currentTime + 0.06;
      state.scheduleSession++;
      scheduleLoop();
      dom.playBtn.textContent = "❚❚";
      setEngineStatus("PLAYING", "active");
    })
    .catch(err => {
      console.error(err);
      setEngineStatus("ENGINE ERROR");
    });
}

function pauseTransport() {
  if (!state.audioContext) return;

  state.playheadBeat = clamp(getCurrentPlayheadBeat(), 0, CONFIG.beats);
  state.isPlaying = false;
  stopAllScheduledSources();
  clearTimeout(state.schedulerTimer);
  state.schedulerTimer = null;
  state.scheduleSession++;
  dom.playBtn.textContent = "▶";
  setEngineStatus("ENGINE READY", "active");
  updateTransportReadout();
}

function stopTransport() {
  if (!state.audioContext) return;

  state.isPlaying = false;
  stopAllScheduledSources();
  clearTimeout(state.schedulerTimer);
  state.schedulerTimer = null;
  state.scheduleSession++;
  state.playheadBeat = 0;
  dom.playBtn.textContent = "▶";
  setEngineStatus("ENGINE READY", "active");
  updateTransportReadout();
  renderPlaylist();
}

function seekToBeat(beat) {
  const target = clamp(snapBeat(beat), 0, CONFIG.beats);
  state.playheadBeat = target;

  if (state.isPlaying && state.audioContext) {
    stopAllScheduledSources();
    state.scheduleSession++;
    state.playAnchorBeat = target;
    state.playAnchorContextTime = state.audioContext.currentTime + 0.025;
    scheduleLoop();
  }

  updateTransportReadout();
  renderPlaylist();
}

function scheduleLoop() {
  if (!state.isPlaying || !state.audioContext) return;

  const now = state.audioContext.currentTime;
  const session = state.scheduleSession;
  const currentBeat = getCurrentPlayheadBeat();
  state.playheadBeat = currentBeat;

  const horizonBeat = currentBeat + secondsToBeats(CONFIG.scheduleAheadTime);

  for (const clip of state.clips) {
    const clipStart = clip.startBeat;
    const clipEnd = clip.startBeat + clip.lengthBeats;
    if (clipStart > horizonBeat || clipEnd < currentBeat) continue;

    const key = `${session}:${clip.id}`;
    if (state.scheduledSources.has(key)) continue;

    const sample = state.samples.get(clip.sampleId);
    const track = getTrack(clip.trackId);

    if (!sample?.buffer || !track?.audio) continue;

    const offsetBeats = Math.max(0, currentBeat - clipStart);
    const offsetSeconds = beatsToSeconds(offsetBeats);
    const sourceTime = now + Math.max(0, beatsToSeconds(clipStart - currentBeat));

    if (offsetSeconds >= sample.buffer.duration / clip.playbackRate) continue;

    const source = state.audioContext.createBufferSource();
    source.buffer = sample.buffer;
    source.playbackRate.setValueAtTime(clip.playbackRate, sourceTime);
    source.connect(track.audio.input);

    const available = Math.max(0.01, sample.buffer.duration - offsetSeconds * clip.playbackRate);
    try {
      source.start(sourceTime, offsetSeconds, available);
    } catch (err) {
      console.warn("Could not schedule source", err);
      continue;
    }

    source.onended = () => state.scheduledSources.delete(key);
    state.scheduledSources.set(key, source);

    setTimeout(() => {
      const node = dom.laneArea.querySelector(`[data-clip-id="${clip.id}"]`);
      node?.classList.add("playing");
      setTimeout(() => node?.classList.remove("playing"), Math.max(40, available * 1000));
    }, Math.max(0, (sourceTime - now) * 1000));
  }

  state.schedulerTimer = window.setTimeout(() => scheduleLoop(), CONFIG.lookaheadMs);
}

function updateUiFrame() {
  if (state.isPlaying) {
    state.playheadBeat = getCurrentPlayheadBeat();

    if (state.playheadBeat >= CONFIG.beats) {
      stopTransport();
    }
  }

  const playhead = dom.laneArea.querySelector(".playhead");
  if (playhead) {
    playhead.style.left = `${state.playheadBeat * state.zoom}px`;
  }

  updateTransportReadout();
  state.rafId = requestAnimationFrame(updateUiFrame);
}

function bindInspectorEvents() {
  dom.pitchSlider.addEventListener("input", ev => updateSelectedClipPitch(parseFloat(ev.target.value)));

  const bindFx = (input, label, key, formatter) => {
    input.addEventListener("input", async ev => {
      const track = getTrack(state.selectedTrackId);
      if (!track) return;
      track.fx[key] = parseFloat(ev.target.value);
      label.textContent = formatter(track.fx[key]);
      if (!state.audioContext) await ensureAudioContext();
      if (!track.audio) createTrackChain(track);
      syncTrackFx(track);
    });
  };

  bindFx(dom.eqLow, dom.eqLowValue, "eqLow", v => `${v.toFixed(1)} dB`);
  bindFx(dom.eqPeak, dom.eqPeakValue, "eqPeak", v => `${v.toFixed(1)} dB`);
  bindFx(dom.eqHigh, dom.eqHighValue, "eqHigh", v => `${v.toFixed(1)} dB`);
  bindFx(dom.drive, dom.driveValue, "drive", v => `${Math.round(v)}%`);
  bindFx(dom.chorus, dom.chorusValue, "chorus", v => `${Math.round(v * 100)}%`);
  bindFx(dom.reverb, dom.reverbValue, "reverb", v => `${Math.round(v * 100)}%`);
}

function bindUi() {
  dom.playBtn.addEventListener("click", startTransport);
  dom.stopBtn.addEventListener("click", stopTransport);
  dom.rewindBtn.addEventListener("click", () => seekToBeat(0));

  dom.tempoInput.addEventListener("change", () => {
    const newTempo = clamp(parseFloat(dom.tempoInput.value) || 140, 40, 240);

    if (state.isPlaying && state.audioContext) {
      state.playheadBeat = getCurrentPlayheadBeat();
      state.playAnchorBeat = state.playheadBeat;
      state.playAnchorContextTime = state.audioContext.currentTime + 0.02;
      stopAllScheduledSources();
      state.scheduleSession++;
    }

    state.tempo = newTempo;
    dom.tempoInput.value = String(newTempo);
    updateTransportReadout();
  });

  dom.masterVolume.addEventListener("input", async () => {
    updateMasterReadout();
    try {
      await ensureAudioContext();
      state.masterGain.gain.setTargetAtTime(parseFloat(dom.masterVolume.value), state.audioContext.currentTime, 0.01);
    } catch (err) {
      console.error(err);
    }
  });

  dom.loadSamplesBtn.addEventListener("click", () => preloadSamples());
  dom.refreshSamplesBtn.addEventListener("click", () => preloadSamples());

  dom.addTrackBtn.addEventListener("click", () => addTrack());

  dom.snapSelect.addEventListener("change", () => {
    state.snap = parseFloat(dom.snapSelect.value);
  });

  dom.zoomOutBtn.addEventListener("click", () => {
    state.zoom = clamp(state.zoom - 8, 24, 120);
    renderPlaylist();
  });

  dom.zoomInBtn.addEventListener("click", () => {
    state.zoom = clamp(state.zoom + 8, 24, 120);
    renderPlaylist();
  });

  dom.clearPlaylistBtn.addEventListener("click", () => {
    stopAllScheduledSources();
    state.clips = [];
    state.selectedClipId = null;
    renderPlaylist();
    syncInspectorFromSelection();
  });

  dom.laneArea.addEventListener("click", ev => {
    if (ev.target.closest(".clip")) return;
    const bounds = dom.laneArea.getBoundingClientRect();
    const x = ev.clientX - bounds.left + dom.playlistViewport.scrollLeft;
    seekToBeat(x / state.zoom);
  });

  dom.laneArea.addEventListener("dragover", onLaneDragOver);
  dom.laneArea.addEventListener("dragleave", onLaneDragLeave);
  dom.laneArea.addEventListener("drop", onLaneDrop);
  dom.laneArea.addEventListener("dblclick", onLaneDoubleClick);

  document.addEventListener("keydown", ev => {
    if (ev.code === "Space" && !["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) {
      ev.preventDefault();
      startTransport();
    }

    if (ev.key === "Delete" && state.selectedClipId) {
      state.clips = state.clips.filter(c => c.id !== state.selectedClipId);
      state.selectedClipId = null;
      renderPlaylist();
      syncInspectorFromSelection();
    }
  });

  bindInspectorEvents();
}

function initializeDom() {
  dom.playBtn = qs("playBtn");
  dom.stopBtn = qs("stopBtn");
  dom.rewindBtn = qs("rewindBtn");
  dom.tempoInput = qs("tempoInput");
  dom.timeDisplay = qs("timeDisplay");
  dom.beatDisplay = qs("beatDisplay");
  dom.masterVolume = qs("masterVolume");
  dom.masterVolumeValue = qs("masterVolumeValue");
  dom.loadSamplesBtn = qs("loadSamplesBtn");
  dom.refreshSamplesBtn = qs("refreshSamplesBtn");
  dom.engineStatus = qs("engineStatus");
  dom.trackList = qs("trackList");
  dom.sampleList = qs("sampleList");
  dom.addTrackBtn = qs("addTrackBtn");
  dom.playlistViewport = qs("playlistViewport");
  dom.playlistContent = qs("playlistContent");
  dom.ruler = qs("ruler");
  dom.laneArea = qs("laneArea");
  dom.snapSelect = qs("snapSelect");
  dom.zoomOutBtn = qs("zoomOutBtn");
  dom.zoomInBtn = qs("zoomInBtn");
  dom.zoomValue = qs("zoomValue");
  dom.clearPlaylistBtn = qs("clearPlaylistBtn");
  dom.cursorStatus = qs("cursorStatus");
  dom.selectionStatus = qs("selectionStatus");
  dom.selectedClipLabel = qs("selectedClipLabel");
  dom.pitchSlider = qs("pitchSlider");
  dom.pitchValue = qs("pitchValue");
  dom.eqLow = qs("eqLow");
  dom.eqLowValue = qs("eqLowValue");
  dom.eqPeak = qs("eqPeak");
  dom.eqPeakValue = qs("eqPeakValue");
  dom.eqHigh = qs("eqHigh");
  dom.eqHighValue = qs("eqHighValue");
  dom.drive = qs("drive");
  dom.driveValue = qs("driveValue");
  dom.chorus = qs("chorus");
  dom.chorusValue = qs("chorusValue");
  dom.reverb = qs("reverb");
  dom.reverbValue = qs("reverbValue");
}

function initialize() {
  initializeDom();
  state.tempo = parseFloat(dom.tempoInput.value);
  createInitialTracks();
  renderTracks();
  renderSamples();
  renderPlaylist();
  updateMasterReadout();
  updateTransportReadout();
  syncInspectorFromSelection();
  setSelectedSampleLabel();
  bindUi();
  updateUiFrame();
}

initialize();
