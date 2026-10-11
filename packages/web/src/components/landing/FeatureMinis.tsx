// The floating mini-cards of the Key features grid (lazy). Each is built from the dashboard's own
// components and helpers fed with replay data through the data layer:
//   01 certificate card — the replay guarded run's certificate world (most-evidenced active one)
//   02 held refund — the Run page's TranscriptRow + heldCard for the guarded run's first held refund
//   03 mini chat — the replay chat engine's recorded turn (first steps, first answer paragraph)
//   04 revocation — the fixture scenario that records a revocation (change-api): its certificate
//      flips from Certified to Revoked
// Interactive controls inside the cards are inert: the landing never acts.
import { useEffect, useRef, useState } from "react";
import type { Certificate, Revocation, RunBundle } from "../../../../core/src/schema";
import { date, entryOfBundle, loadFixtureCertificateIndex, type DataSource, type ReplaySource } from "../../data";
import {
  clipText,
  shortIds,
  showable,
  featuredCertificate,
  featuredRevocation,
  firstHeldRefund,
  revocationScenario,
  type FeatureKey,
} from "../../landing-data";
import { buildRows, heldCard, type HeldCard, type RunRow } from "../../pages/run/model";
import { TranscriptRow } from "../../pages/run/Transcript";
import { Button } from "../ui/button";
import { StatusPill } from "../ui/status-pill";
import { loadChatTurn, type ChatTurn } from "./chat-turn";
import { ChatWindow } from "./ChatWindow";
import { gsap, MOTION_OK, ScrollTrigger, useGSAP } from "./gsap";
import { AgentBadge } from "./AgentBadge";
import { replayFor, replayPair } from "./replay";

// ------------------------------------------------------------------------------- loaders

function memo<T>(fn: (r: ReplaySource) => Promise<T>) {
  const cache = new WeakMap<ReplaySource, Promise<T>>();
  return (r: ReplaySource) => {
    let p = cache.get(r);
    if (!p) {
      p = fn(r);
      p.catch(() => cache.delete(r));
      cache.set(r, p);
    }
    return p;
  };
}

type CertData = { certificate: Certificate; runId: string; sample: boolean } | null;
const loadCertificate = memo<CertData>(async (replay) => {
  const { guarded } = await replayPair(replay);
  if (!guarded) return null;
  const world = await replay.certificates(entryOfBundle(guarded));
  const certificate = featuredCertificate(world);
  return certificate ? { certificate, runId: guarded.runId, sample: guarded.sample } : null;
});

type HeldData = { row: RunRow; card: HeldCard; bundle: RunBundle } | null;
const loadHeld = memo<HeldData>(async (replay) => {
  const { guarded } = await replayPair(replay);
  const decision = guarded && firstHeldRefund(guarded);
  if (!guarded || !decision) return null;
  const events = await replay.getTimeline(guarded.runId);
  const event = events.find((e) => e.type === "decision" && e.recordIds.includes(decision.id));
  const row = event && buildRows([event], { bundle: guarded }).find((r) => r.type !== "intro" && r.held);
  const card = row && heldCard(row, { mode: "replay", sample: guarded.sample, bundle: guarded, approvals: null });
  return row && card ? { row, card, bundle: guarded } : null;
});

type RevData = { revocation: Revocation; certificate?: Certificate; scenario: string } | null;
const loadRevocation = memo<RevData>(async (replay) => {
  const pick = revocationScenario(await loadFixtureCertificateIndex());
  if (!pick) return null;
  const runs = await replay.listRuns();
  const entry = runs.find((r) => r.runId === pick.runId);
  if (!entry) return null;
  const world = await replay.certificates(entry);
  const found = featuredRevocation(world);
  return found ? { ...found, scenario: pick.scenario } : null;
});

function useLoad<T>(load: (r: ReplaySource) => Promise<T>, source: DataSource) {
  const [state, setState] = useState<{ status: "loading" } | { status: "ready"; value: T } | { status: "error"; message: string }>({
    status: "loading",
  });
  useEffect(() => {
    let live = true;
    load(replayFor(source)).then(
      (value) => live && setState({ status: "ready", value }),
      (e: unknown) => live && setState({ status: "error", message: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [load, source]);
  return state;
}

function Missing({ text }: { text: string }) {
  return (
    <div className="l-mini l-mini-missing">
      <p>{text}</p>
    </div>
  );
}

/** Steps (0…n) shown one at a time while `root` is in view; restarts on re-entry. Reduced motion: n. */
function useStepper(root: React.RefObject<HTMLElement | null>, n: number, gap = 0.6, ready = true) {
  const [k, setK] = useState<number | null>(null);
  useGSAP(
    () => {
      if (!ready || n === 0) return;
      const mm = gsap.matchMedia();
      mm.add(MOTION_OK, () => {
        const tl = gsap.timeline({ paused: true });
        tl.call(() => setK(0));
        for (let i = 1; i <= n; i++) tl.call(() => setK(i), [], `+=${gap}`);
        ScrollTrigger.create({
          trigger: root.current,
          start: "top 85%",
          end: "bottom 5%",
          onEnter: () => tl.restart(),
          onEnterBack: () => tl.restart(),
          // Out of view: jump to the end and hold there; re-entering replays it.
          onLeave: () => tl.progress(1, false).pause(),
          onLeaveBack: () => tl.progress(1, false).pause(),
        });
        return () => setK(null);
      });
    },
    { scope: root, dependencies: [n, ready] },
  );
  return k ?? n;
}

// ------------------------------------------------------------------------------- cards

function CertificateMini({ source }: { source: DataSource }) {
  const s = useLoad(loadCertificate, source);
  if (s.status === "loading") return <div className="l-mini l-mini-pending" aria-hidden="true" />;
  if (s.status === "error") return <Missing text={`Certificates withheld: ${s.message}`} />;
  if (!s.value) return <Missing text="No active certificate is published for this run’s world." />;
  const { certificate: c } = s.value;
  return (
    <div className="l-mini l-mini-cert">
      <div className="l-mini-head">
        <span className="l-mini-kicker">{c.tool} certificate</span>
        <StatusPill tone="safe">Certified</StatusPill>
      </div>
      <p className="l-mini-title">
        <code>{c.claimId}</code>
      </p>
      <dl className="l-mini-facts">
        <div>
          <dt>Verdict</dt>
          <dd>{c.verdictKind === "matches_docs" ? "Matches the docs" : "Contradicts the docs"}</dd>
        </div>
        <div>
          <dt>Scope</dt>
          <dd>{clipText(c.scope.text, 96)}</dd>
        </div>
        <div>
          <dt>Evidence</dt>
          <dd className="num">
            {c.evidence.length} {c.evidence.length === 1 ? "probe" : "probes"}
          </dd>
        </div>
        <div>
          <dt>Seal</dt>
          <dd>
            <code>sha256 {c.sha256.slice(0, 12)}…</code>
          </dd>
        </div>
      </dl>
    </div>
  );
}

function HeldMini({ source }: { source: DataSource }) {
  const s = useLoad(loadHeld, source);
  if (s.status === "loading") return <div className="l-mini l-mini-pending" aria-hidden="true" />;
  if (s.status === "error") return <Missing text={`Run withheld: ${s.message}`} />;
  if (!s.value) return <Missing text="No held refund is published yet." />;
  const { row, card } = s.value;
  return (
    <div className="l-mini l-mini-held">
      <div className="run-transcript-static l-mini-row">
        <TranscriptRow row={row} />
      </div>
      {showable(card.reason) && (
        <p className="l-mini-reason">
          <span className="l-mini-held-label">Held</span> {clipText(card.reason, 150)}
        </p>
      )}
      {card.evidence.find(showable) && <p className="l-mini-text">{clipText(card.evidence.find(showable)!, 120)}</p>}
      {/* Shape of the dashboard's approval controls; inert here (approvals need a local test-mode server). */}
      <div className="l-mini-actions" aria-hidden="true" inert>
        <AgentBadge id="guard" />
        <Button type="button" size="sm" tabIndex={-1}>
          Approve…
        </Button>
        <Button type="button" size="sm" variant="outline" tabIndex={-1}>
          Reject…
        </Button>
      </div>
    </div>
  );
}

function ChatMini({ source }: { source: DataSource }) {
  const root = useRef<HTMLDivElement>(null);
  const s = useLoad(loadChatTurn, source);
  const turn: ChatTurn | null = s.status === "ready" ? s.value : null;
  const steps = turn ? Math.min(3, turn.steps.length) : 0;
  // Steps one at a time, then the answer (one more beat).
  const k = useStepper(root, steps + 1, 0.55, !!turn);
  if (s.status === "loading") return <div className="l-mini l-mini-pending" aria-hidden="true" />;
  if (s.status === "error") return <Missing text={`Chat unavailable: ${s.message}`} />;
  if (!turn) return <Missing text="No chat answer is published yet." />;
  const shownSteps = turn.steps.slice(0, steps);
  const paragraph = turn.paragraphs[0] ? [clipText(turn.paragraphs[0], 170)] : [];
  return (
    <div ref={root} className="l-mini l-mini-chat">
      <ChatWindow
        compact
        question={turn.question}
        steps={shownSteps}
        paragraphs={paragraph}
        citations={turn.citations}
        visibleSteps={Math.min(k, steps)}
        chars={k > steps ? Infinity : 0}
      />
    </div>
  );
}

function RevocationMini({ source }: { source: DataSource }) {
  const root = useRef<HTMLDivElement>(null);
  const s = useLoad(loadRevocation, source);
  const ready = s.status === "ready" && !!s.value;

  useGSAP(
    () => {
      if (!ready) return;
      const mm = gsap.matchMedia();
      mm.add(MOTION_OK, () => {
        const tl = gsap.timeline({ paused: true });
        tl.set(".l-flip-inner", { rotateX: 0 })
          .set(".l-strike", { scaleX: 0 })
          .set(".l-rev-after", { opacity: 0 })
          .to(".l-flip-inner", { rotateX: 180, duration: 0.7, ease: "power2.inOut" }, "+=1.1")
          .to(".l-strike", { scaleX: 1, duration: 0.45, ease: "power2.out" }, "-=0.25")
          .to(".l-rev-after", { opacity: 1, duration: 0.4, stagger: 0.12 }, "-=0.1");
        ScrollTrigger.create({
          trigger: root.current,
          start: "top 85%",
          end: "bottom 5%",
          onEnter: () => tl.restart(),
          onEnterBack: () => tl.restart(),
          // Out of view: jump to the end and hold there; re-entering replays it.
          onLeave: () => tl.progress(1, false).pause(),
          onLeaveBack: () => tl.progress(1, false).pause(),
        });
      });
    },
    { scope: root, dependencies: [ready] },
  );

  if (s.status === "loading") return <div className="l-mini l-mini-pending" aria-hidden="true" />;
  if (s.status === "error") return <Missing text={`Certificates withheld: ${s.message}`} />;
  if (!s.value) return <Missing text="No published scenario records a revocation." />;
  const { revocation: r, certificate: c, scenario } = s.value;
  return (
    <div ref={root} className="l-mini l-mini-rev">
      <div className="l-mini-head">
        <span className="l-mini-kicker">{r.tool} certificate</span>
        <span className="l-flip">
          <span className="l-flip-inner">
            <span className="l-flip-face l-flip-front" aria-hidden="true">
              <StatusPill tone="safe">Certified</StatusPill>
            </span>
            <span className="l-flip-face l-flip-back">
              <span className="status status-revoked">
                <span className="status-word">Revoked</span>
              </span>
            </span>
          </span>
        </span>
      </div>
      <p className="l-mini-title l-rev-claim">
        <code>{r.claimId}</code>
        <span className="l-strike" aria-hidden="true" />
      </p>
      {showable(r.reason) && <p className="l-mini-text l-rev-after">{clipText(shortIds(r.reason), 120)}</p>}
      <dl className="l-mini-facts l-rev-after">
        <div>
          <dt>Was</dt>
          <dd>{c ? `Certified ${date(c.issuedAt)}` : "Certified"}</dd>
        </div>
        <div>
          <dt>Revoked</dt>
          <dd>{date(r.revokedAt)}</dd>
        </div>
        <div>
          <dt>Contrary probes</dt>
          <dd className="num">{r.triggerProbeIds.length}</dd>
        </div>
        <div>
          <dt>Guards retired</dt>
          <dd className="num">{r.guardsRetired.length}</dd>
        </div>
      </dl>
    </div>
  );
}

export default function FeatureArt({ kind, source }: { kind: FeatureKey; source: DataSource }) {
  if (kind === "certificates") return <CertificateMini source={source} />;
  if (kind === "held") return <HeldMini source={source} />;
  if (kind === "chat") return <ChatMini source={source} />;
  return <RevocationMini source={source} />;
}
