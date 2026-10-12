// What happens when, inside each section: cuts and reveals land on the words that name them (cue()
// on the voice's word timings). Shared by the scenes and the sound cue sheet, so a click sound always
// lands on the cursor's click and a stamp on the stamp.
//
// Clips are time-warped onto the voice: a shot lists anchors [clip second, scene frame] — "this moment
// of the recording happens when the voice says this word" — taken from the recording's own event log
// (its labelled moves and clicks). Between anchors the clip plays faster (up to 2.5×) or, when it
// would have to crawl, holds still and then plays at normal speed into the anchor. Nothing is
// reordered: clip time only moves forward.
import type { SectionId } from "./schema";
import { A, cue, FPS, OVERLAP, section, SECTIONS, voiceEnd } from "./timeline";

export type Anchor = readonly [clipSec: number, frame: number];
export type Shot = { clipId: string; from: number; to: number; start?: number; anchors?: Anchor[]; zoom?: { at: number; s: number; x: number; y: number }[] };

const end = (id: SectionId) => section(id).dur + OVERLAP;

/** Clip second of the first logged event whose label contains `text` (else `fallback`). */
function ev(clipId: string, text: string, fallback: number): number {
  const c = A.clips[clipId];
  const e = c?.events.find((x) => x.label?.includes(text));
  return e ? e.tSec : fallback;
}

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
    live: cue("problem", "Live"),
    error: cue("problem", "an error"),
    three: cue("problem", "three"),
    separate: cue("problem", "separate"),
    trusts: cue("problem", "An agent that trusts"),
    get shots(): Shot[] {
      const id = "crustdata-anomalies";
      return [
        {
          clipId: id,
          from: this.clipIn,
          to: end("problem"),
          anchors: [
            [ev(id, "enrich no-match", 5.3), this.ownDocs + 8],
            [ev(id, "recorded response", 7.3), this.live - 6],
            [ev(id, "identify no-match", 9.2), this.three - 4],
            [ev(id, "identify invalid fields", 11.4), this.separate + 18],
          ],
        },
      ];
    },
  },
  notary: {
    bar: 0,
    read: cue("notary", "It reads"),
    test: cue("notary", "Before each test call"),
    commits: cue("notary", "commits a prediction"),
    hashed: cue("notary", "hashed"),
    afterwards: cue("notary", "change afterwards"),
    calls: cue("notary", "calls the live API"),
    compare: cue("notary", "compares"),
    challenge: cue("notary", "A Reflector"),
    adversary: cue("notary", "A stronger Adversary"),
    narrowed: cue("notary", "narrowed"),
    certify: cue("notary", "What survives"),
    certificate: cue("notary", "becomes a certificate", { fallback: 0.7 }) + 10,
    tested: cue("notary", "where it was tested"),
    enforce: cue("notary", "No certificate"),
    guard: cue("notary", "the Guard holds"),
    get shots(): Shot[] {
      const e = end("notary");
      const tp = "transcript-prediction";
      const ca = "certificate-adversary";
      const cg = "certificates-grid";
      const ah = "approvals-held";
      return [
        {
          clipId: tp,
          from: this.read - 8,
          to: this.challenge - 4,
          anchors: [
            [ev(tp, "committed prediction", 1.1), this.commits],
            [ev(tp, "prediction hash", 2.9), this.hashed],
            [ev(tp, "commit time", 4.6), this.afterwards],
            [ev(tp, "observation", 6.0), this.calls + 12],
            [ev(tp, "predicted (committed first)", 7.8), this.compare + 4],
          ],
        },
        {
          clipId: ca,
          from: this.challenge - 4,
          to: this.certify - 4,
          start: Math.max(0, ev(ca, "observed", 2.3) - 0.4),
          anchors: [
            [ev(ca, "Adversary", 7.5), this.adversary + 4],
            [ev(ca, "verdict", 9.0), this.narrowed],
            [ev(ca, "scope narrowed", 11.9), this.certify - 30],
          ],
        },
        {
          clipId: cg,
          from: this.certify - 4,
          to: this.enforce - 4,
          anchors: [
            [ev(cg, "active", 1.0), this.certificate - 8],
            [ev(cg, "wallet.idempotency", 10.0), this.enforce - 10],
          ],
        },
        {
          clipId: ah,
          from: this.enforce - 4,
          to: e,
          anchors: [
            [ev(ah, "held by the guard", 3.6), this.guard],
            [ev(ah, "why it was held", 5.5), this.guard + 50],
            [ev(ah, "missing belief", 11.3), e - 40],
          ],
        },
      ];
    },
  },
  neatlogs: {
    trace: cue("neatlogs", "Each run is one trace"),
    agents: cue("neatlogs", "labelled by agent"),
    crust: cue("neatlogs", "On the Crustdata run"),
    probe: cue("neatlogs", "the probe for one disputed claim"),
    prediction: cue("neatlogs", "Its prediction is logged"),
    hash: cue("neatlogs", "with its hash"),
    before: cue("neatlogs", "before the call"),
    inconclusive: cue("neatlogs", "inconclusive"),
    abstained: cue("neatlogs", "abstained"),
    open: cue("neatlogs", "Two more mismatches"),
    stillOpen: cue("neatlogs", "still open"),
    certifiedThem: cue("neatlogs", "hasn't certified them"),
    dodo: cue("neatlogs", "On the Dodo run"),
    narrowing: cue("neatlogs", "narrowing four beliefs"),
    wallet: cue("neatlogs", "Wallet credits"),
    resolved: cue("neatlogs", "Notary resolved those"),
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
            [ev(id, "resolved incident", 8.0) + 0.2, this.dodo - 30],
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
    exports: cue("cfo", "It exports"),
    get shots(): Shot[] {
      const id = "economics";
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
        },
      ];
    },
  },
  close: {
    suite: cue("close", "On our evaluation suite"),
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
    ...P.cfo.shots.map((s) => ({ ...s, section: "cfo" as const })),
  ];
}

export const shotOf = (clipId: string) => allShots().find((s) => s.clipId === clipId)!;

/**
 * The clip second shown at each scene frame of a shot (see the header). Without anchors the clip
 * plays at real speed and holds its last frame.
 */
export function warp(durationSec: number, shot: Shot) {
  const last = Math.max(0, durationSec - 1 / FPS);
  const start = shot.start ?? 0;
  const knots: Anchor[] = [[start, shot.from], ...(shot.anchors ?? []).filter(([t, f]) => t > start && t <= durationSec && f > shot.from).sort((a, b) => a[1] - b[1])];
  // Clip time never runs backwards.
  for (let i = 1; i < knots.length; i++) if (knots[i]![0] <= knots[i - 1]![0]) knots.splice(i--, 1);
  const tAt = (f: number): number => {
    for (let i = 1; i < knots.length; i++) {
      const [t0, f0] = knots[i - 1]!;
      const [t1, f1] = knots[i]!;
      if (f <= f1) {
        const need = ((t1 - t0) * FPS) / Math.max(1, f1 - f0);
        if (need < 0.7) {
          // Hold, then play at 0.9× into the anchor.
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

/** Click frames (relative to the shot's scene) of a clip: for the sound cues. */
export function clipClickFrames(shot: Shot): number[] {
  const clip = A.clips[shot.clipId];
  if (!clip || clip.status !== "real") return [];
  const w = warp(clip.durationSec, shot);
  return clip.events
    .filter((e) => e.type === "click")
    .map((e) => w.frameAt(e.tSec))
    .filter((f): f is number => f !== null);
}

/** Absolute frames where captions hide (the same words are drawn large: intro, final line). */
export const captionsHidden = (absFrame: number) => {
  const intro = section("intro");
  const close = section("close");
  return absFrame < intro.from + intro.dur || absFrame >= close.from + P.close.sky;
};

export const LAST_VOICE = SECTIONS.at(-1)!.from + voiceEnd("close");
