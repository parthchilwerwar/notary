// The Explainer's clock: every section lasts as long as its voice line (plus a short lead-in and
// tail), so the picture follows the narration rather than the other way round. Pure functions of
// assets.json (scripts/explainer-prep.ts) — shared by the composition, the audio script and the
// caption/SRT writer.
import raw from "./assets.json";
import { AssetsSchema, SECTION_IDS, type SectionId } from "./schema";

export const A = AssetsSchema.parse(raw);
export const FPS = 30;
/** Each scene keeps drawing this many frames into the next one, which fades in over it. */
export const OVERLAP = 12;

// Sections after the intro open on a numbered title card (~1 s) before the voice starts.
const LEAD: Record<SectionId, number> = { intro: 0.6, problem: 0.6, notary: 0.45, neatlogs: 0.45, entire: 0.45, cfo: 0.45, close: 0.45 };
const TAIL: Record<SectionId, number> = { intro: 1.2, problem: 0.6, notary: 0.6, neatlogs: 0.6, entire: 0.6, cfo: 0.6, close: 1.0 };

export const norm = (w: string) => w.toLowerCase().replace(/[’']/g, "").replace(/[^\p{L}\p{N}$.]/gu, "").replace(/\.$/, "");

export type TimedWord = { text: string; norm: string; from: number; to: number; section: SectionId };
export type Section = {
  id: SectionId;
  /** Absolute first frame. */
  from: number;
  dur: number;
  /** Frame (relative to the section) the voice starts. */
  voiceAt: number;
  voiceSrc: string | null;
  placeholder: boolean;
  /** Words with frames relative to the section. */
  words: TimedWord[];
};

export const SECTIONS: Section[] = (() => {
  let at = 0;
  return SECTION_IDS.map((id) => {
    const v = A.voice[id]!;
    const voiceAt = Math.round(LEAD[id] * FPS);
    const dur = Math.round((LEAD[id] + v.durationSec + TAIL[id]) * FPS);
    const words = v.words.map((w) => ({ text: w.text, norm: norm(w.text), from: voiceAt + Math.round(w.startSec * FPS), to: voiceAt + Math.round(w.endSec * FPS), section: id }));
    const s: Section = { id, from: at, dur, voiceAt, voiceSrc: v.src, placeholder: v.status !== "real", words };
    at += dur;
    return s;
  });
})();

export const TOTAL = SECTIONS.reduce((n, s) => n + s.dur, 0);
export const section = (id: SectionId) => SECTIONS.find((s) => s.id === id)!;

/**
 * Frame (relative to the section) where `phrase` starts being spoken: its words matched in order
 * (normalized). `nth` picks a later occurrence. When the voice line has no such phrase (the text was
 * edited), falls back to `fallback` × the voice length so the cut still lands, and warns.
 */
export function cue(id: SectionId, phrase: string, opts: { nth?: number; fallback?: number; end?: boolean } = {}): number {
  const s = section(id);
  const want = phrase.split(/\s+/).map(norm).filter(Boolean);
  let seen = 0;
  for (let i = 0; i + want.length <= s.words.length; i++) {
    if (want.every((w, k) => s.words[i + k]!.norm === w)) {
      if (seen++ === (opts.nth ?? 0)) return opts.end ? s.words[i + want.length - 1]!.to : s.words[i]!.from;
    }
  }
  const last = s.words.at(-1)!.to;
  if (typeof console !== "undefined") console.warn(`cue: "${phrase}" not in the ${id} voice line; using ${opts.fallback ?? 0.5} of it`);
  return Math.round(s.voiceAt + (last - s.voiceAt) * (opts.fallback ?? 0.5));
}

/** Last spoken frame of the section (relative). */
export const voiceEnd = (id: SectionId) => section(id).words.at(-1)!.to;

// ------------------------------------------------------------------------------- captions

export type CaptionPage = { from: number; to: number; words: TimedWord[]; section: SectionId };

/**
 * Caption pages: one sentence per page; a sentence longer than ~58 characters is split into balanced
 * pieces (preferring a break after a comma), so no page is a lone word and none exceeds two lines.
 */
export function captionPages(): CaptionPage[] {
  const MAX = 58;
  const pages: CaptionPage[] = [];
  for (const s of SECTIONS) {
    const sentences: TimedWord[][] = [[]];
    s.words.forEach((w, i) => {
      const cur = sentences.at(-1)!;
      if (cur.length && w.from - cur.at(-1)!.to > 24) sentences.push([]);
      sentences.at(-1)!.push(w);
      if (/[.?!]$/.test(w.text) && i < s.words.length - 1) sentences.push([]);
    });
    for (const sent of sentences.filter((x) => x.length)) {
      const len = sent.map((w) => w.text).join(" ").length;
      const k = Math.ceil(len / MAX);
      const target = len / k;
      let cur: TimedWord[] = [];
      let curLen = 0;
      const flush = () => {
        if (cur.length) pages.push({ from: s.from + cur[0]!.from, to: s.from + cur.at(-1)!.to, words: cur.map((w) => ({ ...w, from: s.from + w.from, to: s.from + w.to })), section: s.id });
        cur = [];
        curLen = 0;
      };
      sent.forEach((w, i) => {
        cur.push(w);
        curLen += (curLen ? 1 : 0) + w.text.length;
        const rest = sent.slice(i + 1).map((x) => x.text).join(" ").length;
        const comma = /[,:;]$/.test(w.text);
        if (rest > 0 && pages.length >= 0 && ((comma && curLen >= target * 0.6) || curLen >= target) && rest >= 12) flush();
      });
      flush();
    }
  }
  // Hold each page a little past its last word, never into the next one.
  return pages.map((p, i) => ({ ...p, to: Math.min(p.to + 8, (pages[i + 1]?.from ?? Infinity) - 1) }));
}

const ts = (frame: number) => {
  const ms = Math.round((frame / FPS) * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
};

export function srt(): string {
  return captionPages()
    .map((p, i) => `${i + 1}\n${ts(p.from)} --> ${ts(p.to)}\n${p.words.map((w) => w.text).join(" ")}\n`)
    .join("\n");
}

/**
 * The words of `phrase` as the voice says them: each with the frame (relative to the section) it
 * starts. When the line has no such phrase, the words are spread from `fallbackAt`, 4 frames apart.
 */
export function phraseWords(id: SectionId, phrase: string, fallbackAt = 0): { text: string; from: number }[] {
  const s = section(id);
  const want = phrase.split(/\s+/).filter(Boolean);
  const n = want.map(norm);
  for (let i = 0; i + n.length <= s.words.length; i++) {
    if (n.every((w, k) => s.words[i + k]!.norm === w)) return want.map((t, k) => ({ text: t, from: s.words[i + k]!.from }));
  }
  return want.map((t, k) => ({ text: t, from: fallbackAt + k * 4 }));
}
