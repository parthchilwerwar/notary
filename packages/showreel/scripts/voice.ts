// Voices the submission-video narration with ElevenLabs, one mp3 per section of docs/video/NARRATION.md,
// plus word timings from the API's character alignment. Never logs or writes the key.
//
//   pnpm --filter @notary/showreel voice                 # every section (cached sections are skipped)
//   pnpm --filter @notary/showreel voice --skip neatlogs # leave a section out (e.g. while its text is under review)
//   pnpm --filter @notary/showreel voice --only intro    # just these sections
//
// Output (explainer/voice/):
//   <sectionId>.mp3   mp3_44100_128
//   <sectionId>.json  { sectionId, voiceId, voiceName, modelId, textHash, text, durationSec, words: [{ text, startSec, endSec }] }
//   timing.json       sections back to back in manifest order with gapSec between them (not rewritten when it has "locked": true)
//   captions.srt      rebuilt from timing.json (see scripts/captions.ts)
//
// Cache: a section is skipped when its mp3 + json exist and the json's textHash, voiceId and modelId match,
// so re-runs spend no credits. The text is never changed here: it is read verbatim from NARRATION.md.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCaptions } from "./captions.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const REPO = resolve(ROOT, "../..");
const EXPLAINER = resolve(ROOT, "explainer");
const VOICE_DIR = resolve(EXPLAINER, "voice");

/** Daniel — Steady Broadcaster (ElevenLabs premade; British, formal, informative/educational). */
export const VOICE = { id: "onwK4e9ZLuTAKqWW03F9", name: "Daniel - Steady Broadcaster" } as const;
export const MODEL_ID = "eleven_multilingual_v2";
const OUTPUT_FORMAT = "mp3_44100_128";
const VOICE_SETTINGS = { stability: 0.5, similarity_boost: 0.75, style: 0.05, use_speaker_boost: true, speed: 1.0 };
const SEED = 20261012;
export const DEFAULT_GAP_SEC = 0.4;
const API = "https://api.elevenlabs.io";

export type Word = { text: string; startSec: number; endSec: number };
export type VoiceSection = {
  sectionId: string;
  voiceId: string;
  voiceName: string;
  modelId: string;
  textHash: string;
  text: string;
  durationSec: number;
  words: Word[];
};

export const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** `## <id>` headings and the paragraph under each, verbatim (whitespace collapsed). */
export function parseNarration(md: string): Map<string, string> {
  const out = new Map<string, string>();
  let id: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (id) out.set(id, buf.join(" ").replace(/\s+/g, " ").trim());
  };
  for (const line of md.split(/\r?\n/)) {
    const m = /^##\s+(\S+)\s*$/.exec(line);
    if (m) {
      flush();
      id = m[1]!;
      buf = [];
    } else if (id && line.trim()) buf.push(line.trim());
  }
  flush();
  return out;
}

export function manifestSectionIds(): string[] {
  const manifest = JSON.parse(readFileSync(resolve(EXPLAINER, "manifest.json"), "utf8")) as { sections: { id: string }[] };
  return manifest.sections.map((s) => s.id);
}

/** Character alignment -> word timings (a word is a maximal run of non-whitespace characters). */
export function wordsFromAlignment(a: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] }): Word[] {
  const words: Word[] = [];
  let cur: Word | null = null;
  a.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) {
      if (cur) words.push(cur);
      cur = null;
      return;
    }
    const s = a.character_start_times_seconds[i]!;
    const e = a.character_end_times_seconds[i]!;
    if (!cur) cur = { text: ch, startSec: s, endSec: e };
    else {
      cur.text += ch;
      cur.endSec = Math.max(cur.endSec, e);
    }
  });
  if (cur) words.push(cur);
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return words.map((w) => ({ text: w.text, startSec: r(w.startSec), endSec: r(w.endSec) }));
}

/** Exact duration of an MPEG-1/2 Layer III file by walking its frame headers (skips ID3v2 / Xing). */
export function mp3DurationSec(buf: Uint8Array): number {
  const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
  const RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  let o = 0;
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) o = 10 + ((buf[6]! << 21) | (buf[7]! << 14) | (buf[8]! << 7) | buf[9]!);
  let samples = 0;
  let rate = 0;
  while (o + 4 <= buf.length) {
    if (buf[o] !== 0xff || (buf[o + 1]! & 0xe0) !== 0xe0) {
      o++;
      continue;
    }
    const ver = (buf[o + 1]! >> 3) & 3;
    const layer = (buf[o + 1]! >> 1) & 3;
    const bi = buf[o + 2]! >> 4;
    const ri = (buf[o + 2]! >> 2) & 3;
    const pad = (buf[o + 2]! >> 1) & 1;
    if (ver === 1 || layer !== 1 || bi === 0 || bi === 15 || ri === 3) {
      o++;
      continue;
    }
    rate = RATES[ver]![ri]!;
    const kbps = (ver === 3 ? BITRATES_V1 : BITRATES_V2)[bi]!;
    const spf = ver === 3 ? 1152 : 576;
    const len = Math.floor(((spf / 8) * kbps * 1000) / rate) + pad;
    samples += spf;
    o += len;
  }
  if (!rate) throw new Error("not an MP3 stream");
  return Math.round((samples / rate) * 1000) / 1000;
}

type Timing = { gapSec: number; locked?: boolean; note?: string; sections: { id: string; startSec: number | null; durationSec: number | null; missing?: string }[] };

/** Sections back to back in manifest order; a section without audio is listed as missing and takes no time. */
export function buildTiming(ids: string[], durations: Map<string, number>, gapSec = DEFAULT_GAP_SEC): Timing {
  let t = 0;
  const sections = ids.map((id) => {
    const d = durations.get(id);
    if (d === undefined) return { id, startSec: null, durationSec: null, missing: "no voice file yet" };
    const row = { id, startSec: Math.round(t * 1000) / 1000, durationSec: d };
    t += d + gapSec;
    return row;
  });
  return { gapSec, note: "Sections play back to back in manifest order with gapSec between them. Edit startSec/gapSec freely and set locked: true so `voice` keeps your edits; then run `pnpm --filter @notary/showreel captions`.", sections };
}

function arg(name: string): string[] {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]!.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

async function main() {
  process.loadEnvFile(resolve(REPO, ".env"));
  const key = (process.env.ELEVENLABS_API_KEY ?? "").trim();
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set in .env");
  const scrub = (s: string) => (key ? s.split(key).join("[REDACTED]") : s);
  const headers = { "xi-api-key": key };

  const narration = parseNarration(await readFile(resolve(REPO, "docs/video/NARRATION.md"), "utf8"));
  const ids = manifestSectionIds();
  const missingText = ids.filter((id) => !narration.has(id));
  if (missingText.length) throw new Error(`NARRATION.md has no section for: ${missingText.join(", ")}`);
  const only = arg("only");
  const skip = new Set(arg("skip"));
  const wanted = ids.filter((id) => (only.length ? only.includes(id) : true) && !skip.has(id));

  const quota = async () => {
    const r = await fetch(`${API}/v1/user/subscription`, { headers });
    if (!r.ok) return null;
    const j = (await r.json()) as { character_count: number; character_limit: number; tier: string };
    return { used: j.character_count, limit: j.character_limit, tier: j.tier };
  };
  const before = await quota();

  await mkdir(VOICE_DIR, { recursive: true });
  let spent = 0;
  for (const id of wanted) {
    const text = narration.get(id)!;
    const textHash = sha256(text);
    const mp3Path = resolve(VOICE_DIR, `${id}.mp3`);
    const jsonPath = resolve(VOICE_DIR, `${id}.json`);
    if (existsSync(mp3Path) && existsSync(jsonPath)) {
      const prev = JSON.parse(await readFile(jsonPath, "utf8")) as VoiceSection;
      if (prev.textHash === textHash && prev.voiceId === VOICE.id && prev.modelId === MODEL_ID) {
        console.log(`${id}: cached (${prev.durationSec}s)`);
        continue;
      }
    }
    // Request stitching: the neighbouring sections' text gives the model the surrounding prosody.
    const i = ids.indexOf(id);
    const body = {
      text,
      model_id: MODEL_ID,
      voice_settings: VOICE_SETTINGS,
      seed: SEED,
      ...(i > 0 ? { previous_text: narration.get(ids[i - 1]!)! } : {}),
      ...(i < ids.length - 1 ? { next_text: narration.get(ids[i + 1]!)! } : {}),
    };
    const res = await fetch(`${API}/v1/text-to-speech/${VOICE.id}/with-timestamps?output_format=${OUTPUT_FORMAT}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${id}: ElevenLabs HTTP ${res.status}: ${scrub((await res.text()).slice(0, 400))}`);
    const j = (await res.json()) as {
      audio_base64: string;
      alignment: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] } | null;
    };
    if (!j.alignment) throw new Error(`${id}: no alignment in the response`);
    const audio = Buffer.from(j.audio_base64, "base64");
    const out: VoiceSection = {
      sectionId: id,
      voiceId: VOICE.id,
      voiceName: VOICE.name,
      modelId: MODEL_ID,
      textHash,
      text,
      durationSec: mp3DurationSec(audio),
      words: wordsFromAlignment(j.alignment),
    };
    await writeFile(mp3Path, audio);
    await writeFile(jsonPath, JSON.stringify(out, null, 2) + "\n");
    spent += text.length;
    console.log(`${id}: voiced ${text.length} chars -> ${out.durationSec}s, ${out.words.length} words`);
  }

  // timing.json + captions.srt from whatever voice files exist now.
  const durations = new Map<string, number>();
  for (const id of ids) {
    const p = resolve(VOICE_DIR, `${id}.json`);
    if (existsSync(p) && existsSync(resolve(VOICE_DIR, `${id}.mp3`))) durations.set(id, (JSON.parse(readFileSync(p, "utf8")) as VoiceSection).durationSec);
  }
  const timingPath = resolve(VOICE_DIR, "timing.json");
  const prevTiming = existsSync(timingPath) ? (JSON.parse(readFileSync(timingPath, "utf8")) as Timing) : null;
  if (prevTiming?.locked) console.log("timing.json is locked; left as is");
  else await writeFile(timingPath, JSON.stringify(buildTiming(ids, durations, prevTiming?.gapSec ?? DEFAULT_GAP_SEC), null, 2) + "\n");
  const cues = await buildCaptions();
  const after = await quota();
  const total = [...durations.values()].reduce((a, b) => a + b, 0);
  console.log(`voiced sections: ${durations.size}/${ids.length}; speech ${total.toFixed(2)}s; captions: ${cues} cues`);
  console.log(`characters requested this run: ${spent}`);
  if (before && after) console.log(`ElevenLabs ${after.tier}: used ${after.used}/${after.limit} (this run ${after.used - before.used}), remaining ${after.limit - after.used}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
