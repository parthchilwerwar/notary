// The hero's dashboard preview (lazy): the Run page's own pieces — its stage bar markup, budget
// line, TranscriptRow rows and held-card styling (src/pages/run, imported read-only) — fed with the
// published guarded run's timeline through the data layer. Rows stream in one by one once, then
// hold; reduced motion shows them all. Inert and hidden from assistive tech (decoration).
// Only rows whose words pass the landing's copy rules are shown (run identifiers stay in the app).
import { useEffect, useMemo, useRef, useState } from "react";
import type { RunBundle, TimelineEvent } from "../../../../core/src/schema";
import type { ReplaySource } from "../../data";
import { clipText, showable } from "../../landing-data";
import { budgetView, buildRows, heldCard, stageProgress, unsafeDecisionIds } from "../../pages/run/model";
import { TranscriptRow } from "../../pages/run/Transcript";
import { gsap, MOTION_OK, useGSAP } from "./gsap";
import { previewData } from "./replay";

const SIDEBAR = ["Run", "Certificates", "Approvals", "Chat"] as const;
const MAX_ROWS = 9;

export default function RunPreview({ replay }: { replay: ReplaySource }) {
  const [data, setData] = useState<{ bundle: RunBundle; events: TimelineEvent[] } | null>(null);
  useEffect(() => {
    let live = true;
    // Usually already loaded: the hero starts this load together with this chunk.
    previewData(replay).then((d) => live && setData(d), () => undefined);
    return () => {
      live = false;
    };
  }, [replay]);
  return data ? <Preview bundle={data.bundle} events={data.events} /> : <div className="l-preview-empty" />;
}

function Preview({ bundle, events }: { bundle: RunBundle; events: TimelineEvent[] }) {
  const root = useRef<HTMLDivElement>(null);
  const rows = useMemo(
    () =>
      buildRows(events, { bundle })
        .filter((r) => r.type !== "intro" && showable(`${r.title} ${r.subject ?? ""}`))
        .slice(0, MAX_ROWS),
    [events, bundle],
  );
  const progress = useMemo(() => stageProgress(events, unsafeDecisionIds(bundle)), [events, bundle]);
  const budget = useMemo(() => budgetView(events, bundle.usageByRole), [events, bundle]);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(MOTION_OK, () => {
        if (!rows.length) return; // nothing to stream in (GSAP warns on an empty target)
        gsap.from(".l-preview-row", { opacity: 0, y: 10, duration: 0.35, ease: "power2.out", stagger: 0.55, delay: 0.4 });
      });
    },
    { scope: root, dependencies: [rows.length] },
  );

  return (
    <div ref={root} className="l-preview">
      <aside className="l-preview-side">
        <span className="l-preview-brand">Notary</span>
        <ul>
          {SIDEBAR.map((s) => (
            <li key={s} data-active={s === "Run" || undefined}>
              {s}
            </li>
          ))}
        </ul>
      </aside>
      <div className="l-preview-main run-page">
        <p className="l-preview-title">Run transcript</p>
        <ol className="run-stages">
          {progress.steps.map((s) => (
            <li key={s.stage} data-state={s.state} data-current={s.current || undefined}>
              <span className="run-stage-bar" />
              <span className="run-stage-label">
                {s.label}
                <span className="run-stage-count">{s.count}</span>
              </span>
            </li>
          ))}
        </ol>
        {budget && (
          <dl className="run-budget">
            <div>
              <dt>Credits</dt>
              <dd>
                {budget.credits.used}
                {budget.credits.cap !== null && <span className="run-muted"> / {budget.credits.cap}</span>}
              </dd>
            </div>
            <div>
              <dt>Tool calls</dt>
              <dd>{budget.toolCalls.used}</dd>
            </div>
          </dl>
        )}
        <ol className="run-transcript-static l-preview-rows">
          {rows.map((row) => {
            const card = heldCard(row, { mode: "replay", sample: bundle.sample, bundle, approvals: null });
            const evidence = card?.evidence.find(showable);
            return (
              <li key={row.key} className="l-preview-row">
                <TranscriptRow
                  row={row}
                  card={
                    card && showable(card.reason) ? (
                      <div className="run-held" data-kind="readonly">
                        <p className="run-held-reason">
                          <span className="run-held-label">Held</span> {clipText(card.reason, 160)}
                        </p>
                        {evidence && (
                          <ul className="run-held-evidence">
                            <li>{evidence}</li>
                          </ul>
                        )}
                      </div>
                    ) : undefined
                  }
                />
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
