import { SelectControl } from "./components/SelectControl";
import { FunnelIcon as Funnel } from "@phosphor-icons/react/dist/csr/Funnel";
import { useState } from "react";
import type { RunBundle } from "../../core/src/schema";
import { Empty, Fields, Json, Status, Trace } from "./components";
import { date, label, number, percent, safeLink } from "./data";

export function Beliefs({ bundle }: { bundle: RunBundle }) {
  const [snapshot, setSnapshot] = useState<"before" | "after">("after");
  const [status, setStatus] = useState("all");
  const beliefs = bundle.beliefs[snapshot];
  const statuses = [...new Set(beliefs.map((belief) => belief.status))];
  const visible = beliefs.filter(
    (belief) => status === "all" || status === belief.status,
  );
  return (
    <>
      <div className="section-toolbar">
        <div className="filters">
          <button
            aria-pressed={snapshot === "before"}
            className={snapshot === "before" ? "selected" : ""}
            onClick={() => {
              setSnapshot("before");
              setStatus("all");
            }}
          >
            Before run
          </button>
          <button
            aria-pressed={snapshot === "after"}
            className={snapshot === "after" ? "selected" : ""}
            onClick={() => {
              setSnapshot("after");
              setStatus("all");
            }}
          >
            After run
          </button>
        </div>
        <label className="inline-label">
          Status
          <SelectControl
            icon={<Funnel size={16} />}
            aria-label="Filter beliefs by status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="all">All beliefs</option>
            {statuses.map((value) => (
              <option value={value} key={value}>
                {label(value)}
              </option>
            ))}
          </SelectControl>
        </label>
      </div>
      <div className="belief-note">
        Confidence is the probability that the documented claim holds. A
        notarized finding may prove the documentation wrong.
      </div>
      <div className="belief-grid">
        {visible.map((belief) => {
          const claim = bundle.claims.find(
            (claim) => claim.id === belief.claimId,
          );
          const probes = bundle.probes.filter((probe) =>
            belief.evidence.some((evidence) => evidence.probeId === probe.id),
          );
          const href = safeLink(claim?.docUrl);
          return (
            <article className="belief-card" key={belief.id}>
              <div className="belief-top">
                <span className="eyebrow">
                  {belief.tool} / {claim?.operation ?? belief.claimId}
                </span>
                <Status value={belief.status} />
              </div>
              <h2>{belief.statement}</h2>
              <blockquote>
                <span>Documented claim</span>
                {claim?.docText ?? "Claim record not included."}
                {href && (
                  <a href={href} target="_blank" rel="noreferrer">
                    Source documentation
                  </a>
                )}
              </blockquote>
              <div className="confidence">
                <span>P(documentation holds)</span>
                <strong>{percent(belief.confidence)}</strong>
              </div>
              <meter
                min={0}
                max={1}
                value={belief.confidence}
                aria-label="Probability documentation holds"
              />
              <div className="belief-footer">
                <span>
                  <strong>{number(belief.evidence.length)}</strong> evidence
                  citations
                </span>
                {belief.adversary ? (
                  <Status value={belief.adversary.verdict} />
                ) : (
                  <span className="muted">Adversary review pending</span>
                )}
              </div>
              <details className="belief-details">
                <summary>Inspect evidence & review</summary>
                <section>
                  <h3>Adversary review</h3>
                  {belief.adversary ? (
                    <>
                      <p>{belief.adversary.reason}</p>
                      <Fields value={{ ...belief.adversary }} />
                    </>
                  ) : (
                    <p>Not recorded.</p>
                  )}
                </section>
                <section>
                  <h3>Claim & belief record</h3>
                  {claim && <Fields value={{ ...claim }} />}
                  <Fields
                    value={{
                      id: belief.id,
                      claimId: belief.claimId,
                      class: belief.class,
                      alpha: belief.alpha,
                      beta: belief.beta,
                      prior: belief.prior,
                      probesToCandidate: belief.probesToCandidate,
                      updatedAt: date(belief.updatedAt),
                    }}
                  />
                </section>
                <section>
                  <h3>Evidence citations</h3>
                  {belief.evidence.length ? (
                    belief.evidence.map((evidence, index) => (
                      <div
                        className="citation"
                        key={`${evidence.probeId}-${index}`}
                      >
                        <code>{evidence.probeId}</code>
                        <span>
                          {evidence.valid === undefined
                            ? "Validity not checked"
                            : evidence.valid
                              ? "Evidence valid"
                              : "Evidence invalid"}
                        </span>
                        <Trace
                          bundle={bundle}
                          traceId={evidence.traceId}
                          spanId={evidence.spanId}
                        />
                      </div>
                    ))
                  ) : (
                    <p>No evidence cited.</p>
                  )}
                </section>
                <section>
                  <h3>Supporting probes</h3>
                  {probes.length ? (
                    probes.map((probe) => (
                      <details className="effect" key={probe.id}>
                        <summary>
                          {probe.id} · {label(probe.template)}{" "}
                          <span>{probe.verdict ?? "Awaiting verdict"}</span>
                        </summary>
                        <Json value={probe} />
                        <Trace
                          bundle={bundle}
                          traceId={probe.traceId}
                          spanId={probe.spanId}
                        />
                      </details>
                    ))
                  ) : (
                    <p>No cited probe records included.</p>
                  )}
                </section>
                <section>
                  <h3>Belief history</h3>
                  {bundle.beliefEvents
                    .filter((event) => event.beliefId === belief.id)
                    .map((event, index) => (
                      <div className="history" key={`${event.at}-${index}`}>
                        <span>{date(event.at)}</span>
                        <strong>
                          {event.from ?? "created"} → {event.to}
                        </strong>
                        <p>{event.reason}</p>
                        <Json value={event} />
                      </div>
                    ))}
                </section>
              </details>
            </article>
          );
        })}
      </div>
      {!visible.length && (
        <Empty title="No beliefs in this view">
          Choose a different snapshot, status or bundle.
        </Empty>
      )}
    </>
  );
}
