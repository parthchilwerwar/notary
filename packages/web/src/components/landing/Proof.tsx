import { useEffect, useRef } from "react";
import type { RunBundle } from "../../../../core/src/schema";
import { actionsByType, EVALUATION_TAG, EVALUATION_URL, type ProofNumbers } from "../../landing-data";
import { GridSection } from "../brand/GridFrame";
import { ActionsChart } from "./ActionsChart";
import { BrowserFrame } from "./BrowserFrame";
import { fadeUp, revealTitle } from "./motion";
import { gsap, MOTION_OK, useGSAP } from "./gsap";
import { useNear } from "./useNear";
import { SuiteLink } from "./SuiteLink";

export type ProofState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "empty"; message: string; title?: string; commands?: readonly string[] }
  | {
      status: "ready";
      naive: RunBundle;
      guarded: RunBundle;
      numbers: ProofNumbers;
    };

const fmt = new Intl.NumberFormat("en-US");

/** A stat that counts up once when scrolled into view (the final value is always in the DOM). */
function Stat({ value, label }: { value: number | null; label: string }) {
  return (
    <div className="l-stat">
      <dt className="l-stat-label">{label}</dt>
      <dd className="l-stat-value">
        {value === null ? (
          <span className="l-stat-missing">not available</span>
        ) : (
          <>
            <span className="l-count" data-count={value} aria-hidden="true">
              {fmt.format(value)}
            </span>
            <span className="sr-only">{fmt.format(value)}</span>
          </>
        )}
      </dd>
    </div>
  );
}

export function Proof({ state, onNear }: { state: ProofState; onNear?: () => void }) {
  const root = useRef<HTMLElement>(null);
  // The bundles are fetched and hash-checked only when the section nears the viewport.
  const near = useNear(root, 800);
  useEffect(() => {
    if (near) onNear?.();
  }, [near, onNear]);
  const ready = state.status === "ready";

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(MOTION_OK, () => {
        revealTitle(root.current!.querySelector(".l-h2"));
        if (!ready) return;
        fadeUp(gsap.utils.toArray<HTMLElement>(".l-stat, .l-chart-card", root.current), { stagger: 0.1 });
        const els = gsap.utils.toArray<HTMLElement>(".l-count", root.current);
        for (const el of els) {
          const target = Number(el.dataset.count);
          // Mutate React's own text node (never replace it) and restore the final value on revert.
          const text = el.firstChild as Text | null;
          if (!text || !Number.isFinite(target)) continue;
          const counter = { v: 0 };
          text.nodeValue = fmt.format(0);
          gsap.to(counter, {
            v: target,
            duration: 1.2,
            ease: "power2.out",
            onUpdate: () => {
              text.nodeValue = fmt.format(Math.round(counter.v));
            },
            scrollTrigger: { trigger: el, start: "top 90%", once: true },
          });
        }
        return () => {
          for (const el of els) {
            const text = el.firstChild as Text | null;
            if (text) text.nodeValue = fmt.format(Number(el.dataset.count));
          }
        };
      });
    },
    { scope: root, dependencies: [state], revertOnUpdate: true },
  );

  return (
    <GridSection ref={root} id="proof" className="l-section l-proof" aria-labelledby="proof-title" rule>
      <div className="grid-inner">
        <header className="l-section-head">
          <p className="section-label">Proof</p>
          <h2 id="proof-title" className="display l-h2">
            Same queue, two agents
          </h2>
        </header>
        {state.status === "loading" && (
          <div className="l-proof-body" aria-busy="true">
            <p className="l-lede">Loading the latest exported runs…</p>
            <div className="l-stats l-stats-pending" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
        {state.status === "error" && (
          <p className="l-lede l-error" role="alert">
            {state.message}
          </p>
        )}
        {state.status === "empty" && (
          <div className="l-proof-body l-proof-empty">
            {state.title && <h3 className="l-proof-empty-title">{state.title}</h3>}
            <p className="l-lede">{state.message}</p>
            {state.commands && (
              <ol className="l-proof-steps">
                {state.commands.map((c) => (
                  <li key={c}>
                    <code>{c}</code>
                  </li>
                ))}
              </ol>
            )}
            <SuiteLink />
          </div>
        )}
        {state.status === "ready" && <ProofBody state={state} />}
      </div>
    </GridSection>
  );
}

function ProofBody({ state }: { state: Extract<ProofState, { status: "ready" }> }) {
  const { naive, guarded, numbers } = state;
  const rows = actionsByType(naive, guarded);
  return (
    <div className="l-proof-body">
      <p className="l-lede">
        One queue of {fmt.format(numbers.requests)} customer requests, run twice against the same APIs: once by an
        agent that trusts the docs, once by Notary. Unsafe actions (duplicate writes, wrong-unit amounts, missed
        existing refunds) are counted by a deterministic grader from the API’s state after each run.
      </p>
      <dl className="l-stats">
        <Stat value={numbers.naiveUnsafe} label="Unsafe actions without Notary" />
        <Stat value={numbers.guardedUnsafe} label="Unsafe actions with Notary" />
        <Stat value={numbers.refundsHeld} label="Refunds held for review" />
      </dl>
      <p className="l-footnote">
        <a href={EVALUATION_URL} rel="noreferrer">
          Measured on Notary’s evaluation suite
        </a>
      </p>
      <BrowserFrame
        className="l-chart-card"
        title="Money actions by request type"
        tag={guarded.sample ? EVALUATION_TAG : undefined}
      >
        <ActionsChart rows={rows} />
      </BrowserFrame>
    </div>
  );
}
