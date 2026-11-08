/*
 * Ambient voices: eleven generative voices, synthesised entirely from
 * oscillators, gains, filters and generated noise. No samples.
 *
 * Voice i plays on engine channel i + 1. Each voice runs its own small
 * look-ahead loop: a setTimeout tick every TICK_MS that schedules any events
 * falling inside the next LOOKAHEAD seconds on the audio clock, reading the
 * scene's density and tempo afresh each time. Key or mode changes re-voice
 * gently (glides and crossfades), and every voice fades in on start and out
 * on stop so nothing clicks or cuts off abruptly.
 */
(function () {
  'use strict';

  window.Ambient = window.Ambient || {};

  const VOICES = ['drone', 'pad', 'sub', 'shimmer', 'bells', 'pulse', 'wash', 'grain', 'echoes', 'birds', 'drops'];

  const LOOKAHEAD = 1.2;  // seconds of audio scheduled ahead of the clock
  const TICK_MS = 200;    // how often each voice's scheduler wakes
  const FADE_IN = 4;      // seconds
  const FADE_OUT = 5;     // seconds
  const MAX_EVENTS = 64;  // per tick, a guard against runaway catch-up

  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLATS = { Db: 1, Eb: 3, Gb: 6, Ab: 8, Bb: 10, Cb: 11, Fb: 4 };

  // ---------------------------------------------------------------- helpers

  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  // Exponentially distributed gap with the given mean: natural, unmetred spacing.
  const gap = (mean) => -Math.log(1 - Math.random()) * mean;

  function engineContext() {
    try {
      return Ambient.engine && typeof Ambient.engine.context === 'function'
        ? Ambient.engine.context() : null;
    } catch (e) {
      return null;
    }
  }

  function clock(ctx) {
    try {
      const t = Ambient.engine.now();
      if (Number.isFinite(t)) return t;
    } catch (e) { /* fall back to the context's own clock */ }
    return ctx.currentTime;
  }

  function scene() {
    let s = null;
    try { s = Ambient.scene && Ambient.scene.get ? Ambient.scene.get() : null; } catch (e) { s = null; }
    s = s || {};
    const d = Number(s.density);
    const bpm = Number(s.tempo);
    return {
      key: s.key,
      mode: s.mode,
      density: clamp(Number.isFinite(d) ? d : 0.5, 0, 1),
      tempo: clamp(Number.isFinite(bpm) ? bpm : 72, 40, 120)
    };
  }

  // Scale notes from the scene, sorted, within [lo, hi]; never empty.
  function scaleNotes(lo, hi) {
    let n = null;
    try { n = Ambient.scene && Ambient.scene.notes ? Ambient.scene.notes(lo, hi) : null; } catch (e) { n = null; }
    if (Array.isArray(n)) {
      n = n.filter((m) => Number.isFinite(m) && m >= lo && m <= hi).sort((a, b) => a - b);
      if (n.length) return n;
    }
    // Fallback: C major pentatonic, so a missing scene still sounds consonant.
    const out = [];
    for (let m = lo; m <= hi; m++) if ([0, 2, 4, 7, 9].indexOf(m % 12) >= 0) out.push(m);
    return out.length ? out : [lo];
  }

  function hz(midi) {
    let f = NaN;
    try { if (Ambient.scene && Ambient.scene.freq) f = Number(Ambient.scene.freq(midi)); } catch (e) { f = NaN; }
    return Number.isFinite(f) && f > 0 ? f : 440 * Math.pow(2, (midi - 69) / 12);
  }

  // Pitch class of the scene's key, accepting a name ('F#', 'Bb') or a number.
  function rootPc() {
    const k = scene().key;
    if (typeof k === 'number' && Number.isFinite(k)) return ((Math.round(k) % 12) + 12) % 12;
    if (typeof k === 'string') {
      const s = k.trim();
      let i = NAMES.indexOf(s);
      if (i < 0 && Object.prototype.hasOwnProperty.call(FLATS, s)) i = FLATS[s];
      if (i >= 0) return i;
    }
    return scaleNotes(48, 59)[0] % 12;
  }

  // The root between MIDI 36 and 47, confirmed against the scene's scale.
  function droneRoot() {
    const ns = scaleNotes(36, 47);
    const r = 36 + rootPc();
    return ns.indexOf(r) >= 0 ? r : ns[0];
  }

  // Generated white noise, one buffer per context, shared by wash and grain.
  const noiseCache = new WeakMap();
  function noiseBuffer(ctx) {
    let b = noiseCache.get(ctx);
    if (b) return b;
    const len = Math.floor(ctx.sampleRate * 6);
    b = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = b.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    noiseCache.set(ctx, b);
    return b;
  }

  // Pin a parameter at its present value so a new ramp starts from there.
  function hold(param, t) {
    const v = param.value;
    param.cancelScheduledValues(t);
    param.setValueAtTime(v, t);
  }

  // A transient source that stops itself and tidies its nodes away when done.
  function oneShot(src, nodes, stopAt) {
    src.onended = () => {
      try { src.disconnect(); } catch (e) { /* already gone */ }
      nodes.forEach((n) => { try { n.disconnect(); } catch (e) { /* already gone */ } });
    };
    src.stop(stopAt);
  }

  function osc(ctx, type, freq, t) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    return o;
  }

  function gain(ctx, value, t) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(value, t);
    return g;
  }

  function filter(ctx, type, freq, q, t) {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    f.Q.setValueAtTime(q, t);
    return f;
  }

  // Sustained voices keep their long-lived nodes here so stopping is tidy.
  function held() {
    const sources = [];
    const nodes = [];
    return {
      source(s) { sources.push(s); return s; },
      node(n) { nodes.push(n); return n; },
      dispose() {
        sources.forEach((s) => { try { s.stop(); } catch (e) { /* not started */ } });
        sources.concat(nodes).forEach((n) => { try { n.disconnect(); } catch (e) { /* already gone */ } });
        sources.length = 0;
        nodes.length = 0;
      }
    };
  }

  // ----------------------------------------------------------------- voices
  // Each builder returns { schedule(now, horizon), revoice(now), dispose() }.

  // drone: two slightly detuned saws on the root through a wandering low-pass.
  function buildDrone(ctx, out, t) {
    const h = held();
    const lp = h.node(filter(ctx, 'lowpass', 380, 0.7, t));
    lp.connect(out);
    const f = hz(droneRoot());
    const pair = [-7, 7].map((cents) => {
      const o = h.source(osc(ctx, 'sawtooth', f, t));
      o.detune.setValueAtTime(cents, t);
      const g = h.node(gain(ctx, 0.11, t));
      o.connect(g).connect(lp);
      o.start(t);
      return o;
    });
    let next = t + rand(2, 5);
    return {
      schedule(now, horizon) {
        if (next < now) next = now + 0.05;
        if (next >= horizon) return;
        const d = scene().density;
        lp.frequency.setTargetAtTime(220 + Math.random() * (300 + 600 * d), next, rand(3, 6));
        pair.forEach((o, i) => o.detune.setTargetAtTime((i ? 1 : -1) * rand(3, 9), next, 5));
        next += rand(6, 14);
      },
      revoice(now) {
        const nf = hz(droneRoot());
        pair.forEach((o) => o.frequency.setTargetAtTime(nf, now, 1.5));
      },
      dispose: h.dispose
    };
  }

  // pad: a soft 3-4 note chord with long attack and release, renewed every 15-40 s.
  function buildPad(ctx, out, t) {
    const h = held();
    const lp = h.node(filter(ctx, 'lowpass', 1600, 0.5, t));
    lp.connect(out);
    const ATTACK = 7;
    const RELEASE_TC = 2.5;  // time constant: effectively silent after ~12 s
    let current = null;
    let lastChord = -Infinity;
    let next = t;

    function chordNotes() {
      const ns = scaleNotes(48, 74);
      const size = Math.random() < 0.5 ? 3 : 4;
      const top = Math.max(1, ns.length - 2 * (size - 1));
      const i = Math.floor(Math.random() * Math.min(top, Math.ceil(ns.length / 2)));
      const out = [];
      for (let k = 0; k < size; k++) out.push(ns[Math.min(ns.length - 1, i + 2 * k)]);
      return out.filter((m, j) => out.indexOf(m) === j);  // stacked thirds within the scale
    }

    function release(chord, at) {
      // Never release mid-attack: a cancelled ramp would jump, so wait for it to finish.
      at = Math.max(at, chord.attackEnd);
      chord.envs.forEach((g) => g.gain.setTargetAtTime(0, at, RELEASE_TC));
      chord.oscs.forEach((o, i) => oneShot(o, i % 2 ? [] : [chord.envs[i >> 1]], at + RELEASE_TC * 6));
    }

    function play(at) {
      const notes = chordNotes();
      const level = 0.07 / Math.sqrt(notes.length);
      const chord = { oscs: [], envs: [], attackEnd: at };
      notes.forEach((m) => {
        const f = hz(m);
        const env = ctx.createGain();
        env.gain.setValueAtTime(0, at);
        const peakAt = at + ATTACK + rand(-1, 1);
        env.gain.linearRampToValueAtTime(level, peakAt);
        chord.attackEnd = Math.max(chord.attackEnd, peakAt);
        env.connect(lp);
        [-5, 5].forEach((cents) => {
          const o = osc(ctx, 'triangle', f, at);
          o.detune.setValueAtTime(cents + rand(-2, 2), at);
          o.connect(env);
          o.start(at);
          chord.oscs.push(o);
        });
        chord.envs.push(env);
      });
      if (current) release(current, at);
      current = chord;
      lastChord = at;
    }

    return {
      schedule(now, horizon) {
        if (next < now) next = now + 0.05;
        if (next >= horizon) return;
        const d = scene().density;
        play(next);
        lp.frequency.setTargetAtTime(900 + 1400 * d, next, 4);
        next += clamp(40 - 25 * d + rand(-3, 3), 15, 40);
      },
      revoice(now) {
        // Bring the next chord forward, but never crowd the previous one.
        next = Math.min(next, Math.max(now + 1.5, lastChord + 6));
      },
      dispose() {
        if (current) {
          current.oscs.forEach((o) => { try { o.stop(); o.disconnect(); } catch (e) { /* gone */ } });
          current.envs.forEach((g) => g.disconnect());
          current = null;
        }
        h.dispose();
      }
    };
  }

  // sub: a sine an octave below the drone's root, swelling slowly.
  function buildSub(ctx, out, t) {
    const h = held();
    const subNote = () => {
      const m = droneRoot() - 12;
      return m < 28 ? m + 12 : m;  // keep it within reach of real speakers
    };
    const amp = h.node(gain(ctx, 0.25, t));
    amp.connect(out);
    const o = h.source(osc(ctx, 'sine', hz(subNote()), t));
    o.connect(amp);
    o.start(t);
    let next = t + rand(3, 6);
    return {
      schedule(now, horizon) {
        if (next < now) next = now + 0.05;
        if (next >= horizon) return;
        const d = scene().density;
        amp.gain.setTargetAtTime(rand(0.15, 0.3) + 0.15 * d, next, rand(4, 7));
        next += rand(9, 18);
      },
      revoice(now) {
        o.frequency.setTargetAtTime(hz(subNote()), now, 2);
      },
      dispose: h.dispose
    };
  }

  // shimmer: three quiet high partials with slow tremolo, drifting between scale notes.
  function buildShimmer(ctx, out, t) {
    const h = held();
    const hp = h.node(filter(ctx, 'highpass', 600, 0.5, t));
    hp.connect(out);
    const level = () => 0.016 + 0.014 * scene().density;
    const partials = [0, 1, 2].map((i) => {
      const o = h.source(osc(ctx, i === 1 ? 'triangle' : 'sine', hz(pick(scaleNotes(72, 96))), t));
      const trem = h.node(gain(ctx, 0.65, t));
      const lfo = h.source(osc(ctx, 'sine', rand(0.07, 0.3), t));
      const depth = h.node(gain(ctx, 0.35, t));
      const env = h.node(gain(ctx, 0, t));
      env.gain.linearRampToValueAtTime(level(), t + rand(3, 9));
      lfo.connect(depth).connect(trem.gain);
      o.connect(trem).connect(env).connect(hp);
      o.start(t);
      lfo.start(t);
      return { o, env, busyUntil: t + 10 };
    });

    // Fade a partial out, retune it while silent, then fade it back in.
    function retune(p, at) {
      at = Math.max(at, p.busyUntil);
      p.env.gain.setTargetAtTime(0, at, 1.2);
      p.o.frequency.setValueAtTime(hz(pick(scaleNotes(72, 96))), at + 6);
      p.env.gain.setTargetAtTime(level(), at + 6.05, 2.5);
      p.busyUntil = at + 13;
    }

    let next = t + rand(8, 14);
    return {
      schedule(now, horizon) {
        if (next < now) next = now + 0.05;
        if (next >= horizon) return;
        retune(pick(partials), next);
        next += rand(10, 24) * (1.2 - 0.6 * scene().density);
      },
      revoice(now) {
        partials.forEach((p, i) => retune(p, now + 0.1 + i * 2));
      },
      dispose: h.dispose
    };
  }

  // bells: sparse, soft two-operator FM tones with a long decay.
  function buildBells(ctx, out, t) {
    const h = held();
    const bus = h.node(gain(ctx, 1, t));
    bus.connect(out);
    let next = t + rand(1, 4);

    function ring(at) {
      const f = hz(pick(scaleNotes(60, 88)));
      const decay = rand(4, 8);
      const peak = rand(0.05, 0.1);
      const car = osc(ctx, 'sine', f, at);
      const mod = osc(ctx, 'sine', f * pick([1.4, 2, 3.5]), at);
      const index = ctx.createGain();
      index.gain.setValueAtTime(f * rand(1, 2.5), at);
      index.gain.exponentialRampToValueAtTime(f * 0.02, at + decay * 0.4);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(peak, at + 0.015);
      env.gain.exponentialRampToValueAtTime(0.0001, at + decay);
      mod.connect(index).connect(car.frequency);
      car.connect(env).connect(bus);
      car.start(at);
      mod.start(at);
      oneShot(car, [env], at + decay + 0.05);
      oneShot(mod, [index], at + decay + 0.05);
    }

    return {
      schedule(now, horizon) {
        if (next < now) next = now + 0.05;
        for (let n = 0; next < horizon && n < MAX_EVENTS; n++) {
          ring(next);
          next += Math.max(0.8, gap(14 - 11 * scene().density));
        }
      },
      revoice() { /* each bell picks its note from the current scale */ },
      dispose: h.dispose
    };
  }

  // pulse: a soft, filtered low arpeggio in time with the tempo.
  function buildPulse(ctx, out, t) {
    const h = held();
    const lp = h.node(filter(ctx, 'lowpass', 900, 1.5, t));
    lp.connect(out);
    const SHAPES = [[0, 1, 2, 3], [0, 1, 2, 3, 2, 1], [0, 2, 1, 3], [0, 1, 2, 1]];
    let pattern = [];
    let rebuild = true;
    let step = 0;
    let next = t + 0.5;

    function build() {
      const ns = scaleNotes(40, 64);
      const i = Math.floor(Math.random() * Math.max(1, Math.min(4, ns.length - 6)));
      const tones = [0, 2, 4, 7].map((k) => ns[Math.min(ns.length - 1, i + k)]);
      pattern = pick(SHAPES).map((k) => tones[k]);
      rebuild = false;
    }

    function note(at, len, accent) {
      const dur = Math.min(len * 1.6, 0.9);
      const o = osc(ctx, 'triangle', hz(pattern[step % pattern.length]), at);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(accent ? 0.14 : 0.1, at + 0.012);
      env.gain.exponentialRampToValueAtTime(0.0005, at + dur);
      o.connect(env).connect(lp);
      o.start(at);
      oneShot(o, [env], at + dur + 0.02);
    }

    return {
      schedule(now, horizon) {
        if (next < now) next = now + 0.05;
        for (let n = 0; next < horizon && n < MAX_EVENTS; n++) {
          const s = scene();
          const beat = 60 / s.tempo;
          const len = s.density > 0.55 ? beat / 2 : beat;
          if (rebuild || step % 32 === 0) build();
          if (Math.random() > 0.15 + 0.35 * (1 - s.density)) note(next, len, step % 4 === 0);
          if (step % 8 === 0) lp.frequency.setTargetAtTime(500 + 900 * s.density, next, 3);
          step++;
          next += len;
        }
      },
      revoice() { rebuild = true; },
      dispose: h.dispose
    };
  }

  // wash: filtered noise with a slow sweep and swell, like distant sea or wind.
  function buildWash(ctx, out, t) {
    const h = held();
    const src = h.source(ctx.createBufferSource());
    src.buffer = noiseBuffer(ctx);
    src.loop = true;
    const hp = h.node(filter(ctx, 'highpass', 140, 0.5, t));
    const lp = h.node(filter(ctx, 'lowpass', 500, 0.9, t));
    const amp = h.node(gain(ctx, 0.25, t));
    src.connect(hp).connect(lp).connect(amp).connect(out);
    src.start(t, rand(0, 5));
    let next = t + rand(1, 3);
    return {
      schedule(now, horizon) {
        if (next < now) next = now + 0.05;
        if (next >= horizon) return;
        const d = scene().density;
        const tc = rand(2, 5);
        lp.frequency.setTargetAtTime(250 + Math.random() * (450 + 1300 * d), next, tc);
        amp.gain.setTargetAtTime(rand(0.15, 0.35), next, tc);
        next += rand(5, 12);
      },
      revoice() { /* unpitched: nothing to re-voice */ },
      dispose: h.dispose
    };
  }

  // grain: tiny noise and sine grains, a quiet crackle whose rate follows density.
  function buildGrain(ctx, out, t) {
    const h = held();
    const bp = h.node(filter(ctx, 'bandpass', 3000, 1.2, t));
    const bus = h.node(gain(ctx, 1, t));
    bp.connect(bus);
    bus.connect(out);
    const buf = noiseBuffer(ctx);
    let next = t + 0.3;

    function grain(at) {
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, at);
      if (Math.random() < 0.7) {
        const dur = rand(0.004, 0.025);
        const s = ctx.createBufferSource();
        s.buffer = buf;
        bp.frequency.setValueAtTime(rand(1500, 7000), at);
        env.gain.linearRampToValueAtTime(rand(0.05, 0.18), at + 0.002);
        env.gain.linearRampToValueAtTime(0, at + dur);
        s.connect(env).connect(bp);
        s.start(at, rand(0, buf.duration - 0.1));
        oneShot(s, [env], at + dur + 0.01);
      } else {
        const dur = rand(0.02, 0.07);
        const o = osc(ctx, 'sine', hz(pick(scaleNotes(84, 108))), at);
        env.gain.linearRampToValueAtTime(rand(0.015, 0.04), at + 0.004);
        env.gain.linearRampToValueAtTime(0, at + dur);
        o.connect(env).connect(bus);
        o.start(at);
        oneShot(o, [env], at + dur + 0.01);
      }
    }

    return {
      schedule(now, horizon) {
        if (next < now) next = now + 0.05;
        for (let n = 0; next < horizon && n < MAX_EVENTS; n++) {
          grain(next);
          next += Math.max(0.01, gap(1 / (1 + 14 * scene().density)));
        }
      },
      revoice() { /* sine grains pick from the current scale as they go */ },
      dispose: h.dispose
    };
  }

  // echoes: short sine motifs into a ping-pong delay timed to the tempo (a dotted eighth).
  function buildEchoes(ctx, out, t) {
    const h = held();
    const echoTime = () => Math.min(2.5, 0.75 * 60 / scene().tempo);
    const dry = h.node(gain(ctx, 0.5, t));
    const send = h.node(gain(ctx, 1, t));
    const dL = h.node(ctx.createDelay(3));
    const dR = h.node(ctx.createDelay(3));
    const lpL = h.node(filter(ctx, 'lowpass', 2400, 0.5, t));
    const lpR = h.node(filter(ctx, 'lowpass', 2400, 0.5, t));
    const fbL = h.node(gain(ctx, 0.5, t));
    const fbR = h.node(gain(ctx, 0.5, t));
    const merge = h.node(ctx.createChannelMerger(2));
    const wet = h.node(gain(ctx, 0.8, t));
    dL.delayTime.setValueAtTime(echoTime(), t);
    dR.delayTime.setValueAtTime(echoTime(), t);
    // Repeats bounce left, right, left..., each one darker and quieter than the last.
    dry.connect(out);
    send.connect(dL);
    dL.connect(merge, 0, 0);
    dL.connect(lpL).connect(fbL).connect(dR);
    dR.connect(merge, 0, 1);
    dR.connect(lpR).connect(fbR).connect(dL);
    merge.connect(wet).connect(out);

    function tone(at, f, peak) {
      const o = osc(ctx, 'sine', f, at);
      const o2 = osc(ctx, 'triangle', f * 2, at);
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(0.25, at);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(peak, at + 0.006);
      env.gain.exponentialRampToValueAtTime(0.0001, at + 0.7);
      o.connect(env);
      o2.connect(g2).connect(env);
      env.connect(dry);
      env.connect(send);
      o.start(at);
      o2.start(at);
      oneShot(o, [env], at + 0.75);
      oneShot(o2, [g2], at + 0.75);
    }

    let next = t + rand(2, 5);
    return {
      schedule(now, horizon) {
        if (next < now) next = now + 0.05;
        if (next >= horizon) return;
        const s = scene();
        const beat = 60 / s.tempo;
        const et = echoTime();
        const fb = 0.38 + 0.22 * s.density;
        [dL, dR].forEach((d) => d.delayTime.setTargetAtTime(et, next, 0.4));
        [fbL, fbR].forEach((g) => g.gain.setTargetAtTime(fb, next, 0.4));
        const ns = scaleNotes(62, 86);
        let i = Math.floor(Math.random() * ns.length);
        const count = 2 + Math.floor(Math.random() * 3);
        let at = next;
        for (let k = 0; k < count; k++) {
          tone(at, hz(ns[i]), k === 0 ? 0.09 : 0.07);
          i = clamp(i + pick([-2, -1, 1, 2]), 0, ns.length - 1);
          at += beat * pick([0.5, 0.5, 1]);
        }
        // Leave room for the repeats to die away before the next motif.
        next = at + Math.max(4, gap(14 - 9 * s.density));
      },
      revoice() { /* each motif picks its notes from the current scale */ },
      dispose: h.dispose
    };
  }

  // birds: occasional tweets, trills and two-note whistles, each call from its own place in the stereo field.
  function buildBirds(ctx, out, t) {
    const h = held();
    const hp = h.node(filter(ctx, 'highpass', 1200, 0.5, t));
    hp.connect(out);
    let next = t + rand(3, 8);

    function chirp(at, f0, f1, dur, peak, dest, extra) {
      const o = osc(ctx, 'sine', f0, at);
      o.frequency.exponentialRampToValueAtTime(f1, at + dur);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(peak, at + Math.min(0.01, dur / 4));
      env.gain.linearRampToValueAtTime(0, at + dur);
      o.connect(env).connect(dest);
      o.start(at);
      oneShot(o, [env].concat(extra), at + dur + 0.02);
    }

    // One call; returns the time it ends.
    function call(at, pan) {
      const p = ctx.createStereoPanner();
      p.pan.setValueAtTime(pan, at);
      p.connect(hp);
      let peak = rand(0.025, 0.05);
      const parts = [];  // [start, from Hz, to Hz, duration]
      let end = at;
      const kind = pick(['tweet', 'trill', 'whistle']);
      if (kind === 'tweet') {
        const base = rand(2600, 4800);
        const n = 2 + Math.floor(Math.random() * 4);
        for (let k = 0; k < n; k++) {
          const dur = rand(0.05, 0.11);
          parts.push([end, base * rand(1.1, 1.35), base * rand(0.6, 0.8), dur]);
          end += dur + rand(0.04, 0.12);
        }
      } else if (kind === 'trill') {
        const base = rand(3200, 5600);
        const n = 6 + Math.floor(Math.random() * 10);
        peak *= 0.8;
        for (let k = 0; k < n; k++) {
          parts.push([end, base, base * rand(1.05, 1.2), 0.025]);
          end += 0.045;
        }
      } else {
        const ns = scaleNotes(86, 100);
        const a = hz(pick(ns));
        const b = hz(pick(ns));
        parts.push([end, a, a * 1.02, 0.28]);
        end += 0.34;
        parts.push([end, b * 0.98, b, 0.4]);
        end += 0.4;
      }
      // The last chirp to finish takes the call's panner with it.
      parts.forEach((c, k) => chirp(c[0], c[1], c[2], c[3], peak, p, k === parts.length - 1 ? [p] : []));
      return end;
    }

    return {
      schedule(now, horizon) {
        if (next < now) next = now + 0.05;
        for (let n = 0; next < horizon && n < MAX_EVENTS; n++) {
          const pan = rand(-0.9, 0.9);
          let end = call(next, pan);
          // Sometimes a second bird answers from the other side.
          if (Math.random() < 0.35) end = Math.max(end, call(end + rand(0.4, 1.4), -pan * rand(0.5, 1)));
          next = end + Math.max(1.5, gap(20 - 15 * scene().density));
        }
      },
      revoice() { /* whistles pick from the current scale as they go */ },
      dispose: h.dispose
    };
  }

  // drops: water drops, small rising plinks pitched from the scale, scattered across the stereo field.
  function buildDrops(ctx, out, t) {
    const h = held();
    const bus = h.node(gain(ctx, 1, t));
    bus.connect(out);
    let rain = 1;   // slowly wandering intensity, so showers come and go
    let gust = t;
    let next = t + rand(0.5, 2);

    function drop(at) {
      const big = Math.random() < 0.15;
      const f = hz(pick(big ? scaleNotes(60, 74) : scaleNotes(76, 98)));
      const rise = big ? rand(1.2, 1.5) : rand(1.4, 2.2);
      const sweep = big ? rand(0.05, 0.09) : rand(0.02, 0.05);
      const decay = big ? rand(0.25, 0.45) : rand(0.08, 0.2);
      const peak = big ? rand(0.05, 0.08) : rand(0.025, 0.07);
      const o = osc(ctx, 'sine', f, at);
      o.frequency.exponentialRampToValueAtTime(f * rise, at + sweep);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(peak, at + 0.003);
      env.gain.exponentialRampToValueAtTime(0.0001, at + decay);
      const p = ctx.createStereoPanner();
      p.pan.setValueAtTime(rand(-0.95, 0.95), at);
      o.connect(env).connect(p).connect(bus);
      o.start(at);
      oneShot(o, [env, p], at + decay + 0.02);
    }

    return {
      schedule(now, horizon) {
        if (next < now) next = now + 0.05;
        for (let n = 0; next < horizon && n < MAX_EVENTS; n++) {
          if (next >= gust) { rain = rand(0.4, 1.6); gust = next + rand(8, 20); }
          drop(next);
          next += Math.max(0.03, gap((3 - 2.75 * scene().density) / rain));
        }
      },
      revoice() { /* each drop picks its note from the current scale */ },
      dispose: h.dispose
    };
  }

  const BUILDERS = {
    drone: buildDrone, pad: buildPad, sub: buildSub, shimmer: buildShimmer,
    bells: buildBells, pulse: buildPulse, wash: buildWash, grain: buildGrain,
    echoes: buildEchoes, birds: buildBirds, drops: buildDrops
  };

  // ------------------------------------------------------------- lifecycle

  const state = {};
  VOICES.forEach((name, i) => {
    state[name] = { name, ch: i + 1, mode: 'idle', ctx: null, out: null, impl: null, timer: null, kill: null };
  });

  function stale(v) {
    return !v.ctx || v.ctx.state === 'closed' || engineContext() !== v.ctx;
  }

  function dispose(v) {
    clearTimeout(v.timer);
    clearTimeout(v.kill);
    v.timer = v.kill = null;
    if (v.impl) { try { v.impl.dispose(); } catch (e) { /* best effort */ } }
    if (v.out) { try { v.out.disconnect(); } catch (e) { /* already gone */ } }
    v.impl = v.out = v.ctx = null;
    v.mode = 'idle';
  }

  function loop(v) {
    v.timer = null;
    if (v.mode !== 'playing') return;
    if (stale(v)) { dispose(v); return; }
    try {
      const now = clock(v.ctx);
      v.impl.schedule(now, now + LOOKAHEAD);
    } catch (e) { /* keep the loop alive; the next tick tries again */ }
    v.timer = setTimeout(() => loop(v), TICK_MS);
  }

  function fadeTo(v, value, seconds) {
    const t = clock(v.ctx);
    hold(v.out.gain, t);
    v.out.gain.linearRampToValueAtTime(value, t + seconds);
    return t + seconds;
  }

  function startOne(v) {
    const ctx = engineContext();
    if (!ctx || ctx.state === 'closed') return false;
    if (v.ctx && v.ctx !== ctx) dispose(v);
    if (v.mode === 'playing') return true;
    if (v.mode === 'stopping') {
      // Restarted during its fade-out: cancel the teardown and fade back up.
      clearTimeout(v.kill);
      v.kill = null;
      v.mode = 'playing';
      fadeTo(v, 1, FADE_IN);
      clearTimeout(v.timer);
      loop(v);
      return true;
    }
    let strip = null;
    try { strip = Ambient.engine.channel(v.ch); } catch (e) { strip = null; }
    if (!strip || !strip.input) return false;
    try {
      const t = clock(ctx);
      v.ctx = ctx;
      v.out = ctx.createGain();
      v.out.gain.setValueAtTime(0, t);
      v.out.gain.linearRampToValueAtTime(1, t + FADE_IN);
      v.out.connect(strip.input);
      v.impl = BUILDERS[v.name](ctx, v.out, t);
    } catch (e) {
      dispose(v);
      return false;
    }
    v.mode = 'playing';
    watchScene();
    loop(v);
    return true;
  }

  function stopOne(v) {
    if (v.mode !== 'playing') return;
    v.mode = 'stopping';
    clearTimeout(v.timer);
    v.timer = null;
    if (stale(v)) { dispose(v); return; }
    const end = fadeTo(v, 0, FADE_OUT);
    // Tear down only once the audio clock has passed the fade, even if suspended.
    const finish = () => {
      if (v.mode !== 'stopping') return;
      if (stale(v) || v.ctx.currentTime >= end + 0.1) dispose(v);
      else v.kill = setTimeout(finish, 500);
    };
    v.kill = setTimeout(finish, (FADE_OUT + 0.2) * 1000);
  }

  // One scene subscription, shared by all voices; only key or mode re-voices,
  // since density and tempo are read afresh on every scheduling tick.
  let watching = false;
  let lastSig = null;
  const signature = () => { const s = scene(); return String(s.key) + '|' + String(s.mode); };
  function watchScene() {
    if (watching || !Ambient.scene || typeof Ambient.scene.onChange !== 'function') return;
    watching = true;
    lastSig = signature();
    Ambient.scene.onChange(() => {
      const sig = signature();
      if (sig === lastSig) return;
      lastSig = sig;
      VOICES.forEach((name) => {
        const v = state[name];
        if (v.mode !== 'playing' || stale(v)) return;
        try { v.impl.revoice(clock(v.ctx)); } catch (e) { /* best effort */ }
      });
    });
  }

  function targets(name) {
    if (name === undefined || name === null) return VOICES.map((n) => state[n]);
    return Object.prototype.hasOwnProperty.call(state, name) ? [state[name]] : [];
  }

  Ambient.voices = {
    list: VOICES.slice(),
    start(name) {
      const vs = targets(name);
      let ok = vs.length > 0;
      vs.forEach((v) => { ok = startOne(v) && ok; });
      return ok;
    },
    stop(name) {
      targets(name).forEach(stopOne);
    },
    isPlaying(name) {
      return Object.prototype.hasOwnProperty.call(state, name) && state[name].mode === 'playing';
    }
  };
})();
