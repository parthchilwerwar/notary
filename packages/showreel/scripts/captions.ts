// Rebuilds explainer/voice/captions.srt from explainer/voice/timing.json and the per-section word timings
// (explainer/voice/<sectionId>.json). Sentence-level cues, at most 2 lines of at most 42 characters; a
// sentence too long for one cue is split, preferring a break after a comma, colon or semicolon.
//
//   pnpm --filter @notary/showreel captions
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const VOICE_DIR = resolve(here, "../explainer/voice");
export const MAX_LINE = 42;
export const MAX_LINES = 2;
export const MIN_CUE_SEC = 1.0;

type Word = { text: string; startSec: number; endSec: number };
type Timing = { gapSec: number; sections: { id: string; startSec: number | null; durationSec: number | null }[] };
export type Cue = { startSec: number; endSec: number; lines: string[] };

/** Greedy wrap into lines of at most `max` characters; null when it needs more than MAX_LINES lines. */
export function wrap(words: string[], max = MAX_LINE): string[] | null {
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (w.length > max) return null;
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= max) cur += ` ${w}`;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length <= MAX_LINES ? lines : null;
}

/** Sentences (words up to one ending in . ? or !), each split into cues that fit 2 x 42. */
export function cuesForWords(words: Word[], offsetSec: number): Cue[] {
  const sentences: Word[][] = [];
  let cur: Word[] = [];
  for (const w of words) {
    cur.push(w);
    if (/[.?!]["')\]]?$/.test(w.text)) {
      sentences.push(cur);
      cur = [];
    }
  }
  if (cur.length) sentences.push(cur);
  // A sentence shorter than MIN_CUE_SEC ("Notary.") joins the next one when both fit in one cue.
  for (let i = 0; i < sentences.length - 1; i++) {
    const s = sentences[i]!;
    const merged = [...s, ...sentences[i + 1]!];
    if (s[s.length - 1]!.endSec - s[0]!.startSec < MIN_CUE_SEC && wrap(merged.map((w) => w.text))) sentences.splice(i, 2, merged);
  }

  const cues: Cue[] = [];
  const emit = (ws: Word[]) => {
    const lines = wrap(ws.map((w) => w.text))!;
    cues.push({ startSec: offsetSec + ws[0]!.startSec, endSec: offsetSec + ws[ws.length - 1]!.endSec, lines });
  };
  for (const sentence of sentences) {
    let rest = sentence;
    while (rest.length) {
      if (wrap(rest.map((w) => w.text))) {
        emit(rest);
        break;
      }
      // Longest prefix that fits; then back off to a clause break in its second half if there is one.
      let n = 1;
      while (n < rest.length && wrap(rest.slice(0, n + 1).map((w) => w.text))) n++;
      let cut = n;
      for (let k = n; k >= Math.ceil(n / 2); k--) {
        if (/[,;:]$/.test(rest[k - 1]!.text)) {
          cut = k;
          break;
        }
      }
      emit(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
  }
  return cues;
}

const srtTime = (sec: number) => {
  const ms = Math.max(0, Math.round(sec * 1000));
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

/** Writes captions.srt; returns the number of cues. */
export async function buildCaptions(voiceDir = VOICE_DIR): Promise<number> {
  const timing = JSON.parse(readFileSync(resolve(voiceDir, "timing.json"), "utf8")) as Timing;
  const cues: Cue[] = [];
  for (const s of timing.sections) {
    const p = resolve(voiceDir, `${s.id}.json`);
    if (s.startSec === null || !existsSync(p)) continue;
    const { words } = JSON.parse(readFileSync(p, "utf8")) as { words: Word[] };
    cues.push(...cuesForWords(words, s.startSec));
  }
  cues.sort((a, b) => a.startSec - b.startSec);
  // A cue never runs into the next one.
  for (let i = 0; i < cues.length - 1; i++) cues[i]!.endSec = Math.min(cues[i]!.endSec, cues[i + 1]!.startSec - 0.001);
  const srt = cues.map((c, i) => `${i + 1}\n${srtTime(c.startSec)} --> ${srtTime(c.endSec)}\n${c.lines.join("\n")}\n`).join("\n");
  await writeFile(resolve(voiceDir, "captions.srt"), srt);
  return cues.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildCaptions()
    .then((n) => console.log(`captions.srt: ${n} cues`))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
