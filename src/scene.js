// Shared musical state for the ambient instrument. Voices call notes() and
// freq() constantly, so both avoid allocation-heavy work where they can.
(function () {
  'use strict';

  window.Ambient = window.Ambient || {};

  const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  const MODES = {
    ionian: [0, 2, 4, 5, 7, 9, 11],
    dorian: [0, 2, 3, 5, 7, 9, 10],
    lydian: [0, 2, 4, 6, 7, 9, 11],
    mixolydian: [0, 2, 4, 5, 7, 9, 10],
    aeolian: [0, 2, 3, 5, 7, 8, 10],
    majorPentatonic: [0, 2, 4, 7, 9],
    minorPentatonic: [0, 3, 5, 7, 10]
  };

  // Modes a gentle drift may move to from each mode: neighbours in brightness,
  // with each pentatonic paired to the diatonic mode it sits inside.
  const NEIGHBOURS = {
    lydian: ['ionian'],
    ionian: ['lydian', 'mixolydian', 'majorPentatonic'],
    mixolydian: ['ionian', 'dorian'],
    dorian: ['mixolydian', 'aeolian', 'minorPentatonic'],
    aeolian: ['dorian', 'minorPentatonic'],
    majorPentatonic: ['ionian'],
    minorPentatonic: ['aeolian', 'dorian']
  };

  const TEMPO_MIN = 40;
  const TEMPO_MAX = 120;

  const DRIFT_MIN_MS = 60000;
  const DRIFT_MAX_MS = 120000;

  const state = { key: 'C', mode: 'aeolian', density: 0.5, tempo: 72, drifting: false };
  const listeners = [];
  let mask = [];        // mask[pc] is true when pitch class pc is in the scale
  let driftTimer = null;

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  // Rebuild the pitch-class lookup only when key or mode changes.
  function rebuildMask() {
    const root = KEYS.indexOf(state.key);
    const m = new Array(12).fill(false);
    const iv = MODES[state.mode];
    for (let i = 0; i < iv.length; i++) m[(root + iv[i]) % 12] = true;
    mask = m;
  }

  function snapshot() {
    return { key: state.key, mode: state.mode, density: state.density, tempo: state.tempo, drifting: state.drifting };
  }

  function notify() {
    // Copy so a listener may unsubscribe during notification.
    const fns = listeners.slice();
    for (let i = 0; i < fns.length; i++) {
      try { fns[i](snapshot()); } catch (e) { if (window.console) console.error(e); }
    }
  }

  // Apply a partial update; returns true if anything changed.
  function apply(partial) {
    if (!partial || typeof partial !== 'object') return false;
    let changed = false;
    let pitchChanged = false;

    if (typeof partial.key === 'string' && KEYS.indexOf(partial.key) !== -1 && partial.key !== state.key) {
      state.key = partial.key;
      changed = pitchChanged = true;
    }
    if (typeof partial.mode === 'string' && Object.prototype.hasOwnProperty.call(MODES, partial.mode) && partial.mode !== state.mode) {
      state.mode = partial.mode;
      changed = pitchChanged = true;
    }
    if (typeof partial.density === 'number' && isFinite(partial.density)) {
      const d = clamp(partial.density, 0, 1);
      if (d !== state.density) { state.density = d; changed = true; }
    }
    if (typeof partial.tempo === 'number' && isFinite(partial.tempo)) {
      const t = clamp(partial.tempo, TEMPO_MIN, TEMPO_MAX);
      if (t !== state.tempo) { state.tempo = t; changed = true; }
    }

    if (pitchChanged) rebuildMask();
    return changed;
  }

  function pick(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  // One gentle move: usually a fifth up or down, or a neighbouring mode;
  // sometimes a small nudge to density.
  function driftStep() {
    const r = Math.random();
    const partial = {};
    if (r < 0.45) {
      const step = Math.random() < 0.5 ? 7 : 5; // up a fifth, or down a fifth
      partial.key = KEYS[(KEYS.indexOf(state.key) + step) % 12];
    } else if (r < 0.8) {
      partial.mode = pick(NEIGHBOURS[state.mode]);
    } else {
      const nudge = (Math.random() * 0.2 - 0.1);
      partial.density = Math.round(clamp(state.density + nudge, 0, 1) * 100) / 100;
    }
    if (apply(partial)) notify();
  }

  function schedule() {
    const delay = DRIFT_MIN_MS + Math.random() * (DRIFT_MAX_MS - DRIFT_MIN_MS);
    driftTimer = setTimeout(function () {
      driftTimer = null;
      if (!state.drifting) return;
      driftStep();
      if (state.drifting) schedule();
    }, delay);
  }

  rebuildMask();

  Ambient.scene = {
    KEYS: KEYS.slice(),
    MODES: Object.keys(MODES),
    TEMPO_MIN: TEMPO_MIN,
    TEMPO_MAX: TEMPO_MAX,

    get: function () {
      return snapshot();
    },

    set: function (partial) {
      if (apply(partial)) notify();
      return snapshot();
    },

    // Every MIDI note in [lowMidi, highMidi] in the current key and mode, ascending.
    notes: function (lowMidi, highMidi) {
      const lo = Math.ceil(lowMidi);
      const hi = Math.floor(highMidi);
      const out = [];
      for (let n = lo; n <= hi; n++) {
        if (mask[((n % 12) + 12) % 12]) out.push(n);
      }
      return out;
    },

    // Equal temperament from A4 = 440 Hz.
    freq: function (midi) {
      return 440 * Math.pow(2, (midi - 69) / 12);
    },

    onChange: function (fn) {
      if (typeof fn !== 'function') return function () {};
      listeners.push(fn);
      return function () {
        const i = listeners.indexOf(fn);
        if (i !== -1) listeners.splice(i, 1);
      };
    },

    drift: function (on) {
      const want = !!on;
      if (want === state.drifting) return;
      state.drifting = want;
      if (driftTimer !== null) { clearTimeout(driftTimer); driftTimer = null; }
      if (want) schedule();
      notify();
    }
  };
})();
