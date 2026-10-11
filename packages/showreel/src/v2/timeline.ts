// v2 timeline: 30 fps, 450 frames, on a 120 BPM grid (one beat = 15 frames, one bar = 60) so the
// music's downbeats land on the cuts. Every scene and every sound cue reads its frame from here.
export const FPS = 30;
export const DURATION = 450;
export const BEAT = 15;

export const V = {
  // 1 · Sky: headline, the hero's "Open dashboard", the cursor clicks it.
  headline: 4,
  heroActions: 18,
  cursorIn: 20,
  clickOpen: 46,
  // The dive through the clouds onto the dashboard.
  diveStart: 50,
  diveDur: 38,
  // 2 · The run without Notary, in the real Run page.
  dashIn: 62,
  rowsStart: 96,
  rowsEnd: 136,
  dashOut: 146,
  // 3 · Read → Test → Challenge → Certify (the landing's How it works pieces).
  bar: 146,
  predict: 152,
  challenge: 196,
  certify: 228,
  certFly: 262,
  // 4 · Enforce, back in the Run page for the run with Notary.
  enforce: 266,
  certLand: 290,
  scrollUp: 292,
  heldFocus: 306,
  approveHover: 312,
  chartIn: 314,
  enforceOut: 342,
  // 5 · Notary Chat.
  chatNav: 344,
  chatPage: 350,
  composerClick: 356,
  typeStart: 358,
  typeEnd: 376,
  send: 380,
  streamStart: 383,
  streamEnd: 404,
  // 6 · Close.
  pullStart: 404,
  pullDur: 32,
  closeTitle: 408,
  wordmark: 414,
  settled: 434,
} as const;

/** The five-step bar during the proof (frames when each step becomes current). */
export const STEPS2 = [
  { label: "Read", at: V.predict },
  { label: "Test", at: V.predict + 12 },
  { label: "Challenge", at: V.challenge },
  { label: "Certify", at: V.certify },
  { label: "Enforce", at: V.enforce },
] as const;
