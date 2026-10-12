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
    read: cue("notary", "It reads"),
    test: cue("notary", "Before each test call"),
    commits: cue("notary", "commits a prediction"),
    hashed: cue("notary", "hashed"),
    afterwards: cue("notary", "change afterwards"),
    calls: cue("notary", "calls the API", { fallback: 0.36 }),
    compare: cue("notary", "compares"),
    challenge: cue("notary", "A Reflector"),
    adversary: cue("notary", "A stronger Adversary"),
    narrowed: cue("notary", "narrowed"),
    certify: cue("notary", "What survives"),
    certificate: cue("notary", "becomes a certificate", { fallback: 0.7 }) + 10,
    tested: cue("notary", "where it was tested"),
    rule: cue("notary", "the rule is simple", { fallback: 0.84 }),
    enforce: cue("notary", "No certificate"),
    moves: cue("notary", "no money moves"),
    guard: cue("notary", "The Guard holds"),
    person: cue("notary", "for a person"),
    get shots(): Shot[] {
      const tp = "transcript-prediction";
      const ca = "certificate-adversary";
      const cg = "certificates-grid";
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
          to: this.rule + 2,
          anchors: [
            [ev(cg, "active", 0.9), this.certificate - 8],
            [ev(cg, "wallet.idempotency", 10.0), this.rule - 10],
          ],
          callouts: [{ label: "active", text: `${A.data.certificates.length} certificates`, dx: 260, dy: 90 }],
        },
      ];
    },
  },
  stack: {
    dodo: cue("stack", "Dodo Payments is where"),
    refunds: cue("stack", "refunds"),
    credits: cue("stack", "credits"),
    plan: cue("stack", "plan changes"),
    test: cue("stack", "test mode"),
    four: cue("stack", "certified four"),
    pages: cue("stack", "page limits"),
    wallet: cue("stack", "wallet credit units"),
    idem: cue("stack", "idempotency keys"),
    crust: cue("stack", "Crustdata tells"),
    customer: cue("stack", "who each customer is"),
    policy: cue("stack", "the right policy"),
    models: cue("stack", "The models run"),
    litellm: cue("stack", "LiteLLM gateway"),
    reflector: cue("stack", "Reflector"),
    adversary: cue("stack", "Adversary"),
    aws: cue("stack", "built to run on AWS"),
    scripts: cue("stack", "deploy scripts"),
    ecs: cue("stack", "on ECS"),
    bedrock: cue("stack", "Amazon Bedrock"),
    account: cue("stack", "AWS account"),
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
    exports: cue("cfo", "It exports"),
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
    proved: cue("close", "here is what Notary proved"),
    three: cue("close", "Three documented claims"),
    five: cue("close", "Five certificates"),
    zero: cue("close", "Zero unguarded"),
    cents: cue("close", "about three cents"),
    sky: cue("close", "Notary", { nth: 1 }) - 10,
    notary: cue("close", "Notary", { nth: 1 }),
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
  return absFrame < intro.from + intro.dur || absFrame >= close.from + P.close.three - 2;
};

export const LAST_VOICE = SECTIONS.at(-1)!.from + voiceEnd("close");

/** The close's results, each read from the real runs' files, with the word it lands on. */
export function closeStats() {
  const d = A.data;
  const claims = d.incidents.filter((i) => i.kind === "checker_anomaly").length;
  const certs = d.certificates.length;
  const narrowed = d.certificates.filter((c) => c.adversaryVerdict === "narrow").length;
  const covLine = d.coverage?.lines.find((l) => /unguarded_call_sites = \d+/.test(l));
  const unguarded = covLine ? Number(covLine.match(/unguarded_call_sites = (\d+)/)![1]) : (d.entire.coverage?.unguardedCallSites ?? null);
  const cents = Math.round(d.economics.costPerRun.usd * 100) / 100;
  return [
    { key: "claims", value: claims, decimals: 0, prefix: "", text: "documented claims that didn't hold", at: P.close.three, source: "incidents (checker anomalies)" },
    { key: "certs", value: certs, decimals: 0, prefix: "", text: narrowed === certs ? "certificates, each narrowed by the Adversary" : "certificates", at: P.close.five, source: "certificates" },
    ...(unguarded !== null ? [{ key: "unguarded", value: unguarded, decimals: 0, prefix: "", text: "unguarded money calls", at: P.close.zero, source: "coverage.txt" }] : []),
    { key: "cost", value: cents, decimals: 2, prefix: "≈ $", text: "per run", at: P.close.cents, source: "economics.json" },
  ];
}
