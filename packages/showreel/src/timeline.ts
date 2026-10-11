// The film's one timeline (30 fps, 450 frames = 15.0 s). Every scene reads its frames from here,
// so beats overlap on purpose and can be retimed in one place. See STORYBOARD.md.
export const FPS = 30;
export const DURATION = 450;

export const T = {
  // 1 · Open on the sky (0.0–2.4 s)
  headline: 4, // first word starts rising
  // Camera: sky → white page, and back.
  pushStart: 54,
  pushDur: 34, // 1.87–3.07 s
  pullStart: 400,
  pullDur: 32, // 13.33–14.4 s

  // 2 · The problem (2.4–4.6 s)
  problemTitle: 70,
  transcript: 74,
  rowsStart: 80,
  rowsEnd: 116,
  chartGrow: 82,
  chartGrowDur: 36,
  problemLeave: 124,

  // 3 · Read → Test → Challenge → Certify (4.6–8.5 s)
  bar: 130,
  predict: 134,
  challenge: 180,
  certify: 218,
  // 4 · Enforce (8.5–11.2 s)
  enforce: 260,
  enforceLeave: 334,

  // 5 · Notary Chat (11.2–13.3 s)
  chat: 342,

  // 6 · Close (13.3–15.0 s)
  closeTitle: 406,
  wordmark: 413,
  settled: 432, // the last 0.6 s hold still
} as const;

/** Stage step-bar segments, in order, and the frame each one becomes current. */
export const STEPS = [
  { label: "Read", at: T.predict },
  { label: "Test", at: T.predict + 12 },
  { label: "Challenge", at: T.challenge },
  { label: "Certify", at: T.certify },
  { label: "Enforce", at: T.enforce },
] as const;
