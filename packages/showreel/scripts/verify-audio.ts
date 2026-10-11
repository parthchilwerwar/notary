// Checks the rendered film: an H.264 video stream and an AAC audio stream (Remotion's own bundled
// ffprobe), then decodes the soundtrack (bundled ffmpeg) and prints its integrated loudness
// (BS.1770, same meter as scripts/audio.ts) and peak.
//   pnpm --filter @notary/showreel verify-audio [path/to/film.mp4]
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { lufs, peakDb, readWav } from "./audio";
import { OUT, ROOT, remotionBinary } from "./lib";

const film = resolve(process.argv[2] ?? resolve(ROOT, "../../docs/media/notary-showreel.mp4"));
const exe = remotionBinary;

const probe = execFileSync(exe("ffprobe"), ["-v", "error", "-show_entries", "stream=codec_type,codec_name,sample_rate,channels,width,height,nb_frames,duration", "-of", "compact", film], { encoding: "utf8" });
console.log(probe.trim());
if (!/codec_type=audio/.test(probe) || !/codec_name=aac/.test(probe)) throw new Error("No AAC audio stream in the film");
if (!/codec_name=h264/.test(probe)) throw new Error("No H.264 video stream in the film");
const wav = resolve(OUT, "film-audio.wav");
execFileSync(exe("ffmpeg"), ["-v", "error", "-y", "-i", film, "-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", wav]);
const s = readWav(await readFile(wav));
console.log(`soundtrack: ${(s.l.length / 44100).toFixed(2)} s, ${lufs(s).toFixed(1)} LUFS integrated, peak ${peakDb(s).toFixed(1)} dBFS`);
