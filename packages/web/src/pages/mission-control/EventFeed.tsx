// Virtualized event feed (@tanstack/react-virtual), newest first. Each row: time (IST), stage,
// type, the code-generated summary, a link to the record it is about and its trace(s).
import { useRef } from "react";
import { Link } from "react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { motion } from "motion/react";
import { ArrowUpRightIcon as ArrowUpRight } from "@phosphor-icons/react/dist/csr/ArrowUpRight";
import { XIcon as X } from "@phosphor-icons/react/dist/csr/X";
import type { RunBundle, TimelineEvent, TimelineStage } from "../../../../core/src/schema";
import {
  STAGE_LABEL,
  eventTime,
  isLiveEvent,
  recordLinkFor,
  shortRecordId,
  traceRefs,
  type RecordLink,
} from "./model";

const KIND_LABEL: Record<RecordLink["kind"], string> = {
  decision: "Decision",
  probe: "Probe",
  belief: "Belief",
  certificate: "Certificate",
  run: "Run",
};

function FeedRow({
  event,
  bundle,
  fresh,
  reduced,
}: {
  event: TimelineEvent;
  bundle: RunBundle;
  fresh: boolean;
  reduced: boolean;
}) {
  const link = recordLinkFor(event, bundle);
  const traces = traceRefs(event, bundle);
  const shortId = link ? shortRecordId(link, bundle.runId) : "";
  return (
    <motion.article
      className="feed-row"
      data-stage={event.stage}
      initial={fresh && !reduced ? { opacity: 0, y: -8 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
    >
      <div className="feed-meta">
        <time dateTime={event.at} title={`${event.at} (recorded)`}>
          {eventTime(event.at)}
        </time>
        <span className="stage-tag" data-stage={event.stage}>
          {STAGE_LABEL[event.stage]}
        </span>
        <code className="feed-type">{event.type}</code>
        {isLiveEvent(event) && <span className="feed-live">live</span>}
        <span className="feed-seq">#{event.seq}</span>
      </div>
      <p className="feed-summary">{event.summary}</p>
      <div className="feed-links">
        {link ? (
          <Link to={link.path} className="feed-record" title={link.id}>
            {KIND_LABEL[link.kind]} <span>{shortId}</span>
          </Link>
        ) : (
          <span className="muted">No record page</span>
        )}
        {traces.length ? (
          traces.slice(0, 2).map((t) =>
            t.href ? (
              <a key={t.id} className="feed-trace" href={t.href} target="_blank" rel="noreferrer" title={t.id}>
                trace <code>{t.id}</code>
                <ArrowUpRight size={12} aria-hidden="true" />
              </a>
            ) : (
              <span key={t.id} className="feed-trace muted" title={`Trace ${t.id} (no link recorded)`}>
                trace <code>{t.id}</code>
              </span>
            ),
          )
        ) : (
          <span className="muted">No trace recorded</span>
        )}
        {traces.length > 2 && <span className="muted">+{traces.length - 2} more</span>}
      </div>
    </motion.article>
  );
}

export function EventFeed({
  rows,
  bundle,
  stage,
  onClearStage,
  fresh,
  reduced,
  shown,
  total,
  replaying,
}: {
  /** Already filtered, newest first. */
  rows: TimelineEvent[];
  bundle: RunBundle;
  stage: TimelineStage | null;
  onClearStage: () => void;
  fresh: ReadonlySet<number>;
  reduced: boolean;
  /** Events shown so far (replayed or received), before the stage filter. */
  shown: number;
  total: number;
  replaying: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 104,
    overscan: 6,
    getItemKey: (i) => rows[i]!.seq,
  });
  return (
    <>
      <div className="mc-card-head">
        <div>
          <h2>Event feed</h2>
          <p className="muted">
            {replaying ? `${shown} of ${total} events replayed` : `${shown} ${shown === 1 ? "event" : "events"}`}
            {stage ? ` · ${rows.length} at ${STAGE_LABEL[stage]}` : ""} · newest first
          </p>
        </div>
        {stage && (
          <button
            type="button"
            className="filter-chip"
            onClick={() => {
              onClearStage();
              // The chip unmounts; keep keyboard focus in the feed instead of dropping it.
              scroller.current?.focus();
            }}
          >
            Stage: {STAGE_LABEL[stage]}
            <X size={12} aria-hidden="true" />
            <span className="sr-only">Clear the stage filter</span>
          </button>
        )}
      </div>
      <div ref={scroller} className="feed-scroll" tabIndex={0} aria-label="Timeline events, newest first">
        {rows.length === 0 ? (
          <p className="feed-empty">
            {stage
              ? `No ${STAGE_LABEL[stage]} events ${replaying ? "replayed yet" : "in this run"}.`
              : replaying
                ? "No events replayed yet. Press Play."
                : "No events recorded."}
          </p>
        ) : (
          <div role="list" style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((item) => {
              const event = rows[item.index]!;
              return (
                <div
                  key={item.key}
                  role="listitem"
                  aria-posinset={item.index + 1}
                  aria-setsize={rows.length}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className="feed-item"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <FeedRow event={event} bundle={bundle} fresh={fresh.has(event.seq)} reduced={reduced} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
