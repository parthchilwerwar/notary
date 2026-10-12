// What happens when, inside each section: cuts and reveals land on the words that name them (cue()
// on the voice's word timings). Shared by the scenes and the sound cue sheet, so a click sound always
// lands on the cursor's click and a stamp on the stamp.
//
// Clips are time-warped onto the voice: a shot lists anchors [clip second, scene frame] — "this moment
// of the recording happens when the voice says this word" — taken from the recording's own event log
// (its labelled moves and clicks). Between anchors the clip plays faster (up to 2.5×) or, when it
// would have to crawl, holds still and then plays at normal speed into the anchor. Nothing is
// reordered: clip time only moves forward. Callouts point at the element a logged event targets.
import type { SectionId } from "./schema";
import { A, cue, FPS, OVERLAP, section, SECTIONS, voiceEnd } from "./timeline";

export type Anchor = readonly [clipSec: number, frame: number];
/** A drawn-in callout at the target of the first logged event whose label contains `label`. */
export type Callout = { label: string; text: string; dx: number; dy: number; hold?: number };
export type Shot = { clipId: string; from: number; to: number; start?: number; anchors?: Anchor[]; zoom?: { at: number; s: number; x: number; y: number }[]; callouts?: Callout[]; lens?: boolean };

const end = (id: SectionId) => section(id).dur + OVERLAP;

/** Clip second of the first logged event whose label contains `text` (else `fallback`). */
function ev(clipId: string, text: string, fallback: number): number {
  const c = A.clips[clipId];
  const e = c?.events.find((x) => x.label?.includes(text));
  return e ? e.tSec : fallback;
}

/**
 * Zoom keys for the approvals recording: on the held card (its top edge below y 455 of the page, so
 * the header, its data banner, the token field and the "recorded run" note stay out of frame), then
 * down to the evidence pack once it is opened.
 */
function heldZoom(_clipId: string, slot: number) {
  return [
    { at: 0, s: 2.2, x: 860, y: 705 },
    { at: Math.max(1, slot - 70), s: 2.2, x: 860, y: 705 },
    { at: Math.max(2, slot - 20), s: 2.0, x: 900, y: 800 },
    { at: Math.max(3, slot), s: 2.0, x: 900, y: 800 },
  ];
}

const incident = (claimId: string) => A.data.incidents.find((i) => i.claimId === claimId);
const docsVsApi = (claimId: string) => {
  const i = incident(claimId);
  return i && i.expected !== null && i.observed !== null ? `Docs: ${i.expected} · API: ${i.observed}` : "";
};
const usd4 = (v: number) => `$${v.toFixed(4)}`;

export const P = {
  intro: (() => {
    const s = section("intro");
    return { notary: cue("intro", "Notary"), no: cue("intro", "No certificate"), moves: cue("intro", "moves"), dive: s.dur - 34 };
  })(),
  problem: {
    money: cue("problem", "real money"),
    refunds: cue("problem", "refunds"),
    plan: cue("problem", "plan changes"),
    credits: cue("problem", "credits"),
    docs: cue("problem", "from API docs"),
    disagree: cue("problem", "disagree"),
    clipIn: cue("problem", "We pointed") - 6,
    ownDocs: cue("problem", "Crustdata's own docs"),
    inRun: cue("problem", "In our run", { fallback: 0.7 }),
    three: cue("problem", "three documented claims", { fallback: 0.78 }),
    hold: cue("problem", "didn't hold", { fallback: 0.82 }),
    trusts: cue("problem", "An agent that trusts"),
    get shots(): Shot[] {
      const id = "crustdata-anomalies";
      return [
        {
          clipId: id,
          from: this.clipIn,
          to: end("problem"),
          lens: true,
          anchors: [
            [ev(id, "enrich no-match", 5.3), this.ownDocs + 8],
            [ev(id, "recorded response 400", 7.3), this.inRun - 6],
            [ev(id, "identify no-match", 9.2), this.three - 4],
            [ev(id, "identify invalid fields", 11.4), this.hold - 2],
            [ev(id, "recorded response 403", 13.4), this.trusts + 10],
          ],
          callouts: [
            { label: "recorded response 400", text: docsVsApi("crustdata.enrich.no-match-200-empty"), dx: -340, dy: 150 },
            { label: "recorded response 403", text: docsVsApi("crustdata.identify.invalid-fields-400"), dx: -340, dy: 150 },
          ],
        },
      ];
    },
  },
  notary: {
    bar: 0,
    read: cue("notary", "It turns every promise"),
    test: cue("notary", "Before each test call"),
    commits: cue("notary", "commits a hashed prediction"),
    hashed: cue("notary", "hashed"),
    afterwards: cue("notary", "before each test call"),
    calls: cue("notary", "calls the API", { fallback: 0.36 }),
    compare: cue("notary", "compares"),
    challenge: cue("notary", "A Reflector"),
    adversary: cue("notary", "A stronger Adversary"),
    narrowed: cue("notary", "narrowed"),
    certify: cue("notary", "What survives"),
    certificate: cue("notary", "becomes a certificate", { fallback: 0.7 }) + 10,
    tested: cue("notary", "becomes a certificate", { end: true }),
    enforce: cue("notary", "No certificate"),
    moves: cue("notary", "no money moves"),
    guard: cue("notary", "the Guard holds"),
    person: cue("notary", "for a person"),
    get shots(): Shot[] {
      const tp = "transcript-prediction";
      const ca = "certificate-adversary";
      const cg = "certificates-grid";
      const ah = "approvals-held";
      return [
        {
          clipId: tp,
          from: this.read - 8,
          to: this.challenge - 4,
          lens: true,
          anchors: [
            [ev(tp, "committed prediction", 1.1), this.commits],
            [ev(tp, "prediction hash", 2.8), this.hashed],
            [ev(tp, "commit time", 4.5), this.afterwards],
            [ev(tp, "observation", 6.2), this.calls + 12],
            [ev(tp, "predicted (committed first)", 8.1), this.compare + 4],
          ],
          callouts: [
            { label: "committed prediction", text: "Prediction committed first", dx: 300, dy: -110 },
            { label: "prediction hash", text: "sha256 of the prediction", dx: 120, dy: 150 },
            { label: "observation", text: "Then the API answers", dx: 320, dy: 120 },
          ],
        },
        {
          clipId: ca,
          from: this.challenge - 4,
          to: this.certify - 4,
          start: Math.max(0, ev(ca, "observed", 2.3) - 0.4),
          anchors: [
            [ev(ca, "Adversary", 7.6), this.adversary + 4],
            [ev(ca, "verdict", 9.1), this.narrowed],
            [ev(ca, "scope narrowed", 12.1), this.certify - 30],
          ],
          callouts: [
            { label: "Adversary", text: `Adversary · ${A.data.models.find((m) => m.agent === "Adversary")?.model ?? ""}`, dx: 260, dy: 130 },
            { label: "verdict", text: "Verdict: narrow", dx: 300, dy: 60 },
            { label: "scope narrowed", text: "Holds for USD only", dx: 260, dy: -120 },
          ],
        },
        {
          clipId: cg,
          from: this.certify - 4,
          to: this.enforce - 4,
          anchors: [
            [ev(cg, "active", 0.9), this.certificate - 8],
            [ev(cg, "wallet.idempotency", 10.0), this.enforce - 10],
          ],
          callouts: [{ label: "active", text: `${A.data.certificates.length} certificates`, dx: 260, dy: 90 }],
        },
        {
          clipId: ah,
          from: this.enforce - 4,
          to: end("notary"),
          anchors: [
            [ev(ah, "held by the guard", 3.6), this.guard],
            [ev(ah, "why it was held", 5.5), this.guard + 50],
            [ev(ah, "missing belief", 11.3), end("notary") - 40],
          ],
          // Close on the held card: the page's header (with its own data banner and the empty
          // token field) stays out of frame.
          zoom: heldZoom(ah, end("notary") - (this.enforce - 4)),
          callouts: [{ label: "held by the guard", text: "Held by the Guard", dx: 300, dy: -60 }],
        },
      ];
    },
  },
  neatlogs: {
    trace: cue("neatlogs", "Each run is one trace"),
    agents: cue("neatlogs", "every probe and model call"),
    crust: cue("neatlogs", "On the Crustdata run"),
    probe: cue("neatlogs", "a disputed claim's"),
    prediction: cue("neatlogs", "logged with its hash"),
    hash: cue("neatlogs", "with its hash"),
    before: cue("neatlogs", "before the call"),
    inconclusive: cue("neatlogs", "inconclusive"),
    abstained: cue("neatlogs", "abstained"),
    open: cue("neatlogs", "Two more mismatches"),
    stillOpen: cue("neatlogs", "stay open"),
    certifiedThem: cue("neatlogs", "the Guard blocks them"),
    dodo: cue("neatlogs", "On the Dodo run"),
    narrowing: cue("neatlogs", "narrowing four beliefs"),
    wallet: cue("neatlogs", "Wallet credits"),
    resolved: cue("neatlogs", "Notary certified only"),
    get lead(): { from: number; to: number } | null {
      const u = A.user.neatlogsIncidents;
      return u ? { from: 0, to: Math.min(this.crust - 4, Math.round(u.durationSec * FPS)) } : null;
    },
    get shots(): Shot[] {
      const id = "incidents-resolution";
      return [
        {
          clipId: id,
          from: this.open - 6,
          to: this.dodo + 6,
          anchors: [
            [ev(id, "3 open", 2.0), this.open + 30],
            [ev(id, "open — belief abstained", 6.1), this.stillOpen + 6],
            [ev(id, "resolved — certified", 9.9), this.dodo - 24],
          ],
          callouts: [
            { label: "3 open", text: "Still open", dx: -260, dy: 120 },
            { label: "open — belief abstained", text: "Not certified (too little evidence)", dx: 360, dy: -90 },
          ],
        },
      ];
    },
  },
  entire: {
    captured: cue("entire", "Entire captured"),
    seven: cue("entire", "Seven checkpoints"),
    graph: cue("entire", "Notary also uses"),
    every: cue("entire", "every call that can move money"),
    zero: cue("entire", "Zero unguarded"),
  },
  cfo: {
    measures: cue("cfo", "measures what certainty costs"),
    cents: cue("cfo", "three cents"),
    credits: cue("cfo", "fifteen Crustdata credits"),
    exports: cue("cfo", "exports those real costs"),
    aws: cue("cfo", "built to deploy on AWS", { fallback: 0.9 }),
    source: cue("cfo", "data source", { fallback: 0.62 }),
    get shots(): Shot[] {
      const id = "economics";
      const e = A.data.economics;
      return [
        {
          clipId: id,
          from: 0,
          to: section("cfo").dur + OVERLAP,
          anchors: [
            [ev(id, "per live run", 0.9), this.cents],
            [ev(id, "Crustdata credits", 2.5), this.credits],
            [ev(id, "per certificate", 3.9), this.credits + 44],
          ],
          // Stay on the three cost figures (the page header is not part of the story).
          zoom: [
            { at: 0, s: 1.35, x: 760, y: 360 },
            { at: this.cents - 10, s: 1.55, x: 640, y: 360 },
            { at: this.credits + 30, s: 1.45, x: 900, y: 340 },
            { at: this.exports, s: 1.4, x: 900, y: 340 },
          ],
          callouts: [
            { label: "per live run", text: `${usd4(e.costPerRun.usd)} per run`, dx: 120, dy: 200 },
            { label: "per certificate", text: `${usd4(e.costPerCertificate.usd)} per certificate`, dx: 160, dy: 210 },
          ],
        },
      ];
    },
  },
  close: {
    suite: cue("close", "On our test suite"),
    without: cue("close", "the agent without Notary"),
    nine: cue("close", "nine unsafe"),
    withN: cue("close", "With Notary"),
    zero: cue("close", "zero"),
    held: cue("close", "nine refunds held"),
    sky: cue("close", "Notary", { nth: 2 }) - 10,
    notary: cue("close", "Notary", { nth: 2 }),
    no: cue("close", "No certificate"),
    moves: cue("close", "no money moves"),
  },
} as const;

/** Every shot, with the section it plays in. */
export function allShots(): (Shot & { section: SectionId })[] {
  return [
    ...P.problem.shots.map((s) => ({ ...s, section: "problem" as const })),
    ...P.notary.shots.map((s) => ({ ...s, section: "notary" as const })),
    ...P.neatlogs.shots.map((s) => ({ ...s, section: "neatlogs" as const })),
  ];
}

/**
 * The clip second shown at each scene frame of a shot (see the header). Without anchors the clip
 * plays at real speed and holds its last frame.
 */
export function warp(durationSec: number, shot: Shot) {
  const last = Math.max(0, durationSec - 1 / FPS);
  const start = shot.start ?? 0;
  const knots: Anchor[] = [[start, shot.from], ...(shot.anchors ?? []).filter(([t, f]) => t > start && t <= durationSec && f > shot.from).sort((a, b) => a[1] - b[1])];
  for (let i = 1; i < knots.length; i++) if (knots[i]![0] <= knots[i - 1]![0]) knots.splice(i--, 1);
  const tAt = (f: number): number => {
    for (let i = 1; i < knots.length; i++) {
      const [t0, f0] = knots[i - 1]!;
      const [t1, f1] = knots[i]!;
      if (f <= f1) {
        const need = ((t1 - t0) * FPS) / Math.max(1, f1 - f0);
        if (need < 0.7) {
          const playFrames = ((t1 - t0) * FPS) / 0.9;
          const playStart = f1 - playFrames;
          return f < playStart ? t0 : t0 + ((f - playStart) * 0.9) / FPS;
        }
        return t0 + ((t1 - t0) * (f - f0)) / Math.max(1, f1 - f0);
      }
    }
    const [tl, fl] = knots.at(-1)!;
    return Math.min(last, tl + (f - fl) / FPS);
  };
  const frameAt = (t: number): number | null => {
    for (let f = shot.from; f < shot.to; f++) if (tAt(f) >= t - 1e-6) return f;
    return null;
  };
  return { tAt, frameAt };
}

/** Frames (relative to the shot's scene) of a clip's logged events of one kind, for the sound cues. */
export function clipEventFrames(shot: Shot, kind: "click" | "hover" | "callout"): number[] {
  const clip = A.clips[shot.clipId];
  if (!clip || clip.status !== "real") return [];
  const w = warp(clip.durationSec, shot);
  const events =
    kind === "click"
      ? clip.events.filter((e) => e.type === "click")
      : kind === "hover"
        ? clip.events.filter((e) => e.type === "move" && e.label && e.label !== "start")
        : (shot.callouts ?? []).map((c) => clip.events.find((e) => e.label?.includes(c.label))).filter((e): e is NonNullable<typeof e> => !!e);
  return events.map((e) => w.frameAt(e.tSec)).filter((f): f is number => f !== null);
}

/** Absolute frames where captions hide (the same words are drawn large: the intro and the close). */
export const captionsHidden = (absFrame: number) => {
  const intro = section("intro");
  const close = section("close");
  return absFrame < intro.from + intro.dur || absFrame >= close.from + P.close.sky;
};

export const LAST_VOICE = SECTIONS.at(-1)!.from + voiceEnd("close");

/** The close's results (Notary's test suite, eval-suite.json), with the word each lands on. */
export function closeStats() {
  const e = A.data.evalSuite;
  return [
    { key: "without", value: e.naiveUnsafe, label: "Without Notary", text: "unsafe money moves", at: P.close.nine, tone: "unsafe" as const },
    { key: "with", value: e.guardedUnsafe, label: "With Notary", text: "unsafe money moves", at: P.close.zero, tone: "safe" as const },
    { key: "held", value: e.held, label: "With Notary", text: "refunds held for review", at: P.close.held, tone: "held" as const },
  ];
}
