import { useRef } from "react";
import { Link } from "react-router";
import type { RunBundle } from "../../../../core/src/schema";
import { FIXTURE_BANNER } from "../../data";
import { runHref, type ProofNumbers } from "../../landing-data";
import { gsap, MOTION_OK, useGSAP } from "./gsap";

export type ProofState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "empty"; message: string }
  | {
      status: "ready";
      naive: RunBundle;
      guarded: RunBundle;
      numbers: ProofNumbers;
      note?: string;
    };

const fmt = new Intl.NumberFormat("en-US");

/** A figure that counts up once when scrolled into view (the final value is in the DOM). */
function Figure({ value, label }: { value: number | null; label: string }) {
  return (
    <div className="l-figure">
      <dd className="l-figure-value">
        {value === null ? (
          <span>not recorded</span>
        ) : (
          <>
            <span className="l-count" data-count={value} aria-hidden="true">
              {fmt.format(value)}
            </span>
            <span className="sr-only">{fmt.format(value)}</span>
          </>
        )}
      </dd>
      <dt className="l-figure-label">{label}</dt>
    </div>
  );
}

export function Proof({ state }: { state: ProofState }) {
  const root = useRef<HTMLElement>(null);
  const ready = state.status === "ready";

  useGSAP(
    () => {
      if (!ready) return;
      const mm = gsap.matchMedia();
      mm.add(MOTION_OK, () => {
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
    <section className="l-section l-proof" ref={root} aria-labelledby="proof-title">
      <h2 id="proof-title" className="l-h2">
        Same queue, two agents
      </h2>
      {state.status === "loading" && (
        <div className="l-proof-body" aria-busy="true">
          <p className="l-lede">Loading the latest exported runs…</p>
          <div className="l-figures l-figures-pending" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </div>
      )}
      {(state.status === "error" || state.status === "empty") && (
        <p className="l-lede l-error" role={state.status === "error" ? "alert" : undefined}>
          {state.message}
        </p>
      )}
      {state.status === "ready" && <ProofBody state={state} />}
    </section>
  );
}

function ProofBody({ state }: { state: Extract<ProofState, { status: "ready" }> }) {
  const { naive, guarded, numbers, note } = state;
  const sample = guarded.sample;
  return (
    <div className="l-proof-body">
      {sample ? (
        <p className="l-fixture" role="note">
          {FIXTURE_BANNER}
        </p>
      ) : (
        <p className="l-fixture" role="note">
          Recorded runs, mode: {guarded.mode === naive.mode ? guarded.mode : `${naive.mode} and ${guarded.mode}`}
        </p>
      )}
      <p className="l-lede">
        One queue of {fmt.format(numbers.requests)} customer requests, run twice against the same{" "}
        {sample ? "simulated " : ""}APIs: once by an agent that trusts the docs, once by Notary.
        Unsafe actions are duplicate writes, wrong-unit amounts and missed existing refunds, counted
        by the deterministic grader from the API’s state after each run.
      </p>
      {note && <p className="l-note">{note}</p>}
      <dl className="l-figures">
        <Figure value={numbers.naiveUnsafe} label="unsafe money actions by the agent that trusts the docs" />
        <Figure value={numbers.guardedUnsafe} label="unsafe money actions by Notary" />
        <Figure value={numbers.refundsHeld} label="refunds Notary held for a person to approve" />
      </dl>
      <p className="l-source">
        From{" "}
        <Link to={runHref(naive.runId)}>
          <code>{naive.runId}</code>
        </Link>{" "}
        and{" "}
        <Link to={runHref(guarded.runId)}>
          <code>{guarded.runId}</code>
        </Link>
        , hash-verified in your browser.
      </p>
    </div>
  );
}
