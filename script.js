
'use strict';

const STEPS = 16;         
const LOOKAHEAD = 0.12;    
const TIMER_MS = 25;      
const SWEEP_BARS = 12;     

const TRACKS = [
  { id: 's1',    rowId: 'seq-row-s1',       label: 'SYNTH1', source: 'synth1', channel: 'ch-s1' },
  { id: 's2',    rowId: 'seq-row-s2',       label: 'SYNTH2', source: 'synth2', channel: 'ch-s2' },
  { id: 'kick',  rowId: 'seq-row-dr-kick',  label: 'KICK',   source: 'drums',  channel: 'ch-dr', rowClass: 'seq-row-dr' },
  { id: 'snare', rowId: 'seq-row-dr-snare', label: 'SNARE',  source: 'drums',  channel: 'ch-dr', rowClass: 'seq-row-dr' },
  { id: 'hat',   rowId: 'seq-row-dr-hat',   label: 'HAT',    source: 'drums',  channel: 'ch-dr', rowClass: 'seq-row-dr' },
];


const COLOR_KEYS  = ['off', 'red', 'yellow', 'green'];
const COLOR_NAMES = ['выключено', 'красный', 'жёлтый', 'зелёный'];


const NOTE_INDEX = { 'C': 0, 'C#': 1, 'D': 2, 'D#': 3, 'E': 4, 'F': 5, 'F#': 6, 'G': 7, 'G#': 8, 'A': 9, 'A#': 10, 'B': 11 };
function noteToMidi(name) {
  const m = name.match(/^([A-G]#?)(\d)$/);
  return 12 * (Number(m[2]) + 1) + NOTE_INDEX[m[1]];
}
const midiToFreq = midi => 440 * Math.pow(2, (midi - 69) / 12);


const ARP_CYCLE = ['C3', 'E3', 'G3', 'B3', 'C4', 'B3', 'G3', 'E3'].map(noteToMidi);
const S1_VELOCITY = [0, 0.8, 1.0, 0.7];     // громкость по цвету
const S1_BRIGHT   = [1, 1.0, 1.35, 1.0];    // яркость фильтра по цвету


const S2_NOTE_BY_COLOR = [null, 'C2', 'E2', 'G2'].map(n => n && noteToMidi(n));

const VELOCITY_BY_COLOR = [0, 1, 0.62, 0.34];

const VOICE = {
  synth1: { cutoff: 3000, q: 2.5, attack: 0.006, release: 0.09, level: 0.16, detune: 9, pluck: 1.5, pluckTime: 0.12, keytrack: 0.5, sustain: 1,   decay: 0 },
  synth2: { cutoff: 520,  q: 3,   attack: 0.004, release: 0.55, level: 0.26, detune: 6, pluck: 3.2, pluckTime: 0.25, keytrack: 0.3, sustain: 0.5, decay: 0.45 },
};


const state = {
  tempo: 84,                               
  master: 0.5,
  synth1: { wave: 'square' },                 
  synth2: { wave: 'sawtooth' },
  'ch-s1': { volume: 0.55, pan: 0.4 },
  'ch-s2': { volume: 0.5,  pan: 0.6 },
  'ch-dr': { volume: 0.6,  pan: 0.5 },
  'fx-distortion': 0.08,
  'fx-delay': 0.3,
  'fx-reverb': 0.35,
  'fx-glitch': 0.06,
};

const pattern = {
  s1:    [2,1,1,1, 1,1,1,1, 2,1,1,1, 1,1,1,1],  
  s2:    [1,0,1,0, 0,0,0,0, 2,0,2,0, 0,0,0,0],   
  kick:  [1,0,2,0, 0,0,0,0, 1,0,2,0, 0,0,0,0],   
  snare: [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0],  
  hat:   [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0],
};

function getParam(path) { return path.split('.').reduce((o, k) => o[k], state); }
function setParam(path, value) {
  const keys = path.split('.'); const last = keys.pop();
  keys.reduce((o, k) => o[k], state)[last] = value;
}


let audio = null;  

function ensureAudio() {
  if (!audio) { audio = buildAudioGraph(); applyAllParams(); }
  return audio.ctx.state === 'suspended' ? audio.ctx.resume() : Promise.resolve();
}

function buildAudioGraph() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();

  const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

  const bus = ctx.createGain();               
  const master = ctx.createGain();                  
  const limiter = ctx.createDynamicsCompressor();    
  limiter.threshold.value = -16; limiter.ratio.value = 4;

  const fx = {
    'fx-distortion': createDistortion(ctx),
    'fx-delay':      createDelay(ctx),
    'fx-reverb':     createReverb(ctx),
    'fx-glitch':     createGlitch(ctx),
  };


  bus.connect(fx['fx-distortion'].input);
  fx['fx-distortion'].output.connect(fx['fx-delay'].input);
  fx['fx-delay'].output.connect(fx['fx-reverb'].input);
  fx['fx-reverb'].output.connect(fx['fx-glitch'].input);
  fx['fx-glitch'].output.connect(master);
  master.connect(limiter);
  limiter.connect(ctx.destination);

  const channels = {};
  ['ch-s1', 'ch-s2', 'ch-dr'].forEach(name => { channels[name] = createChannel(ctx, bus); });

  return { ctx, bus, master, channels, fx, noise };
}

function createChannel(ctx, bus) {
  const input = ctx.createGain();
  const panner = ctx.createStereoPanner();
  const volume = ctx.createGain();
  const analyser = ctx.createAnalyser(); analyser.fftSize = 128;
  input.connect(panner); panner.connect(volume); volume.connect(bus); volume.connect(analyser);
  return { input, panner, volume, analyser };
}

function createDistortion(ctx) {
  const input = ctx.createGain(), output = ctx.createGain();
  const dry = ctx.createGain(), wet = ctx.createGain();
  const drive = ctx.createGain(), shaper = ctx.createWaveShaper(), post = ctx.createGain();
  const curve = new Float32Array(2048);
  for (let i = 0; i < curve.length; i++) { const x = i * 2 / curve.length - 1; curve[i] = Math.tanh(2.5 * x) / Math.tanh(2.5); }
  shaper.curve = curve; shaper.oversample = '4x'; post.gain.value = 0.55;
  input.connect(dry); dry.connect(output);
  input.connect(drive); drive.connect(shaper); shaper.connect(post); post.connect(wet); wet.connect(output);
  return { input, output, set(a) { drive.gain.value = 1 + a * 6; wet.gain.value = a; dry.gain.value = 1 - a * 0.7; } };
}

function createDelay(ctx) {
  const input = ctx.createGain(), output = ctx.createGain();
  const dry = ctx.createGain(), wet = ctx.createGain();
  const line = ctx.createDelay(2), feedback = ctx.createGain(), tone = ctx.createBiquadFilter();
  tone.type = 'lowpass'; tone.frequency.value = 2200;      
  input.connect(dry); dry.connect(output);
  input.connect(line); line.connect(wet); wet.connect(output);
  line.connect(tone); tone.connect(feedback); feedback.connect(line);
  return {
    input, output,
    set(a) { wet.gain.value = a * 0.7; feedback.gain.value = 0.2 + a * 0.35; },
    setTempo(bpm) { line.delayTime.value = 60 / bpm * 0.75; }   
  };
}

function createReverb(ctx) {
  const input = ctx.createGain(), output = ctx.createGain();
  const dry = ctx.createGain(), wet = ctx.createGain(), room = ctx.createConvolver(), tone = ctx.createBiquadFilter();
  const len = Math.floor(ctx.sampleRate * 3.2), ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6); }
  room.buffer = ir;
  tone.type = 'lowpass'; tone.frequency.value = 3800;        
  input.connect(dry); dry.connect(output);
  input.connect(room); room.connect(tone); tone.connect(wet); wet.connect(output);
  return { input, output, set(a) { wet.gain.value = a * 1.1; } };
}


function createGlitch(ctx) {
  const input = ctx.createGain(), output = ctx.createGain(), gate = ctx.createGain();
  const lfo = ctx.createOscillator(), depth = ctx.createGain();
  lfo.type = 'square'; lfo.frequency.value = 8; lfo.connect(depth); depth.connect(gate.gain); lfo.start();
  input.connect(gate); gate.connect(output);
  return {
    input, output,
    set(a) { const d = a * 0.9; depth.gain.value = d / 2; gate.gain.value = 1 - d / 2; },
    setTempo(bpm) { lfo.frequency.value = bpm / 60 * 4; }       
  };
}

function applyParam(path) {
  if (!audio) return;
  const { channels, fx, master } = audio;
  if (path === 'tempo') { fx['fx-delay'].setTempo(state.tempo); fx['fx-glitch'].setTempo(state.tempo); }
  else if (path === 'master') master.gain.value = Math.pow(state.master, 1.5);
  else if (path.startsWith('ch-')) {
    const [ch, prop] = path.split('.');
    if (prop === 'volume') channels[ch].volume.gain.value = Math.pow(state[ch].volume, 1.6);
    if (prop === 'pan')    channels[ch].panner.pan.value = state[ch].pan * 2 - 1;
  }
  else if (fx[path]) fx[path].set(state[path]);
}
function applyAllParams() {
  ['tempo', 'master', 'ch-s1.volume', 'ch-s1.pan', 'ch-s2.volume', 'ch-s2.pan', 'ch-dr.volume', 'ch-dr.pan',
   'fx-distortion', 'fx-delay', 'fx-reverb', 'fx-glitch'].forEach(applyParam);
}


let sweepOrigin = 0;
function sweepAt(time) {
  const bars = (time - sweepOrigin) / (stepSeconds() * STEPS);
  return 0.3 + 0.7 * (0.5 - 0.5 * Math.cos(2 * Math.PI * bars / SWEEP_BARS));
}


function playSynthNote(source, midi, time, duration, opts = {}) {
  const { ctx, channels } = audio;
  const v = VOICE[source], channel = source === 'synth1' ? 'ch-s1' : 'ch-s2';
  const freq = midiToFreq(midi), vel = opts.velocity ?? 1;
  const end = time + Math.max(duration, v.attack + 0.01);

  const sweep = source === 'synth1' ? sweepAt(time) : 1;
  const cutoff = Math.min(12000, v.cutoff * sweep * Math.pow(freq / 261.63, v.keytrack) * (opts.bright ?? 1));

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass'; filter.Q.value = v.q;
  filter.frequency.setValueAtTime(cutoff * v.pluck, time);                         
  filter.frequency.exponentialRampToValueAtTime(cutoff, time + v.pluckTime);

  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0, time);
  amp.gain.linearRampToValueAtTime(1, time + v.attack);
  if (v.sustain < 1) amp.gain.setTargetAtTime(v.sustain, time + v.attack, v.decay / 3);   
  amp.gain.setTargetAtTime(0, end, v.release / 3);                                       
  filter.connect(amp); amp.connect(channels[channel].input);

  [-v.detune, v.detune].forEach(cents => {
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = state[source].wave; osc.frequency.value = freq; osc.detune.value = cents;
    g.gain.value = v.level * vel;
    osc.connect(g); g.connect(filter);
    osc.start(time); osc.stop(end + v.release * 1.6 + 0.1);
  });
}

function drumEnv(g, t, peak, dur) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
}

function playKick(t, vel) {
  const { ctx, channels } = audio, o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.setValueAtTime(115, t); o.frequency.exponentialRampToValueAtTime(44, t + 0.13);
  drumEnv(g, t, 0.95 * vel, 0.55);
  o.connect(g); g.connect(channels['ch-dr'].input); o.start(t); o.stop(t + 0.6);
}
function playNoiseHit(t, type, freq, q, peak, dur) {
  const { ctx, channels, noise } = audio;
  const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  src.buffer = noise; f.type = type; f.frequency.value = freq; f.Q.value = q;
  drumEnv(g, t, peak, dur);
  src.connect(f); f.connect(g); g.connect(channels['ch-dr'].input); src.start(t, Math.random() * 1.5, dur + 0.05);
}
function playSnare(t, vel) {
  const { ctx, channels } = audio;
  playNoiseHit(t, 'bandpass', 1900, 0.8, 0.55 * vel, 0.22);
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'triangle'; o.frequency.setValueAtTime(200, t); o.frequency.exponentialRampToValueAtTime(140, t + 0.1);
  drumEnv(g, t, 0.4 * vel, 0.14); o.connect(g); g.connect(channels['ch-dr'].input); o.start(t); o.stop(t + 0.2);
}
function playHat(t, vel) { playNoiseHit(t, 'highpass', 7000, 0.7, 0.3 * vel, 0.06); }

const DRUM_PLAYERS = { kick: playKick, snare: playSnare, hat: playHat };


let isPlaying = false, currentStep = 0, nextStepTime = 0, timerId = null;
const drawQueue = []; 

const stepSeconds = () => 60 / state.tempo / 4;


function bassMidiAt(step) {
  for (let d = 0; d < STEPS; d++) {
    const c = pattern.s2[(step - d + STEPS) % STEPS];
    if (c) return S2_NOTE_BY_COLOR[c];
  }
  return null;
}


function arpMidiFor(step, color) {
  let midi = ARP_CYCLE[step % ARP_CYCLE.length];
  const bass = bassMidiAt(step);
  if (step % ARP_CYCLE.length === 0 && bass !== null && bass % 12 === 4) midi -= 1;
  if (color === 3) midi += 12;                                                        
  return midi;
}


function noteLength(track, step) {
  if (track === 's1') return stepSeconds() * 0.85;
  for (let d = 1; d <= STEPS; d++) if (pattern.s2[(step + d) % STEPS]) return stepSeconds() * d * 0.98;
  return stepSeconds() * STEPS;
}

function playTrackStep(trackId, step, color, time, length) {
  if (trackId === 's1') playSynthNote('synth1', arpMidiFor(step, color), time, length, { velocity: S1_VELOCITY[color], bright: S1_BRIGHT[color] });
  else if (trackId === 's2') playSynthNote('synth2', S2_NOTE_BY_COLOR[color], time, length);
  else DRUM_PLAYERS[trackId](time, VELOCITY_BY_COLOR[color]);
}

function scheduleStep(step, time) {
  TRACKS.forEach(t => {
    const color = pattern[t.id][step];
    if (color) playTrackStep(t.id, step, color, time, noteLength(t.id, step));
  });
}

function scheduler() {
  while (nextStepTime < audio.ctx.currentTime + LOOKAHEAD) {
    scheduleStep(currentStep, nextStepTime);
    drawQueue.push({ step: currentStep, time: nextStepTime });
    nextStepTime += stepSeconds();
    currentStep = (currentStep + 1) % STEPS;
  }
}

async function togglePlay() {
  await ensureAudio();
  if (isPlaying) {
    clearInterval(timerId); isPlaying = false; drawQueue.length = 0; showStep(-1);
  } else {
    isPlaying = true; currentStep = 0; nextStepTime = audio.ctx.currentTime + 0.06;
    sweepOrigin = nextStepTime;                       
    timerId = setInterval(scheduler, TIMER_MS);
  }
  updatePlayButton();
}


const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];


function paintSlider(input) {
  const k = (input.value - input.min) / (input.max - input.min);
  input.style.setProperty('--k', k);
}
$$('input[data-param]').forEach(input => {
  const path = input.dataset.param;
  input.value = getParam(path);
  paintSlider(input);
  input.addEventListener('input', () => {
    setParam(path, Number(input.value));
    paintSlider(input);
    if (path === 'tempo') $('#tempo-value').textContent = state.tempo;
    applyParam(path);
  });
});
$('#tempo-value').textContent = state.tempo;


$$('.wave-group').forEach(group => {
  const synth = group.dataset.synth;
  const buttons = $$('.wave-btn', group);
  const refresh = () => buttons.forEach(b => b.setAttribute('aria-pressed', b.dataset.wave === state[synth].wave));
  buttons.forEach(b => b.addEventListener('click', () => {
    state[synth].wave = b.dataset.wave; refresh();
    ensureAudio().then(() => previewTrack(synth === 'synth1' ? 's1' : 's2', 0, 1));   
  }));
  refresh();
});


function updatePlayButton() {
  $('#btn-play').setAttribute('aria-pressed', isPlaying);
  $('#btn-play-label').textContent = isPlaying ? 'Закрыть врата' : 'Открыть врата';
  $('#btn-play-icon').innerHTML = isPlaying
    ? '<rect x="5" y="5" width="14" height="14" rx="2" />'
    : '<polygon points="5,3 21,12 5,21" />';
}
$('#btn-play').addEventListener('click', togglePlay);


const cellEls = {};   
function buildGrid() {
  const grid = $('#seq-grid');
  TRACKS.forEach(track => {
    const row = document.createElement('div');
    row.id = track.rowId;
    row.className = 'seq__row' + (track.rowClass ? ' ' + track.rowClass : '');
    row.innerHTML = `<span class="seq__label">${track.label}</span><div class="seq__cells"></div>`;
    const cells = $('.seq__cells', row);
    cellEls[track.id] = [];
    for (let i = 0; i < STEPS; i++) {
      const cell = document.createElement('button');
      cell.type = 'button'; cell.className = 'seq__cell';
      cell.addEventListener('click', () => {
        pattern[track.id][i] = (pattern[track.id][i] + 1) % 4;    
        paintCell(track.id, i);
        if (pattern[track.id][i]) ensureAudio().then(() => previewTrack(track.id, i, pattern[track.id][i]));
      });
      cells.appendChild(cell); cellEls[track.id].push(cell); paintCell(track.id, i);
    }
    grid.appendChild(row);
  });
}
function paintCell(trackId, step) {
  const c = pattern[trackId][step], cell = cellEls[trackId][step];
  cell.dataset.color = COLOR_KEYS[c];
  cell.setAttribute('aria-label', `${TRACKS.find(t => t.id === trackId).label}, шаг ${step + 1}: ${COLOR_NAMES[c]}`);
}
buildGrid();


function previewTrack(trackId, step, color) {
  playTrackStep(trackId, step, color, audio.ctx.currentTime + 0.01, stepSeconds() * 1.5);
}


const pulse = $('#seq-pulse');
function showStep(step) {
  TRACKS.forEach(t => cellEls[t.id].forEach((cell, i) => cell.classList.toggle('is-current', i === step)));
  if (step >= 0 && step % 4 === 0) { pulse.classList.add('is-on'); setTimeout(() => pulse.classList.remove('is-on'), 110); }
}


const canvas = $('#drums-visualizer'), g2d = canvas.getContext('2d');
const freqData = new Uint8Array(64);
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr; canvas.height = canvas.clientHeight * dpr;
}
window.addEventListener('resize', resizeCanvas); resizeCanvas();

function drawVisualizer(now) {
  const w = canvas.width, h = canvas.height, bars = 56, slot = w / bars, bw = slot * 0.55;
  g2d.clearRect(0, 0, w, h); g2d.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--yellow');
  if (audio) audio.channels['ch-dr'].analyser.getByteFrequencyData(freqData);
  for (let i = 0; i < bars; i++) {
    const live = audio ? freqData[Math.floor(i * 0.9)] / 255 : 0;
    const idle = 0.18 + 0.12 * Math.abs(Math.sin(i * 1.7 + now / 900)) * (i % 2 ? 1 : 0.5); 
    const bh = Math.max(idle, live) * h * 0.9;
    g2d.fillRect(i * slot + (slot - bw) / 2, h - bh - h * 0.05, bw, bh);
  }
}


function frame(now) {
  if (audio) {
    while (drawQueue.length && drawQueue[0].time <= audio.ctx.currentTime) showStep(drawQueue.shift().step);
    if (drawQueue.length > 64) drawQueue.splice(0, drawQueue.length - 8);
  }
  drawVisualizer(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
