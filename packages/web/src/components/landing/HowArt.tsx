// How it works visuals (lazy). Each is a small GSAP timeline that plays once when the card comes
// into view; reduced motion shows the final state. Data: the published, hash-verified bundles of
// the guarded run's world through the data layer (see landing-data predictView / challengeView /
// certifyView). Nothing here is typed in by hand except labels.
import { useEffect, useId, useRef, useState } from "react";
import type { RunBundle } from "../../../../core/src/schema";
import { date, entryOfBundle, type DataSource, type ReplaySource } from "../../data";
import {
  certifyView,
  challengeView,
  clipText,
  clockTime,
  predictView,
  showable,
  worldNotarizeRuns,
  type ChallengeView,
  type CertifyView,
  type HowStepId,
  type PredictView,
} from "../../landing-data";
import { AgentBadge } from "../../ui/AgentBadge";
import "../../ui/kit.css";
import { gsap, MOTION_OK, useGSAP } from "./gsap";
import { memoByView, replayFor, replayPair } from "./replay";
import { SuiteLink } from "./SuiteLink";
import { fixturesInLocation } from "../../app/links";

type HowData = { predict?: PredictView; challenge?: ChallengeView; certify?: CertifyView };

/** Memoized per (source, view): the fixture flag is re-read on every call (see replay.ts). */
const loadHow = memoByView<HowData>(async (replay: ReplaySource, fixtures: boolean) => {
  const { entries, preview: guarded } = await replayPair(replay, fixtures);
  if (!guarded) return {};
  const entry = entries.find((e) => e.runId === guarded.runId);
  const sources: RunBundle[] = [];
  for (const s of entry ? worldNotarizeRuns(entries, entry) : []) sources.push(await replay.getRun(s.runId));
  const world = await replay.certificates(entryOfBundle(guarded));
  return {
    predict: sources.map(predictView).find(Boolean),
    challenge: challengeView(world, sources),
    certify: certifyView(world, guarded),
  };
});

/** Plays `build(tl)` once when the root enters the viewport (motion allowed only). */
function useOnce(root: React.RefObject<HTMLElement | null>, ready: boolean, build: (tl: gsap.core.Timeline) => void) {
  useGSAP(
    () => {
      if (!ready) return;
      const mm = gsap.matchMedia();
      mm.add(MOTION_OK, () => {
        const tl = gsap.timeline({
          defaults: { ease: "power2.out", duration: 0.5 },
          scrollTrigger: { trigger: root.current, start: "top 78%", once: true },
        });
        build(tl);
      });
    },
    { scope: root, dependencies: [ready] },
  );
}

/** An honest empty state; with `suite`, the real view links to the same step on the evaluation suite. */
const Missing = ({ text, suite = false }: { text: string; suite?: boolean }) => (
  <div className="h-missing">
    <p>{text}</p>
    {suite && <SuiteLink />}
  </div>
);

/* ------------------------------------------------------------------------------------ predict */

function Predict({ view }: { view: PredictView }) {
  const root = useRef<HTMLDivElement>(null);
  useOnce(root, true, (tl) => {
    tl.from(".h-pred", { x: -24, opacity: 0 })
      .from(".h-stamp", { scale: 0.6, opacity: 0, duration: 0.35, ease: "back.out(2)" }, "-=0.15")
      .from(".h-call", { opacity: 0, duration: 0.3 })
      .fromTo(".h-call-line", { scaleX: 0 }, { scaleX: 1, duration: 0.9, ease: "power1.inOut" })
      .from(".h-obs", { x: 24, opacity: 0 }, "-=0.1")
      .from(".h-field[data-mismatch]", { backgroundColor: "rgba(254,242,242,0)", duration: 0.4 })
      .from(".h-mismatch", { scale: 0.6, opacity: 0, duration: 0.35, ease: "back.out(2)" }, "-=0.2");
  });
  return (
    <div ref={root} className="h-predict">
      <article className="h-card h-pred" aria-label="Prediction">
        <header className="h-card-head">
          <AgentBadge agent="reflector" showKind className="l-agent" />
          <span className="h-stamp">
            Committed <time dateTime={view.committedAt}>{clockTime(view.committedAt)}</time>
          </span>
        </header>
        <p className="h-kicker">
          Prediction · {view.probe} · {view.template}
        </p>
        <p className="h-claim">
          <code>{view.claimId}</code>
        </p>
        <p className="h-expect">
          If the docs hold, the call is <strong>{view.expected}</strong>.
        </p>
      </article>
      <div className="h-call" aria-label="API call">
        {view.call && (
          <code className="h-call-text">
            {view.call.op} <span>{view.call.args}</span>
          </code>
        )}
        <span className="h-call-track" aria-hidden="true">
          <span className="h-call-line" />
        </span>
      </div>
      <article className="h-card h-obs" aria-label="Observation">
        <header className="h-card-head">
          <span className="h-kicker">Observation</span>
          <span className="status status-unsafe h-mismatch">Mismatch</span>
        </header>
        <dl className="h-fields">
          {view.observed.map((f) => (
            <div key={f.key} className="h-field" data-mismatch={f.mismatch || undefined}>
              <dt>{f.key}</dt>
              <dd>
                {f.value}
                {f.mismatch && <span className="h-was"> expected {view.expected}</span>}
              </dd>
            </div>
          ))}
        </dl>
      </article>
    </div>
  );
}

/* ---------------------------------------------------------------------------------- challenge */

function Challenge({ view }: { view: ChallengeView }) {
  const root = useRef<HTMLDivElement>(null);
  useOnce(root, true, (tl) => {
    tl.from(".h-hyp", { y: 16, opacity: 0 })
      .fromTo(".h-link", { scaleY: 0 }, { scaleY: 1, duration: 0.35 })
      .from(".h-adv", { y: 16, opacity: 0 })
      .from(".h-verdict", { scale: 0.7, opacity: 0, duration: 0.4, ease: "back.out(2)" }, "+=0.15");
  });
  const verdict =
    view.verdict === "uphold"
      ? { cls: "status-certified", text: `Survived ${view.survived} of ${view.challenges} ${view.challenges === 1 ? "challenge" : "challenges"}` }
      : view.verdict === "narrow"
        ? { cls: "status-held", text: "Scope narrowed" }
        : { cls: "status-unsafe", text: "Downgraded" };
  return (
    <div ref={root} className="h-challenge">
      <article className="h-card h-hyp">
        <header className="h-card-head">
          <AgentBadge agent="reflector" showKind className="l-agent" />
          <span className="h-kicker">Hypothesis</span>
        </header>
        <p className="h-text">
          {view.hypothesis && showable(view.hypothesis) ? clipText(view.hypothesis, 150) : <code>{view.claimId}</code>}
        </p>
      </article>
      <span className="h-link" aria-hidden="true" />
      <article className="h-card h-adv">
        <header className="h-card-head">
          <AgentBadge agent="adversary" showKind className="l-agent" />
          <span className="h-kicker">Counter-test</span>
        </header>
        <p className="h-text">{showable(view.counter) ? clipText(view.counter, 170) : "Review on file."}</p>
      </article>
      <span className={`status ${verdict.cls} h-verdict`}>{verdict.text}</span>
    </div>
  );
}

/* ------------------------------------------------------------------------------------ certify */

const SEAL_TEXT = "NOTARIZED · NOTARY · NOTARIZED · NOTARY · ";

function Seal() {
  const id = `seal-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg className="h-seal" viewBox="0 0 120 120" aria-hidden="true" focusable="false">
      <defs>
        <path id={id} d="M 60 60 m -44 0 a 44 44 0 1 1 88 0 a 44 44 0 1 1 -88 0" />
      </defs>
      <circle cx="60" cy="60" r="56" className="h-seal-ring" />
      <circle cx="60" cy="60" r="33" className="h-seal-ring h-seal-inner" />
      <g className="h-seal-text">
        <text>
          <textPath href={`#${id}`} textLength="276" lengthAdjust="spacing">
            {SEAL_TEXT}
          </textPath>
        </text>
      </g>
      <path className="h-seal-check" d="M47 61l9 9 17-20" />
    </svg>
  );
}

function Certify({ view }: { view: CertifyView }) {
  const root = useRef<HTMLDivElement>(null);
  useOnce(root, true, (tl) => {
    tl.from(".h-cert", { y: 18, opacity: 0 })
      .fromTo(".h-seal-text", { rotation: -140, transformOrigin: "50% 50%" }, { rotation: 0, duration: 1.6, ease: "power3.out" }, "-=0.2")
      .from(".h-seal-check", { opacity: 0, duration: 0.3 }, "-=0.6");
    // A certificate without decisions to show (a notarize run) has no guard rows: never tween nothing.
    if (view.rows.length) tl.from(".h-guard", { x: -16, opacity: 0, stagger: 0.45 }, "-=0.3");
  });
  return (
    <div ref={root} className="h-certify">
      <article className="h-card h-cert">
        <Seal />
        <div className="h-cert-body">
          <p className="h-kicker">Certificate</p>
          <p className="h-serial">
            <code>{view.certificateId}</code>
          </p>
          <p className="h-claim">
            <code>{view.claimId}</code>
          </p>
          <dl className="h-facts">
            <div>
              <dt>Scope</dt>
              <dd>{clipText(view.scope, 64)}</dd>
            </div>
            <div>
              <dt>Evidence</dt>
              <dd className="num">
                {view.evidence} {view.evidence === 1 ? "probe" : "probes"}
              </dd>
            </div>
            <div>
              <dt>Issued</dt>
              <dd>{date(view.issuedAt)}</dd>
            </div>
          </dl>
        </div>
      </article>
      <ul className="h-guards">
        {view.rows.map((r) => (
          <li key={r.title} className="h-guard" data-outcome={r.outcome}>
            <AgentBadge agent="guard" showKind className="l-agent" />
            <span className="h-guard-main">
              <span className="h-guard-title">{r.title}</span>
              <code className="h-guard-action">{r.action}</code>
            </span>
            <span className={`status ${r.outcome === "allowed" ? "status-certified" : "status-held"}`}>
              {r.outcome === "allowed" ? "Allowed" : "Held for review"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* --------------------------------------------------------------------------------------- entry */

export default function HowArt({ kind, source }: { kind: HowStepId; source: DataSource }) {
  const [state, setState] = useState<{ status: "loading" } | { status: "ready"; data: HowData } | { status: "error"; message: string }>({
    status: "loading",
  });
  // Re-read on every render; the landing also remounts when the view changes.
  const fixtures = fixturesInLocation();
  useEffect(() => {
    let live = true;
    loadHow(replayFor(source, fixtures), fixtures).then(
      (data) => live && setState({ status: "ready", data }),
      (e: unknown) => live && setState({ status: "error", message: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [source, fixtures]);
  if (state.status === "loading") return <div className="l-how-pending" aria-hidden="true" />;
  if (state.status === "error") return <Missing text={`Records withheld: ${state.message}`} />;
  const { predict, challenge, certify } = state.data;
  if (kind === "predict") return predict ? <Predict view={predict} /> : <Missing text="No contradicted prediction is published yet." suite />;
  if (kind === "challenge") return challenge ? <Challenge view={challenge} /> : <Missing text="No reviewed certificate is published yet." suite />;
  return certify ? <Certify view={certify} /> : <Missing text="No certificate is published yet." suite />;
}
