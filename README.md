# Ambient

A generative ambient instrument that runs entirely in the browser. You set a scene (key, mode, density, tempo and space), shape eleven voices on a mixer, and let it play.

Every sound is synthesised live with the Web Audio API from oscillators, filters and generated noise. There are no samples, no audio files, no build step and no dependencies.

Part of [artefact.ist](https://artefact.ist).

## Running it

Ambient is a static site: one HTML page, one stylesheet and four classic scripts, all in `src/`. Serve that folder over HTTP and open it in a browser. From the project root:

```bash
python -m http.server 8000 --directory src
```

Then visit <http://localhost:8000> and press **Start**. Browsers only allow audio after a user gesture, so nothing is created until you click.

Any static file server works. Opening `src/index.html` straight from disk (`file://`) may work, but the page's Content Security Policy is written for HTTP, so a local server is more reliable.

## Controls

### Transport

| Control | What it does |
|---|---|
| **Start / Stop** | Fades the whole instrument in or out over about 1.5 s. Voices fade in over 4 s and out over 5 s, so nothing clicks. |
| **Master** | Overall volume. A limiter on the master bus guards against clipping. |

### Scene

| Control | What it does |
|---|---|
| **Key** | Root note, C to B. Changing it re-voices every voice gently, with glides and crossfades rather than jumps. |
| **Mode** | Ionian, Dorian, Lydian, Mixolydian, Aeolian, major pentatonic or minor pentatonic. |
| **Density** | How busy the piece is, from sparse to full. Each voice reads it afresh on every scheduling tick. |
| **Tempo** | 40–120 BPM. Drives Pulse and the Echoes delay time; the other voices are deliberately unmetred. |
| **Space** | Amount of reverb returned to the mix. |
| **Drift** | When on, the scene evolves by itself every 1–2 minutes. It usually moves the key up or down a fifth, or shifts to a neighbouring mode, and occasionally nudges density. The controls update to follow it. |

### Channels

Each voice has its own strip with **Mute**, **Solo**, **Level**, **Pan** and **Send** (to reverb). Mute always wins; when any channel is soloed, only soloed channels sound. A thin red meter along the bottom of each strip shows its live level.

## Voices

| # | Voice | Character | How it's made |
|---|---|---|---|
| 1 | **Drone** | A low, slowly breathing bed on the root | Two detuned saws through a wandering low-pass filter |
| 2 | **Pad** | Soft chords that change every 15–40 s | Three or four stacked scale thirds, detuned triangles, 7 s attack |
| 3 | **Sub** | Deep swell an octave below the drone | A single sine with slow gain swells |
| 4 | **Shimmer** | Quiet high partials that drift between notes | Sines and a triangle with slow tremolo, retuned while silent |
| 5 | **Bells** | Sparse, soft bell tones with long decays | Two-operator FM |
| 6 | **Pulse** | A gentle low arpeggio in time with the tempo | Filtered triangle notes in patterns that rebuild every 32 steps |
| 7 | **Wash** | Distant sea or wind | Looped noise through a sweeping band of filters |
| 8 | **Grain** | A quiet crackle with tiny pitched glints | Noise and sine grains a few milliseconds long |
| 9 | **Echoes** | Short motifs that bounce left and right as they fade | Sine plus triangle notes into a ping-pong delay timed to a dotted eighth |
| 10 | **Birds** | Occasional tweets, trills and whistles, sometimes answered | Sine chirps with fast pitch sweeps, each call panned to its own spot |
| 11 | **Drops** | Water drops in key, in showers that come and go | Short rising sine plinks, randomly panned, with a wandering rain intensity |

All pitched voices take their notes from the current key and mode, so everything stays consonant as the scene changes.

## How it works

```
README.md
LICENSE
src/
  index.html    page markup: transport, scene and channel strips
  theme.css     all visual styling (artefact.ist design language)
  engine.js     Web Audio graph: channel strips, reverb, master, limiter
  scene.js      shared musical state: key, mode, density, tempo, drift
  voices.js     the eleven generative voices and their schedulers
  mixer.js      wires the page controls to the engine, scene and voices
```

The scripts load in that order with `defer` and share a single global namespace, `window.Ambient`.

### Signal path

```
voice ─► channel input ─► level ─► pan ─► mute/solo gate ─┬─► master ─► limiter ─► output
                                                           ├─► send ─► reverb ─► return ─► master
                                                           └─► analyser (meter)
```

The reverb impulse response is generated in code as five seconds of stereo decaying noise.

### Scheduling

Each voice runs its own look-ahead loop. Every 200 ms it wakes, reads the current scene, and schedules any events that fall within the next 1.2 s on the audio clock. Timing stays sample-accurate even when the main thread is busy, and changes to density or tempo take effect within a fraction of a second.

### Modules

- **`Ambient.engine`**: `start()`, `stop()`, `isRunning()`, `context()`, `now()`, `setMasterVolume(v)`, `setReverb(v)`, and `channel(n)`, which returns a strip with `setLevel`, `setPan`, `setSend`, `setMute`, `setSolo` and `meter()`.
- **`Ambient.scene`**: `get()`, `set(partial)`, `notes(lowMidi, highMidi)`, `freq(midi)`, `onChange(fn)` and `drift(on)`.
- **`Ambient.voices`**: `list`, `start(name?)`, `stop(name?)` and `isPlaying(name)`.

## Adding a voice

1. In `voices.js`, write a `buildX(ctx, out, t)` function that returns `{ schedule(now, horizon), revoice(now), dispose() }`. The existing voices are good templates: use `held()` for long-lived nodes and `oneShot()` for notes that tidy themselves up.
2. Add its name to `VOICES` and its builder to `BUILDERS`. Its position in `VOICES` sets its channel number.
3. Raise `CHANNELS` in both `engine.js` and `mixer.js`.
4. Add a matching `<li class="strip">` to `index.html`, using the next channel number in the `mute-`, `solo-`, `level-`, `pan-` and `send-` IDs.

The layout needs no changes, because the channel grid wraps to fit. Start new voices quiet: every extra channel adds to the master level.

## Design

`theme.css` follows the artefact.ist brand: Inter 900 uppercase headlines, JetBrains Mono labels, cool neutral greys on near-black, a single red accent (`#f13126`) and a 6 / 8 / 12px radius scale. All colours, radii, motion and layout values are defined as tokens on `:root`. Controls keep 44px touch targets, and the layout stacks cleanly down to 320px wide. Motion respects `prefers-reduced-motion`.

## Browser support

Any current browser with the Web Audio API: Chrome, Edge, Firefox and Safari. Slider styling uses both WebKit and Firefox pseudo-elements. The one visible difference is that Firefox also shades the filled part of each slider's track.

## Privacy and security

Everything runs locally in the page. Ambient makes no network requests apart from loading Google Fonts. A strict Content Security Policy allows only the page's own scripts and styles, plus Google Fonts.

## Licence

The code is released under the [MIT License](LICENSE). Copyright © 2026 Paul Berry.

The licence covers the code only. The artefact.ist name, wordmark and visual identity are not included, and shouldn't be used in a way that presents a fork or derivative as an official artefact.ist project.
