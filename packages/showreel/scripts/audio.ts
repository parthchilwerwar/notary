// Renders every sound in the film from code (no samples, no downloads): an original 15-second music
// bed and the UI sound effects, as deterministic 44.1 kHz / 16-bit stereo WAVs in public/audio/.
// Simple DSP only: oscillators, FM, Karplus–Strong plucks, seeded noise, one-pole / biquad filters,
// ADSR envelopes, a ping-pong delay and a small Schroeder reverb. The music runs at 120 BPM so its
// downbeats land on the cuts (src/v2/timeline.ts: one beat = 15 frames), swells into Enforce and
// resolves on the close with its last tail ending at 15.0 s. The script then mixes music + every
// cue offline exactly as the composition places them and prints integrated loudness (ITU-R BS.1770
// K-weighting with gating) and true-ish peak, so the mix is checked before rendering.
//
//   pnpm --filter @notary/showreel audio
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ShowreelDataSchema } from "../src/data-schema.js";
import { cues, duck, SFX, type SfxName } from "../src/v2/cues.js";
import { MUSIC_GAIN, SFX_GAIN } from "../src/v2/gains.js";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "../public/audio");
export const SR = 44100;
const FPS = 30;
const SECONDS = 15;
const BPM = 120;
const BEAT = 60 / BPM;

// ------------------------------------------------------------------------------ primitives

export type Stereo = { l: Float32Array; r: Float32Array };
export const stereo = (n: number): Stereo => ({ l: new Float32Array(n), r: new Float32Array(n) });

/** Seeded PRNG (mulberry32): the same noise every run. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const midi = (n: number) => 440 * 2 ** ((n - 69) / 12);

/** Attack / decay / sustain / release envelope sampled at t seconds for a note of `dur` seconds. */
export function adsr(t: number, dur: number, a: number, d: number, s: number, r: number): number {
  if (t < 0) return 0;
  if (t < a) return t / a;
  if (t < a + d) return 1 - (1 - s) * ((t - a) / d);
  if (t < dur) return s;
  const rt = t - dur;
  return rt < r ? s * (1 - rt / r) : 0;
}

/** RBJ biquad (lowpass / highpass / bandpass / highshelf), processed in place. */
export function biquad(x: Float32Array, type: "lp" | "hp" | "bp", f: number, q = 0.707): Float32Array {
  const w = (2 * Math.PI * f) / SR;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  let b0: number, b1: number, b2: number;
  if (type === "lp") [b0, b1, b2] = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2];
  else if (type === "hp") [b0, b1, b2] = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
  else [b0, b1, b2] = [alpha, 0, -alpha];
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = (b0 * x[i]! + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x[i]!;
    y2 = y1;
    y1 = y;
    x[i] = y;
  }
  return x;
}

/** Schroeder reverb (4 combs + 2 allpasses per side), returns the wet signal. */
export function reverb(src: Stereo, size = 1, damp = 0.35): Stereo {
  const out = stereo(src.l.length);
  const side = (x: Float32Array, y: Float32Array, spread: number) => {
    const combs = [1116, 1188, 1277, 1356].map((d) => Math.round((d + spread) * size));
    for (const d of combs) {
      const buf = new Float32Array(d);
      let idx = 0;
      let lp = 0;
      for (let i = 0; i < x.length; i++) {
        const o = buf[idx]!;
        lp = o * (1 - damp) + lp * damp;
        buf[idx] = x[i]! + lp * 0.8;
        y[i]! += o * 0.25;
        idx = (idx + 1) % d;
      }
    }
    for (const d of [556 + spread, 441 + spread]) {
      const buf = new Float32Array(d);
      let idx = 0;
      for (let i = 0; i < y.length; i++) {
        const b = buf[idx]!;
        const v = y[i]!;
        const o = -v + b;
        buf[idx] = v + b * 0.5;
        y[i] = o;
        idx = (idx + 1) % d;
      }
    }
  };
  side(src.l, out.l, 0);
  side(src.r, out.r, 23);
  return out;
}

/** Ping-pong delay: returns the wet signal. */
export function pingpong(src: Stereo, time: number, feedback: number): Stereo {
  const d = Math.round(time * SR);
  const out = stereo(src.l.length);
  for (let i = 0; i < src.l.length; i++) {
    const inL = i >= d ? src.l[i - d]! + out.r[i - d]! * feedback : 0;
    const inR = i >= d ? src.r[i - d]! * 0.6 + out.l[i - d]! * feedback : 0;
    out.l[i] = inR * 0.5;
    out.r[i] = inL;
  }
  return out;
}

export function mixInto(dst: Stereo, src: Stereo, gain = 1, offset = 0) {
  for (let i = 0; i < src.l.length && i + offset < dst.l.length; i++) {
    if (i + offset < 0) continue;
    dst.l[i + offset]! += src.l[i]! * gain;
    dst.r[i + offset]! += src.r[i]! * gain;
  }
}

// ------------------------------------------------------------------------------ music

// D major, one chord per bar (4 beats), the payoff from beat 18 (frame 270), resolve at beat 27.
const CHORDS: { at: number; len: number; notes: number[] }[] = [
  { at: 0, len: 4, notes: [50, 57, 61, 64, 66] }, // Dmaj9
  { at: 4, len: 4, notes: [47, 54, 57, 62, 66] }, // Bm9
  { at: 8, len: 4, notes: [43, 50, 54, 59, 62] }, // Gmaj7
  { at: 12, len: 4, notes: [45, 52, 57, 59, 64] }, // A sus2/add9
  { at: 16, len: 4, notes: [47, 54, 57, 61, 66] }, // Bm11 (swell)
  { at: 20, len: 4, notes: [43, 50, 54, 59, 64] }, // Gmaj9
  { at: 24, len: 3, notes: [45, 52, 57, 62, 64] }, // A sus4 → resolve
  { at: 27, len: 3, notes: [50, 57, 61, 64, 69] }, // Dmaj9 (final)
];

function pad(n: number): Stereo {
  const out = stereo(n);
  const r = rng(11);
  for (const c of CHORDS) {
    const start = c.at * BEAT;
    const dur = c.len * BEAT;
    const final = c.at === 27;
    for (const [vi, note] of c.notes.entries()) {
      for (const det of [-0.11, 0.09]) {
        const f = midi(note + 12) * 2 ** (det / 12);
        let phase = r();
        const pan = 0.5 + (vi - 2) * 0.12 + det;
        const s0 = Math.floor(start * SR);
        const len = Math.floor((dur + (final ? 1.6 : 0.6)) * SR);
        for (let i = 0; i < len && s0 + i < n; i++) {
          const t = i / SR;
          const env = adsr(t, dur, final ? 0.08 : 0.6, 0.6, 0.85, final ? 1.6 : 0.6);
          phase += f / SR;
          phase -= Math.floor(phase);
          const saw = 2 * phase - 1;
          const tri = 1 - 4 * Math.abs(phase - 0.5);
          const v = (saw * 0.35 + tri * 0.65) * env * 0.05;
          out.l[s0 + i]! += v * (1 - pan);
          out.r[s0 + i]! += v * pan;
        }
      }
    }
  }
  // Brightness follows the arc: closed intro, opening into the payoff, soft close.
  const lp = (x: Float32Array) => {
    let y = 0;
    for (let i = 0; i < x.length; i++) {
      const t = i / SR;
      const cutoff = t < 8 ? 900 + t * 120 : t < 13.5 ? 1900 + Math.min(1, (t - 8) / 1.2) * 1400 : 2600;
      const a = 1 - Math.exp((-2 * Math.PI * cutoff) / SR);
      y += a * (x[i]! - y);
      x[i] = y;
    }
  };
  lp(out.l);
  lp(out.r);
  return out;
}

/** Karplus–Strong pluck. */
export function pluck(f: number, dur: number, seed: number, bright = 0.5): Float32Array {
  const n = Math.floor(dur * SR);
  const out = new Float32Array(n);
  const period = Math.max(2, Math.round(SR / f));
  const r = rng(seed);
  const buf = Float32Array.from({ length: period }, () => r() * 2 - 1);
  let idx = 0;
  for (let i = 0; i < n; i++) {
    const a = buf[idx]!;
    const b = buf[(idx + 1) % period]!;
    const v = (a * (1 - bright) + b * bright) * 0.996;
    buf[idx] = v;
    out[i] = a * Math.exp(-i / SR / (dur * 0.5));
    idx = (idx + 1) % period;
  }
  return out;
}

function arp(n: number): Stereo {
  const out = stereo(n);
  const pattern = [0, 2, 3, 4, 3, 2, 1, 2];
  let k = 0;
  for (let beat = 4; beat < 27; beat += 0.5) {
    const c = [...CHORDS].reverse().find((x) => beat >= x.at)!;
    const note = c.notes[1 + (pattern[k % pattern.length]! % (c.notes.length - 1))]! + 12;
    const vel = (beat % 1 === 0 ? 0.9 : 0.62) * (beat >= 18 ? 1.15 : beat < 8 ? 0.7 : 1);
    const s = pluck(midi(note), 0.9, 100 + k, 0.45);
    const pan = 0.5 + Math.sin(k * 1.7) * 0.25;
    const at = Math.floor(beat * BEAT * SR);
    for (let i = 0; i < s.length && at + i < n; i++) {
      out.l[at + i]! += s[i]! * vel * 0.16 * (1 - pan);
      out.r[at + i]! += s[i]! * vel * 0.16 * pan;
    }
    k++;
  }
  // The final chord, plucked up the voicing, ringing out.
  CHORDS.at(-1)!.notes.forEach((note, i) => {
    const s = pluck(midi(note + 12), 1.4, 900 + i, 0.4);
    const at = Math.floor((27 * BEAT + i * 0.045) * SR);
    for (let j = 0; j < s.length && at + j < n; j++) {
      out.l[at + j]! += s[j]! * 0.14 * (0.4 + i * 0.12);
      out.r[at + j]! += s[j]! * 0.14 * (1 - i * 0.12);
    }
  });
  return out;
}

function bass(n: number): Stereo {
  const out = stereo(n);
  for (let beat = 8; beat < 27; beat += 2) {
    const c = [...CHORDS].reverse().find((x) => beat >= x.at)!;
    const f = midi(c.notes[0]! - 12);
    const at = Math.floor(beat * BEAT * SR);
    const len = Math.floor(BEAT * 1.9 * SR);
    let ph = 0;
    for (let i = 0; i < len && at + i < n; i++) {
      const t = i / SR;
      ph += f / SR;
      const v = Math.sin(2 * Math.PI * ph) * adsr(t, BEAT * 1.6, 0.01, 0.3, 0.7, 0.3) * (beat >= 18 ? 0.2 : 0.13);
      out.l[at + i]! += v;
      out.r[at + i]! += v;
    }
  }
  // Final low D under the resolve.
  const at = Math.floor(27 * BEAT * SR);
  let ph = 0;
  for (let i = 0; at + i < n; i++) {
    ph += midi(38) / SR;
    const v = Math.sin(2 * Math.PI * ph) * Math.exp(-i / SR / 0.6) * 0.18;
    out.l[at + i]! += v;
    out.r[at + i]! += v;
  }
  return out;
}

function drums(n: number): Stereo {
  const out = stereo(n);
  const r = rng(77);
  const kick = (at: number, g: number) => {
    let ph = 0;
    for (let i = 0; i < 0.35 * SR && at + i < n; i++) {
      const t = i / SR;
      ph += (48 + 90 * Math.exp(-t * 28)) / SR;
      const v = Math.sin(2 * Math.PI * ph) * Math.exp(-t * 9) * g;
      out.l[at + i]! += v;
      out.r[at + i]! += v;
    }
  };
  const hat = (at: number, g: number, pan: number) => {
    const len = Math.floor(0.05 * SR);
    const x = Float32Array.from({ length: len }, (_, i) => (r() * 2 - 1) * Math.exp(-i / SR / 0.012));
    biquad(x, "hp", 7000);
    for (let i = 0; i < len && at + i < n; i++) {
      out.l[at + i]! += x[i]! * g * (1 - pan);
      out.r[at + i]! += x[i]! * g * pan;
    }
  };
  for (let beat = 8; beat < 27; beat += 0.5) {
    const at = Math.floor(beat * BEAT * SR);
    if (beat >= 18 && beat % 1 === 0) kick(at, beat % 2 === 0 ? 0.55 : 0.4);
    if (beat >= 12 && beat % 1 === 0.5) hat(at, beat >= 18 ? 0.22 : 0.14, 0.62);
  }
  // A filtered-noise riser into the payoff (beats 16 → 18).
  const s0 = Math.floor(16 * BEAT * SR);
  const len = Math.floor(2 * BEAT * SR);
  const x = Float32Array.from({ length: len }, () => r() * 2 - 1);
  biquad(x, "bp", 2500, 0.9);
  for (let i = 0; i < len; i++) {
    const t = i / len;
    const v = x[i]! * t * t * 0.22;
    out.l[s0 + i]! += v;
    out.r[s0 + i]! += v;
  }
  return out;
}

function music(): Stereo {
  const n = SECONDS * SR;
  const dry = stereo(n);
  mixInto(dry, pad(n), 1);
  const a = arp(n);
  mixInto(dry, a, 1);
  mixInto(dry, pingpong(a, BEAT * 0.75, 0.35), 0.45);
  mixInto(dry, bass(n), 1);
  mixInto(dry, drums(n), 1);
  const wet = reverb(dry, 1.1, 0.4);
  const out = stereo(n);
  mixInto(out, dry, 0.82);
  mixInto(out, wet, 0.32);
  // Gentle intro and a fade so the last tail ends at exactly 15.0 s.
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const g = Math.min(1, t / 0.9) * (t > 14.2 ? Math.max(0, (15 - t) / 0.8) ** 1.5 : 1);
    out.l[i]! *= g;
    out.r[i]! *= g;
  }
  return out;
}

// ------------------------------------------------------------------------------ effects

function render(seconds: number, fn: (t: number, i: number) => [number, number]): Stereo {
  const n = Math.floor(seconds * SR);
  const out = stereo(n);
  for (let i = 0; i < n; i++) {
    const [l, r] = fn(i / SR, i);
    out.l[i] = l;
    out.r[i] = r;
  }
  return out;
}

export function sfx(name: SfxName): Stereo {
  const r = rng(SFX.indexOf(name) * 97 + 5);
  const noise = () => r() * 2 - 1;
  switch (name) {
    case "click": {
      // Press (short bright tick) + release 70 ms later (softer, lower).
      const n = render(0.16, (t) => {
        const press = t < 0.03 ? (noise() * 0.6 + Math.sin(2 * Math.PI * 2800 * t)) * Math.exp(-t * 260) : 0;
        const rt = t - 0.07;
        const rel = rt > 0 && rt < 0.03 ? (noise() * 0.4 + Math.sin(2 * Math.PI * 1900 * rt)) * Math.exp(-rt * 300) * 0.55 : 0;
        const v = (press + rel) * 0.5;
        return [v, v];
      });
      biquad(n.l, "hp", 600);
      biquad(n.r, "hp", 600);
      return n;
    }
    case "move": {
      const n = render(0.32, (t) => {
        const e = Math.sin(Math.PI * Math.min(1, t / 0.32)) ** 2;
        const v = noise() * e * 0.12;
        return [v, v * 0.8];
      });
      biquad(n.l, "bp", 1400, 0.7);
      biquad(n.r, "bp", 1600, 0.7);
      return n;
    }
    case "type": {
      const n = render(0.06, (t) => {
        const v = (noise() * 0.7 + Math.sin(2 * Math.PI * 3400 * t) * 0.3) * Math.exp(-t * 180) * 0.45;
        return [v, v];
      });
      biquad(n.l, "hp", 1500);
      biquad(n.r, "hp", 1500);
      return n;
    }
    case "pop":
      return render(0.18, (t) => {
        const f = 700 + 900 * Math.exp(-t * 40);
        const v = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 28) * 0.4;
        return [v, v];
      });
    case "tick":
      return render(0.08, (t) => {
        const v = Math.sin(2 * Math.PI * 1760 * t) * Math.exp(-t * 90) * 0.3;
        return [v, v];
      });
    case "blip":
      // Low warning blip: two quick soft square-ish tones, falling.
      return render(0.28, (t) => {
        const f = t < 0.12 ? 330 : 247;
        const tt = t < 0.12 ? t : t - 0.12;
        const s = Math.tanh(Math.sin(2 * Math.PI * f * t) * 2.2) * 0.5;
        const v = s * Math.exp(-tt * 18) * (t < 0.12 || t > 0.125 ? 1 : 0) * 0.42;
        return [v, v];
      });
    case "whoosh": {
      const n = render(0.7, (t) => {
        const e = Math.sin(Math.PI * Math.min(1, t / 0.7)) ** 2;
        return [noise() * e * 0.3, noise() * e * 0.3];
      });
      // Sweep: band center rises with time (applied as two passes).
      biquad(n.l, "bp", 900, 0.6);
      biquad(n.r, "bp", 1200, 0.6);
      return n;
    }
    case "dive": {
      const n = render(1.4, (t) => {
        const e = Math.sin(Math.PI * Math.min(1, t / 1.4)) ** 1.5;
        const rumble = Math.sin(2 * Math.PI * (60 + 30 * t) * t) * 0.25;
        return [(noise() * 0.5 + rumble) * e * 0.4, (noise() * 0.5 + rumble) * e * 0.4];
      });
      biquad(n.l, "lp", 1800);
      biquad(n.r, "lp", 1600);
      return n;
    }
    case "stamp":
      // A soft thud: pitched-down sine + a short paper-like noise burst.
      return render(0.4, (t) => {
        let ph = 0;
        ph = (90 + 120 * Math.exp(-t * 35)) * t;
        const body = Math.sin(2 * Math.PI * ph) * Math.exp(-t * 14);
        const paper = t < 0.04 ? noise() * Math.exp(-t * 120) * 0.5 : 0;
        const v = (body * 0.7 + paper) * 0.55;
        return [v, v];
      });
    case "chime": {
      // Two-note success chime (FM bell): A5 then D6.
      const bell = (t: number, f: number) => (t < 0 ? 0 : Math.sin(2 * Math.PI * f * t + 1.2 * Math.sin(2 * Math.PI * f * 2 * t) * Math.exp(-t * 6)) * Math.exp(-t * 5));
      return render(0.9, (t) => {
        const v = (bell(t, 880) * 0.55 + bell(t - 0.11, 1174.66) * 0.6) * 0.3;
        return [v * 0.9, v];
      });
    }
    case "confirm":
      return render(0.4, (t) => {
        const f = t < 0.08 ? 660 : 990;
        const tt = t < 0.08 ? t : t - 0.08;
        const v = Math.sin(2 * Math.PI * f * t) * Math.exp(-tt * 16) * 0.3;
        return [v, v];
      });
  }
}

// ------------------------------------------------------------------------------ WAV + loudness

export function wav(s: Stereo): Buffer {
  const n = s.l.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s.l[i]!)) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s.r[i]!)) * 32767), 46 + i * 4);
  }
  return buf;
}

export function readWav(b: Buffer): Stereo {
  // Minimal PCM16 reader (finds the data chunk).
  let o = 12;
  let channels = 2;
  let rate = SR;
  while (o < b.length) {
    const id = b.toString("ascii", o, o + 4);
    const size = b.readUInt32LE(o + 4);
    if (id === "fmt ") {
      channels = b.readUInt16LE(o + 10);
      rate = b.readUInt32LE(o + 12);
    }
    if (id === "data") {
      const n = size / 2 / channels;
      const s = stereo(n);
      for (let i = 0; i < n; i++) {
        s.l[i] = b.readInt16LE(o + 8 + i * channels * 2) / 32768;
        s.r[i] = channels > 1 ? b.readInt16LE(o + 10 + i * channels * 2) / 32768 : s.l[i]!;
      }
      if (rate !== SR) throw new Error(`expected ${SR} Hz, got ${rate}`);
      return s;
    }
    o += 8 + size;
  }
  throw new Error("no data chunk");
}

/** Integrated loudness (BS.1770-4: K-weighting, 400 ms blocks, absolute + relative gates). */
export function lufs(s: Stereo): number {
  const kw = (x: Float32Array) => {
    const y = Float32Array.from(x);
    // Stage 1: high shelf (+4 dB above ~1.5 kHz); stage 2: RLB high-pass ~38 Hz (48 kHz coeffs recomputed for SR).
    const shelf = (v: Float32Array) => {
      const f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
      const K = Math.tan((Math.PI * f0) / SR);
      const Vh = 10 ** (G / 20), Vb = Vh ** 0.4996667741545416;
      const a0 = 1 + K / Q + K * K;
      const b0 = (Vh + (Vb * K) / Q + K * K) / a0, b1 = (2 * (K * K - Vh)) / a0, b2 = (Vh - (Vb * K) / Q + K * K) / a0;
      const a1 = (2 * (K * K - 1)) / a0, a2 = (1 - K / Q + K * K) / a0;
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < v.length; i++) {
        const o = b0 * v[i]! + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = v[i]!; y2 = y1; y1 = o; v[i] = o;
      }
    };
    const hp = (v: Float32Array) => {
      const f0 = 38.13547087602444, Q = 0.5003270373238773;
      const K = Math.tan((Math.PI * f0) / SR);
      const a0 = 1 + K / Q + K * K;
      const a1 = (2 * (K * K - 1)) / a0, a2 = (1 - K / Q + K * K) / a0;
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < v.length; i++) {
        const o = (v[i]! - 2 * x1 + x2) / a0 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = v[i]!; y2 = y1; y1 = o; v[i] = o;
      }
    };
    shelf(y);
    hp(y);
    return y;
  };
  const l = kw(s.l);
  const r = kw(s.r);
  const block = Math.floor(0.4 * SR);
  const hop = Math.floor(0.1 * SR);
  const z: number[] = [];
  for (let i = 0; i + block <= l.length; i += hop) {
    let e = 0;
    for (let j = i; j < i + block; j++) e += l[j]! * l[j]! + r[j]! * r[j]!;
    z.push(e / block);
  }
  const L = (m: number) => -0.691 + 10 * Math.log10(m);
  const abs = z.filter((m) => L(m) > -70);
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const rel = L(mean(abs)) - 10;
  return L(mean(abs.filter((m) => L(m) > rel)));
}

export const peakDb = (s: Stereo) => {
  let p = 0;
  for (let i = 0; i < s.l.length; i++) p = Math.max(p, Math.abs(s.l[i]!), Math.abs(s.r[i]!));
  return 20 * Math.log10(p);
};

const padTo = (x: Float32Array, n: number) => {
  const y = new Float32Array(Math.ceil(n));
  y.set(x);
  return y;
};

export function normalize(s: Stereo, targetLufs: number, ceilingDb: number): Stereo {
  // Effects shorter than one 400 ms gating block have no BS.1770 loudness: pad them with silence to
  // measure (a short sound measured over 400 ms, like a listener hears it).
  const measured = s.l.length >= 0.4 * SR ? lufs(s) : lufs({ l: padTo(s.l, 0.4 * SR), r: padTo(s.r, 0.4 * SR) });
  const g = 10 ** ((targetLufs - measured) / 20);
  for (let i = 0; i < s.l.length; i++) {
    s.l[i]! *= g;
    s.r[i]! *= g;
  }
  // Soft limiter at the ceiling (tanh knee), so nothing clips.
  const c = 10 ** (ceilingDb / 20);
  for (let i = 0; i < s.l.length; i++) {
    s.l[i] = c * Math.tanh(s.l[i]! / c);
    s.r[i] = c * Math.tanh(s.r[i]! / c);
  }
  return s;
}

export async function generateAudio() {
  await mkdir(OUT, { recursive: true });
  const m = normalize(music(), -13, -1);
  await writeFile(resolve(OUT, "music.wav"), wav(m));
  const fx = new Map<SfxName, Stereo>();
  for (const name of SFX) {
    const s = normalize(sfx(name), -16, -1);
    fx.set(name, s);
    await writeFile(resolve(OUT, `${name}.wav`), wav(s));
  }
  // The full mix, exactly as Soundtrack.tsx places it.
  const data = ShowreelDataSchema.parse(JSON.parse(await readFile(resolve(here, "../src/data.json"), "utf8")));
  const all = cues(data);
  const mix = stereo(SECONDS * SR);
  for (let i = 0; i < mix.l.length; i++) {
    const g = MUSIC_GAIN * duck(Math.floor((i / SR) * FPS), all);
    mix.l[i] = m.l[i]! * g;
    mix.r[i] = m.r[i]! * g;
  }
  for (const c of all) mixInto(mix, fx.get(c.sfx)!, c.gain * SFX_GAIN, Math.round((c.frame / FPS) * SR));
  console.log(`music: ${lufs(m).toFixed(1)} LUFS, peak ${peakDb(m).toFixed(1)} dBFS`);
  console.log(`mix (music + ${all.length} cues): ${lufs(mix).toFixed(1)} LUFS, peak ${peakDb(mix).toFixed(1)} dBFS`);
  console.log(`wrote ${SFX.length + 1} WAVs to ${OUT}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await generateAudio();
