// "Watch it work": a short excerpt of a recorded run, rows appearing one by one, ending on a held
// refund. Lazy-loaded (its timelines are fetched only when the section nears the viewport).
// Rows are the Run page's own (src/pages/run: buildRows, TranscriptRow, HeldCardView), imported
// read-only; this file only picks the events (landing-data buildExcerpt) and loads them.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import type { RunBundle, TimelineEvent } from "../../../../core/src/schema";
import { FIXTURE_BANNER, type DataMode, type DataSource } from "../../data";
import { buildExcerpt, runHref, sourceRuns, type Excerpt as ExcerptCore } from "../../landing-data";
import { HeldCardView, TranscriptRow } from "../../pages/run/Transcript";
import { buildRows, heldCard, type RunRow } from "../../pages/run/model";
import { gsap, MOTION_OK, ScrollTrigger, useGSAP } from "./gsap";

type Entry = { runId: string; kind: string; variant: string; sample: boolean; startedAt: string };

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "empty"; message: string }
  | { status: "ready"; excerpt: ExcerptData; events: TimelineEvent[] };

type ExcerptData = ExcerptCore & { bundle: RunBundle };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function Excerpt({
  source,
  entries,
  guarded,
}: {
  source: DataSource;
  entries: readonly Entry[];
  guarded: RunBundle;
}) {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const guardedEntry = entries.find((e) => e.runId === guarded.runId);
    const sources = guardedEntry ? sourceRuns(entries, guardedEntry) : [];
    // Timelines come from the data layer, schema-checked and tied to their bundle's hash there.
    Promise.all([
      source.getTimeline(guarded.runId, signal),
      Promise.all(
        sources.map(async (s) => ({ runId: s.runId, events: await source.getTimeline(s.runId, signal) })),
      ),
    ])
      .then(([events, sourceEvents]) => {
        if (signal.aborted) return;
        const excerpt = buildExcerpt(guarded, events, sourceEvents);
        setState(
          excerpt
            ? { status: "ready", excerpt: { ...excerpt, bundle: guarded }, events: [...sourceEvents.flatMap((s) => s.events), ...events] }
            : { status: "empty", message: `${guarded.runId} held no refund, so there is no held refund to show.` },
        );
      })
      .catch((e) => {
        if (!signal.aborted) setState({ status: "error", message: message(e) });
      });
    return () => controller.abort();
  }, [source, entries, guarded]);

  if (state.status === "loading")
    return (
      <p className="l-lede" aria-busy="true">
        Loading the recorded run…
      </p>
    );
  if (state.status !== "ready")
    return (
      <p className="l-lede l-error" role={state.status === "error" ? "alert" : undefined}>
        {state.message}
      </p>
    );
  return <Transcript excerpt={state.excerpt} events={state.events} mode={source.mode} />;
}

function Transcript({ excerpt, events, mode }: { excerpt: ExcerptData; events: readonly TimelineEvent[]; mode: DataMode }) {
  const root = useRef<HTMLDivElement>(null);
  const { rows: picked, held, sample, bundle } = excerpt;

  // The Run page's own row model and rows (src/pages/run), fed with the picked events: one
  // buildRows call per source run (so a probe's commitment and verdict pair up), then the held
  // decision with the guarded run's bundle. Keys get the run id, since seq repeats across runs.
  const rows = useMemo(() => {
    const byKey = new Map(events.map((e) => [`${e.runId}#${e.seq}`, e]));
    const chosen = picked.map((r) => byKey.get(r.key)).filter((e): e is TimelineEvent => !!e);
    const story = chosen.slice(0, -1);
    const runs = [...new Set(story.map((e) => e.runId))];
    const out: RunRow[] = runs.flatMap((runId) =>
      buildRows(story.filter((e) => e.runId === runId)).map((r) => ({ ...r, key: `${runId}-${r.key}` })),
    );
    const last = chosen.at(-1);
    const heldRow = last && buildRows([last], { bundle }).find((r) => r.type !== "intro");
    if (heldRow) out.push({ ...heldRow, key: `${bundle.runId}-${heldRow.key}` });
    return out;
  }, [events, picked, bundle]);
  const heldRow = rows.at(-1);
  const card = heldRow ? heldCard(heldRow, { mode, sample, bundle, approvals: null }) : null;

  useEffect(() => {
    // The section grew; scroll positions below it moved.
    ScrollTrigger.refresh();
  }, []);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(MOTION_OK, () => {
        gsap.from(gsap.utils.toArray<HTMLElement>(".l-row", root.current), {
          opacity: 0,
          y: 12,
          duration: 0.4,
          ease: "power2.out",
          stagger: 0.45,
          scrollTrigger: { trigger: root.current, start: "top 75%", once: true },
        });
      });
    },
    { scope: root },
  );

  return (
    <div ref={root}>
      {sample && (
        <p className="l-fixture" role="note">
          {FIXTURE_BANNER}
        </p>
      )}
      <ol
        className="run-transcript-static l-transcript"
        aria-label={`Recorded events behind ${held.runId}, request ${held.requestId}`}
      >
        {rows.map((row) => (
          <li key={row.key} className="l-row">
            <TranscriptRow row={row} card={row === heldRow && card ? <HeldCardView card={card} /> : undefined} />
          </li>
        ))}
      </ol>
      <p className="l-source">
        From{" "}
        {[...new Set(picked.map((r) => r.runId))].map((runId, i, all) => (
          <span key={runId}>
            {i > 0 && (i === all.length - 1 ? " and " : ", ")}
            <Link to={runHref(runId)}>
              <code>{runId}</code>
            </Link>
          </span>
        ))}
        , recorded timelines tied to their bundles’ hashes.
      </p>
    </div>
  );
}
