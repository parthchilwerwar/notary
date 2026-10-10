// The Decision trail and the Certificate trail: five steps from request (or claim) to the
// decision (or enforcement). Every line is tagged "Verified" or "Model said" by `classifySource`
// in ./model.ts; Verified lines link their recorded trace, or show the trace id as text.
import { useMemo } from "react";
import { Link, useLocation } from "react-router";
import { ArrowUpRightIcon as ArrowUpRight } from "@phosphor-icons/react/dist/csr/ArrowUpRight";
import { SealCheckIcon as SealCheck } from "@phosphor-icons/react/dist/csr/SealCheck";
import { ChatCircleDotsIcon as ChatCircleDots } from "@phosphor-icons/react/dist/csr/ChatCircleDots";
import { WarningIcon as Warning } from "@phosphor-icons/react/dist/csr/Warning";
import type { RunBundle } from "../../../../core/src/schema";
import { StatusPill } from "../ui/status-pill";
import { useData } from "../../state/DataProvider";
import { recordPath, withRun } from "../../state/data-mode";
import {
  TAG_LABEL,
  deriveCertificateTrail,
  deriveDecisionTrail,
  type RecordRef,
  type TrailLine,
  type TrailModel,
  type TrailTag,
} from "./model";
import "./trail.css";

export type DecisionTrailProps = { bundle: RunBundle; decisionId: string };
export type CertificateTrailProps = { certificateId: string };

export function DecisionTrail({ bundle, decisionId }: DecisionTrailProps) {
  const { bundles, certificates } = useData();
  const world = certificates.status === "ready" ? certificates.data : undefined;
  const model = useMemo(
    () => deriveDecisionTrail({ bundle, decisionId, bundles, world }),
    [bundle, decisionId, bundles, world],
  );
  if (!model) return null;
  const notes =
    certificates.status === "loading"
      ? ["Verifying the certificate world; certificate statuses appear once every seal is recomputed."]
      : certificates.status === "error"
        ? [`Certificates withheld: ${certificates.error}`]
        : model.notes;
  const decision = bundle.decisions.find((d) => d.id === decisionId)!;
  return (
    <TrailView
      model={{ ...model, notes }}
      eyebrow="Decision trail"
      title={`Why ${decision.requestId} was ${decision.status}`}
      self={{ kind: "decision", id: decisionId }}
    />
  );
}

export function CertificateTrail({ certificateId }: CertificateTrailProps) {
  const { bundles, bundle, certificates } = useData();
  const world = certificates.status === "ready" ? certificates.data : undefined;
  const model = useMemo(
    () =>
      world
        ? deriveCertificateTrail({ certificateId, world, bundles, runId: bundle?.runId })
        : undefined,
    [certificateId, world, bundles, bundle?.runId],
  );
  if (!model) return null;
  return (
    <TrailView
      model={model}
      eyebrow="Certificate trail"
      title="From documented claim to enforcement"
      self={{ kind: "certificate", id: certificateId }}
    />
  );
}

// ------------------------------------------------------------------------------------- view

type Self = Pick<RecordRef, "kind" | "id">;

function TrailView({
  model,
  eyebrow,
  title,
  self,
}: {
  model: TrailModel;
  eyebrow: string;
  title: string;
  self: Self;
}) {
  const counts = { verified: 0, model: 0 };
  for (const s of model.steps)
    for (const l of [...s.lines, ...s.groups.flatMap((g) => g.lines)]) counts[l.tag]++;
  return (
    <section className="trail" aria-label={eyebrow}>
      <header className="trail-head">
        <div>
          <span className="eyebrow">{eyebrow}</span>
          <h2>{title}</h2>
        </div>
        <div className="trail-legend" aria-label="Line tags">
          <TagChip tag="verified" />
          <span className="trail-legend-text">
            computed by code or observed from an API · {counts.verified}
          </span>
          <TagChip tag="model" />
          <span className="trail-legend-text">produced by a model · {counts.model}</span>
        </div>
      </header>
      {model.decidedBy && (
        <div
          className="trail-decided"
          data-kind={model.decidedBy.kind}
          data-unsafe={model.unsafe?.length ? "true" : undefined}
        >
          <span className="eyebrow">Decided by</span>
          <p>{model.decidedBy.text}</p>
          {model.unsafe?.length ? (
            <p className="trail-unsafe">
              <Warning size={16} aria-hidden="true" />
              Graded unsafe by the deterministic grader: {model.unsafe.join(", ")}.
            </p>
          ) : null}
        </div>
      )}
      {model.notes.map((n) => (
        <p className="trail-note" key={n}>
          {n}
        </p>
      ))}
      <ol className="trail-steps">
        {model.steps.map((step, i) => (
          <li className="trail-step" key={step.key}>
            <div className="trail-step-marker" aria-hidden="true">
              <span>{i + 1}</span>
            </div>
            <div className="trail-step-body">
              <header className="trail-step-head">
                <h3>{step.title}</h3>
                <p>{step.summary}</p>
              </header>
              {step.lines.length > 0 && (
                <ul className="trail-lines">
                  {step.lines.map((l, j) => (
                    <LineView
                      key={`${l.key}-${j}`}
                      line={l}
                      prev={step.lines[j - 1]}
                      self={self}
                    />
                  ))}
                </ul>
              )}
              {step.groups.map((g) => (
                <details
                  className="trail-group"
                  key={g.key}
                  open={g.decisive}
                  data-decisive={g.decisive || undefined}
                >
                  <summary>
                    <span className="trail-group-title">
                      <code>{g.title}</code>
                      {g.status && <StatusPill value={g.status} />}
                      {g.decisive && <DecisiveBadge />}
                      <span className="trail-group-count">
                        {g.lines.length} lines
                      </span>
                    </span>
                    {g.subtitle && (
                      <span className="trail-group-subtitle">{g.subtitle}</span>
                    )}
                  </summary>
                  <ul className="trail-lines">
                    {g.lines.map((l, j) => (
                      <LineView key={`${l.key}-${j}`} line={l} prev={g.lines[j - 1]} self={self} />
                    ))}
                  </ul>
                </details>
              ))}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function TagChip({ tag }: { tag: TrailTag }) {
  const Icon = tag === "verified" ? SealCheck : ChatCircleDots;
  return (
    <span className="trail-tag" data-tag={tag}>
      <Icon size={12} aria-hidden="true" />
      {TAG_LABEL[tag]}
    </span>
  );
}

function DecisiveBadge() {
  return <span className="trail-decisive-badge">Deciding factor</span>;
}

const sameRecord = (a?: RecordRef, b?: RecordRef) =>
  !!a && !!b && a.kind === b.kind && a.id === b.id && a.runId === b.runId;

function LineView({
  line: l,
  prev,
  self,
}: {
  line: TrailLine;
  /** The line above, so repeated record chips and trace ids are shown once per run of lines. */
  prev?: TrailLine;
  self: Self;
}) {
  const isSelf = l.record?.kind === self.kind && l.record.id === self.id;
  // Link the record unless the line above already links it, or it is this page and a trace link
  // already stands in for it.
  const showRecord =
    l.record && !sameRecord(l.record, prev?.record) && (!isSelf || !l.traceUrl);
  // A trace id repeated from the line above is shortened (the full id stays in the title).
  const repeatTrace = !!l.traceId && prev?.tag === "verified" && prev.traceId === l.traceId;
  return (
    <li
      className="trail-line"
      data-tag={l.tag}
      data-decisive={l.decisive || undefined}
    >
      <TagChip tag={l.tag} />
      <div className="trail-line-key">
        <span className="trail-label">{l.label}</span>
        {(l.status || l.decisive) && (
          <span className="trail-line-pills">
            {l.status && <StatusPill value={l.status} />}
            {l.decisive && <DecisiveBadge />}
          </span>
        )}
      </div>
      <div className="trail-line-value">
        <p className="trail-text">{l.text}</p>
        {l.detail && <p className="trail-detail">{l.detail}</p>}
        {l.warning && (
          <p className="trail-warning">
            <Warning size={14} aria-hidden="true" />
            {l.warning}
          </p>
        )}
      </div>
      <div className="trail-refs">
        {l.tag === "verified" &&
          l.traceId &&
          (l.traceUrl ? (
            <a
              className="trail-ref"
              href={l.traceUrl}
              target="_blank"
              rel="noreferrer"
              title={`Trace ${l.traceId}`}
            >
              <span>trace</span>
              {l.traceId.slice(0, 8)}…
              <ArrowUpRight size={12} aria-hidden="true" />
            </a>
          ) : (
            <code
              className="trail-ref muted"
              title={`Trace ${l.traceId} (no trace link recorded)`}
            >
              <span>trace</span>
              {repeatTrace ? `${l.traceId.slice(0, 8)}…` : l.traceId}
            </code>
          ))}
        {showRecord && l.record && <RecordChip record={l.record} />}
        {l.href && (
          <a className="trail-ref" href={l.href} target="_blank" rel="noreferrer">
            <span>docs</span>
            source
            <ArrowUpRight size={12} aria-hidden="true" />
          </a>
        )}
      </div>
    </li>
  );
}

function RecordChip({ record }: { record: RecordRef }) {
  const { pathname } = useLocation();
  const to = withRun(recordPath[record.kind](record.id), record.runId);
  const here = to.split("?")[0] === pathname;
  return (
    <Link className="trail-ref" to={to} aria-current={here ? "page" : undefined}>
      <span>{record.kind}</span>
      {record.id}
    </Link>
  );
}
