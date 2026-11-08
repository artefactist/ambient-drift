// Ambient engine: the Web Audio graph for an 11-channel ambient instrument.
// Classic script, no modules or libraries. The AudioContext is created in
// start() only, never at load, so audio begins on a user gesture.
//
// Graph:
//   channel input -> level gain -> stereo panner -> mute/solo gain -> master gain
//                                        \-> analyser (meter)
//                                        \-> send gain -> convolver -> reverb return -> master gain
//   master gain -> compressor (limiter) -> destination
(function () {
  "use strict";

  window.Ambient = window.Ambient || {};

  const DEFAULT_MASTER = 0.2;
  const DEFAULT_REVERB = 0.3;
  const DEFAULT_LEVEL = 0.8;
  const DEFAULT_SEND = 0.25;
  const FADE_SECONDS = 1.5;
  const SMOOTH = 0.03; // time constant for setTargetAtTime, in seconds
  const CHANNELS = 11;
  const IMPULSE_SECONDS = 5;

  let ctx = null;
  let running = false;
  let built = false;
  let stopToken = 0;
  let masterLevel = DEFAULT_MASTER;
  let reverbLevel = DEFAULT_REVERB;
  let masterGain = null;
  let limiter = null;
  let convolver = null;
  let reverbReturn = null;
  const strips = [];

  function clamp(v, lo, hi) {
    v = Number(v);
    if (!isFinite(v)) return lo;
    return Math.min(hi, Math.max(lo, v));
  }

  // Glide an AudioParam to a value without clicks.
  function glide(param, value) {
    if (!ctx || !param) return;
    const t = ctx.currentTime;
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
    param.setTargetAtTime(value, t, SMOOTH);
  }

  // Linear fade of an AudioParam over a set duration.
  function fade(param, value, seconds) {
    const t = ctx.currentTime;
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
    param.linearRampToValueAtTime(value, t + seconds);
  }

  // Stereo decaying noise, generated in code: no audio files are loaded.
  function makeImpulse() {
    const rate = ctx.sampleRate;
    const length = Math.floor(rate * IMPULSE_SECONDS);
    const buffer = ctx.createBuffer(2, length, rate);
    for (let c = 0; c < 2; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < length; i++) {
        const t = i / length;
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 3);
      }
    }
    return buffer;
  }

  function anySolo() {
    return strips.some(function (s) { return s && s.state.solo; });
  }

  // Mute wins; otherwise, when any channel is soloed, only soloed ones sound.
  function gateValue(state, soloActive) {
    if (state.mute) return 0;
    if (soloActive && !state.solo) return 0;
    return 1;
  }

  function updateGates() {
    const soloActive = anySolo();
    strips.forEach(function (s) {
      if (s && s.nodes) glide(s.nodes.gate.gain, gateValue(s.state, soloActive));
    });
  }

  function buildStrip(strip) {
    const level = ctx.createGain();
    const panner = ctx.createStereoPanner();
    const gate = ctx.createGain();
    const send = ctx.createGain();
    const analyser = ctx.createAnalyser();
    const input = ctx.createGain();

    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.6;

    level.gain.value = strip.state.level;
    panner.pan.value = strip.state.pan;
    gate.gain.value = gateValue(strip.state, anySolo());
    send.gain.value = strip.state.send;

    input.connect(level);
    level.connect(panner);
    panner.connect(gate);
    gate.connect(masterGain);
    gate.connect(send);
    gate.connect(analyser);
    send.connect(convolver);

    strip.nodes = { level: level, panner: panner, gate: gate, send: send, analyser: analyser };
    strip.samples = new Float32Array(analyser.fftSize);
    strip.input = input;
  }

  function makeStrip() {
    const strip = {
      input: null, // GainNode, available once start() has built the graph
      state: { level: DEFAULT_LEVEL, pan: 0, mute: false, solo: false, send: DEFAULT_SEND },
      nodes: null,
      samples: null,
      setLevel: function (v) {
        strip.state.level = clamp(v, 0, 1);
        if (strip.nodes) glide(strip.nodes.level.gain, strip.state.level);
      },
      setPan: function (v) {
        strip.state.pan = clamp(v, -1, 1);
        if (strip.nodes) glide(strip.nodes.panner.pan, strip.state.pan);
      },
      setMute: function (on) {
        strip.state.mute = !!on;
        updateGates();
      },
      setSolo: function (on) {
        strip.state.solo = !!on;
        updateGates();
      },
      setSend: function (v) {
        strip.state.send = clamp(v, 0, 1);
        if (strip.nodes) glide(strip.nodes.send.gain, strip.state.send);
      },
      meter: function () {
        if (!strip.nodes) return 0;
        const buf = strip.samples;
        strip.nodes.analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        return clamp(Math.sqrt(sum / buf.length), 0, 1);
      }
    };
    return strip;
  }

  function buildGraph() {
    if (built) return;
    masterGain = ctx.createGain();
    masterGain.gain.value = 0;

    // Limiter: low threshold, hard knee, high ratio, fast attack.
    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;

    convolver = ctx.createConvolver();
    convolver.buffer = makeImpulse();
    reverbReturn = ctx.createGain();
    reverbReturn.gain.value = reverbLevel;

    convolver.connect(reverbReturn);
    reverbReturn.connect(masterGain);
    masterGain.connect(limiter);
    limiter.connect(ctx.destination);

    for (let n = 1; n <= CHANNELS; n++) buildStrip(getStrip(n));
    built = true;
  }

  function getStrip(n) {
    const i = Math.floor(Number(n));
    if (!(i >= 1 && i <= CHANNELS)) return null;
    if (!strips[i]) strips[i] = makeStrip();
    return strips[i];
  }

  window.Ambient.engine = {
    start: function () {
      stopToken++; // cancels any pending suspend from stop()
      if (!ctx) {
        ctx = window.AudioContext ? new AudioContext() : new window.webkitAudioContext();
      }
      buildGraph();
      const wasRunning = running;
      running = true;
      const resumed = ctx.state === "suspended" ? ctx.resume() : Promise.resolve();
      return resumed.then(function () {
        if (!wasRunning || masterGain.gain.value < masterLevel) {
          fade(masterGain.gain, masterLevel, FADE_SECONDS);
        }
      });
    },

    stop: function () {
      if (!ctx || !running) return Promise.resolve();
      running = false;
      const token = ++stopToken;
      fade(masterGain.gain, 0, FADE_SECONDS);
      return new Promise(function (resolve) {
        setTimeout(function () {
          if (token !== stopToken) { resolve(); return; } // restarted meanwhile
          ctx.suspend().then(resolve, resolve);
        }, FADE_SECONDS * 1000 + 50);
      });
    },

    isRunning: function () {
      return running;
    },

    context: function () {
      return ctx;
    },

    now: function () {
      return ctx ? ctx.currentTime : 0;
    },

    setMasterVolume: function (v) {
      masterLevel = clamp(v, 0, 1);
      if (ctx && running) glide(masterGain.gain, masterLevel);
    },

    setReverb: function (v) {
      reverbLevel = clamp(v, 0, 1);
      if (reverbReturn) glide(reverbReturn.gain, reverbLevel);
    },

    channel: function (n) {
      return getStrip(n);
    }
  };
})();
