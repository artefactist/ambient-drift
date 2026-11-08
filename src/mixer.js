// Mixer: wires the page's controls to Ambient.engine, Ambient.scene and Ambient.voices.
// Loaded last, with defer, so the DOM and the other three scripts are ready.
(function () {
  'use strict';

  const Ambient = window.Ambient;
  const CHANNELS = 11;
  const byId = (id) => document.getElementById(id);
  const num = (el) => Number(el.value);

  // Transport.
  const startBtn = byId('start');
  const master = byId('master');
  let running = false;
  let busy = false;

  function showTransport() {
    startBtn.setAttribute('aria-pressed', running ? 'true' : 'false');
    startBtn.textContent = running ? 'Stop' : 'Start';
  }

  startBtn.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    startBtn.disabled = true; // guard against double clicks racing a fade
    try {
      if (!running) {
        await Ambient.engine.start();
        Ambient.voices.start();
        running = true;
        startMeters();
      } else {
        running = false;
        stopMeters();
        await Ambient.voices.stop();
        await Ambient.engine.stop();
      }
    } finally {
      busy = false;
      startBtn.disabled = false;
      showTransport();
    }
  });

  const applyMaster = () => Ambient.engine.setMasterVolume(num(master) / 100);
  master.addEventListener('input', applyMaster);
  applyMaster();
  showTransport();

  // Channel strips: level, pan, send, mute and solo for channels 1 to 11.
  const strips = [];
  for (let n = 1; n <= CHANNELS; n++) {
    const ch = Ambient.engine.channel(n);
    const level = byId('level-' + n);
    const pan = byId('pan-' + n);
    const send = byId('send-' + n);
    const mute = byId('mute-' + n);
    const solo = byId('solo-' + n);

    const applyLevel = () => ch.setLevel(num(level) / 100);
    const applyPan = () => ch.setPan(num(pan) / 100);
    const applySend = () => ch.setSend(num(send) / 100);
    const applyMute = (on) => {
      mute.setAttribute('aria-pressed', on ? 'true' : 'false');
      ch.setMute(on);
    };
    const applySolo = (on) => {
      solo.setAttribute('aria-pressed', on ? 'true' : 'false');
      ch.setSolo(on); // the engine decides: mute wins over solo
    };

    level.addEventListener('input', applyLevel);
    pan.addEventListener('input', applyPan);
    send.addEventListener('input', applySend);
    mute.addEventListener('click', () => {
      applyMute(mute.getAttribute('aria-pressed') !== 'true');
    });
    solo.addEventListener('click', () => {
      applySolo(solo.getAttribute('aria-pressed') !== 'true');
    });

    // The engine remembers settings made before start, so apply them now.
    applyLevel();
    applyPan();
    applySend();
    applyMute(mute.getAttribute('aria-pressed') === 'true');
    applySolo(solo.getAttribute('aria-pressed') === 'true');

    strips.push({ ch: ch, li: level.closest('li') });
  }

  // Scene controls.
  const key = byId('key');
  const mode = byId('mode');
  const density = byId('density');
  const tempo = byId('tempo');
  const space = byId('space');
  const drift = byId('drift');

  // Drift switch: shows the scene's drift state, and toggles it.
  const showDrift = () => {
    drift.setAttribute('aria-pressed', Ambient.scene.get().drifting ? 'true' : 'false');
  };
  drift.addEventListener('click', () => {
    Ambient.scene.drift(!Ambient.scene.get().drifting);
    showDrift();
  });

  key.addEventListener('change', () => Ambient.scene.set({ key: key.value }));
  mode.addEventListener('change', () => Ambient.scene.set({ mode: mode.value }));
  density.addEventListener('input', () => Ambient.scene.set({ density: num(density) / 100 }));
  tempo.addEventListener('input', () => Ambient.scene.set({ tempo: num(tempo) }));

  const applySpace = () => Ambient.engine.setReverb(num(space) / 100);
  space.addEventListener('input', applySpace);
  applySpace();

  // Bring the page's initial scene values into the scene.
  Ambient.scene.set({
    key: key.value,
    mode: mode.value,
    density: num(density) / 100,
    tempo: num(tempo)
  });

  // When the scene drifts on its own, follow it on the controls.
  Ambient.scene.onChange(() => {
    const s = Ambient.scene.get();
    if (s.key !== undefined && key.value !== s.key) key.value = s.key;
    if (s.mode !== undefined && mode.value !== s.mode) mode.value = s.mode;
    if (typeof s.density === 'number') {
      const d = String(Math.round(s.density * 100));
      if (density.value !== d) density.value = d;
    }
    if (typeof s.tempo === 'number') {
      const t = String(Math.round(s.tempo));
      if (tempo.value !== t) tempo.value = t;
    }
    showDrift();
  });
  showDrift();

  // Meters: set --meter (0..1) on each strip's li while running.
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const SLOW_INTERVAL = 500; // at most twice a second when motion is reduced
  let frame = 0;
  let lastPaint = 0;

  function paintMeters() {
    for (const s of strips) {
      const v = Math.min(1, Math.max(0, Number(s.ch.meter()) || 0));
      s.li.style.setProperty('--meter', v.toFixed(3));
    }
  }

  function tick(time) {
    if (!running) { frame = 0; return; }
    if (!reduced.matches || time - lastPaint >= SLOW_INTERVAL) {
      lastPaint = time;
      paintMeters();
    }
    frame = window.requestAnimationFrame(tick);
  }

  function startMeters() {
    if (frame) return;
    lastPaint = 0;
    frame = window.requestAnimationFrame(tick);
  }

  function stopMeters() {
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
    for (const s of strips) s.li.style.setProperty('--meter', '0');
  }
})();
