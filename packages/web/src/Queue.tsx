import { useState } from "react";
import { CaretRightIcon as CaretRight } from "@phosphor-icons/react/dist/csr/CaretRight";
import { MagnifyingGlassIcon as MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import type { Decision, QueueRequest, RunBundle } from "../../core/src/schema";
import {
  Empty,
  Fields,
  Json,
  RecordLinks,
  Status,
  Trace,
} from "./components";
import { date, label, number } from "./data";
import { Link } from "react-router";
import { ArrowUpRightIcon as ArrowUpRight } from "@phosphor-icons/react/dist/csr/ArrowUpRight";
import { recordPath, withRun } from "./state/data-mode";

function RequestRow({
  request,
  decision,
  bundle,
}: {
  request?: QueueRequest;
  decision?: Decision;
  bundle: RunBundle;
}) {
  const [open, setOpen] = useState(false);
  const id = request?.id ?? decision!.requestId;
  return (
    <article className={`request ${open ? "expanded" : ""}`}>
      <button
        className="request-summary"
        aria-expanded={open}
        aria-controls={`detail-${id}`}
        onClick={() => setOpen(!open)}
      >
        <CaretRight className="caret" size={16} aria-hidden="true" />
        <div className="customer">
          <strong>{request?.companyDomain ?? decision?.customerId}</strong>
          <span>
            {request?.customerEmail ??
              request?.customerId ??
              decision?.customerId}
          </span>
        </div>
        <div className="request-type">
          <strong>{label(request?.type ?? decision!.requestType)}</strong>
          <span>
            {request?.amount === undefined
              ? (request?.plan ?? "Plan not recorded")
              : `${number(request.amount)} ${request.currency ?? ""} minor units`}
          </span>
        </div>
        <div className="policy">
          <strong>
            {label(decision?.policyOutcome ?? "Awaiting decision")}
          </strong>
          <span>{decision?.tier ?? "Tier not recorded"}</span>
        </div>
        <div className="guard-count">
          <strong>
            {decision ? number(decision.guardsApplied.length) : "—"}
          </strong>
          <span>guards applied</span>
        </div>
        <div className="row-status">
          <Status value={decision?.status ?? "Awaiting decision"} />
        </div>
      </button>
      {open && (
        <>
          <RequestDetail
            request={request}
            decision={decision}
            bundle={bundle}
            id={id}
          />
          {decision && (
            <div className="record-link-row">
              <Link
                to={withRun(recordPath.decision(decision.id), bundle.runId)}
              >
                Open decision record
                <ArrowUpRight size={14} aria-hidden="true" />
              </Link>
            </div>
          )}
        </>
      )}
    </article>
  );
}

export function RequestDetail({
  request,
  decision,
  bundle,
  id,
}: {
  request?: QueueRequest;
  decision?: Decision;
  bundle: RunBundle;
  id: string;
}) {
  const guards = bundle.guards.filter((guard) =>
    decision?.guardsApplied.includes(guard.id),
  );
  return (
    <div className="request-detail" id={`detail-${id}`}>
      <div className="detail-grid">
        <section>
          <h3>Customer request</h3>
          {request ? (
            <Fields value={{ ...request }} />
          ) : (
            <p>Request record not included in this bundle.</p>
          )}
        </section>
        <section>
          <h3>Policy & execution</h3>
          {decision ? (
            <>
              <Fields
                value={{
                  id: decision.id,
                  action: decision.action,
                  tier: decision.tier,
                  policyOutcome: decision.policyOutcome,
                  status: decision.status,
                  requiredBeliefs: decision.requiredBeliefs,
                  missingBeliefs: decision.missingBeliefs,
                  enrichment: decision.enrichment,
                  grade: decision.grade,
                  error: decision.error,
                }}
              />
              <Trace bundle={bundle} traceId={decision.traceId} />
            </>
          ) : (
            <p>Decision not recorded.</p>
          )}
        </section>
      </div>
      {decision && (
        <>
          <section>
            <h3>Guards applied</h3>
            {decision.guardsApplied.length ? (
              <div className="guard-list">
                {decision.guardsApplied.map((id) => {
                  const guard = guards.find((item) => item.id === id);
                  return (
                    <div className="guard" key={id}>
                      <code>{id}</code>
                      {guard ? (
                        <>
                          <strong>
                            {label(guard.kind)} · {guard.operation}
                          </strong>
                          <p>{guard.reason}</p>
                          <Fields
                            value={{
                              beliefId: guard.beliefId,
                              class: guard.class,
                              active: guard.active,
                              compiledAt: guard.compiledAt,
                              retiredAt: guard.retiredAt,
                              rule: guard.rule,
                            }}
                          />
                        </>
                      ) : (
                        <p>Guard definition not included.</p>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p>No guards recorded for this decision.</p>
            )}
          </section>
          {decision.evidencePack && (
            <section className="evidence-pack">
              <h3>Evidence pack · Human review</h3>
              <p>{decision.evidencePack.reason}</p>
              <RecordLinks
                bundle={bundle}
                beliefs={decision.evidencePack.missingBeliefs}
                probes={decision.evidencePack.relatedProbeIds}
              />
              <Fields
                value={{
                  missingBeliefs: decision.evidencePack.missingBeliefs,
                  relatedProbeIds: decision.evidencePack.relatedProbeIds,
                }}
              />
              {decision.evidencePack.spanIds.map((spanId) => (
                <Trace
                  key={spanId}
                  bundle={bundle}
                  traceId={spanId}
                  spanId={spanId}
                  links={decision.evidencePack?.traceLinks}
                />
              ))}
              {Object.entries(decision.evidencePack.traceLinks).map(
                ([traceId]) => (
                  <Trace
                    key={traceId}
                    bundle={bundle}
                    traceId={traceId}
                    links={decision.evidencePack?.traceLinks}
                  />
                ),
              )}
            </section>
          )}
          <section>
            <h3>Recorded API effects</h3>
            {decision.effects.length ? (
              decision.effects.map((effect, index) => (
                <details className="effect" key={`${effect.op}-${index}`}>
                  <summary>
                    {effect.op}{" "}
                    <span>
                      {effect.status === null
                        ? "Outcome unknown"
                        : `HTTP ${effect.status}`}{" "}
                      · {date(effect.at)}
                    </span>
                  </summary>
                  <Json value={effect} />
                </details>
              ))
            ) : (
              <p>No external effects recorded.</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}

export function Queue({ bundle }: { bundle: RunBundle }) {
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const statuses = [
    ...new Set(bundle.decisions.map((decision) => decision.status)),
  ];
  const rows: { request?: QueueRequest; decision?: Decision }[] =
    bundle.queue.flatMap((request) => {
      const decisions = bundle.decisions.filter(
        (decision) => decision.requestId === request.id,
      );
      return decisions.length
        ? decisions.map((decision) => ({ request, decision }))
        : [{ request }];
    });
  rows.push(
    ...bundle.decisions
      .filter(
        (decision) =>
          !bundle.queue.some((request) => request.id === decision.requestId),
      )
      .map((decision) => ({ decision })),
  );
  const filtered = rows.filter(
    ({ request, decision }) =>
      (status === "all" ||
        (decision?.status ?? "Awaiting decision") === status) &&
      `${request?.companyDomain} ${request?.customerEmail} ${request?.customerId ?? decision?.customerId} ${request?.id ?? decision?.requestId}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <>
      <div className="section-toolbar">
        <div className="filters" aria-label="Filter requests by status">
          <button
            className={status === "all" ? "selected" : ""}
            aria-pressed={status === "all"}
            onClick={() => setStatus("all")}
          >
            All requests <span>{number(rows.length)}</span>
          </button>
          {statuses.map((value) => (
            <button
              key={value}
              className={status === value ? "selected" : ""}
              aria-pressed={status === value}
              onClick={() => setStatus(value)}
            >
              {label(value)}{" "}
              <span>
                {number(
                  rows.filter((row) => row.decision?.status === value).length,
                )}
              </span>
            </button>
          ))}
          {rows.some((row) => !row.decision) && (
            <button
              aria-pressed={status === "Awaiting decision"}
              onClick={() => setStatus("Awaiting decision")}
            >
              Awaiting decision
            </button>
          )}
        </div>
        <label className="search">
          <MagnifyingGlass size={17} aria-hidden="true" />
          <input
            aria-label="Search requests"
            placeholder="Search customer or request…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </div>
      <div className="queue-panel">
        <div className="queue-head" aria-hidden="true">
          <span />
          <span>Customer</span>
          <span>Request</span>
          <span>Policy / tier</span>
          <span>Protection</span>
          <span>Final status</span>
        </div>
        {filtered.length ? (
          filtered.map((row) => (
            <RequestRow
              key={row.decision?.id ?? row.request!.id}
              {...row}
              bundle={bundle}
            />
          ))
        ) : (
          <Empty
            title={
              rows.length ? "No matching requests" : "No queue in this bundle"
            }
          >
            {rows.length
              ? "Adjust your filter or search to see more requests."
              : "Select a queue run to inspect its requests and decisions."}
          </Empty>
        )}
      </div>
      <p className="caption">
        Amounts are shown in recorded minor units. Expand a request to inspect
        guards, API effects and evidence.
      </p>
    </>
  );
}
