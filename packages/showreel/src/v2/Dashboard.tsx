// The dashboard as product UI, built from the web app's own pieces (read-only imports): the shell's
// sidebar classes (components/shell/shell.css), BrowserFrame, SkyBand + StatRow/Stat, the Run page's
// TranscriptRow and held-card styling, and Notary Chat's UserMessage + MessageView driven by
// reduceChatEvents. Nothing animates by itself: every visible change is a prop computed from the
// frame by the caller.
import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { useCurrentFrame } from "remotion";
import { BrowserFrame, Button, Card, Page, PageBody, SkyBand, SkyBandContext, Stat, StatRow, WashCard } from "@web/ui";
import { navRoutes } from "@web/routes";
import { TranscriptRow } from "@web/pages/run/Transcript";
import type { RunRow } from "@web/pages/run/model";
import { MessageView, UserMessage } from "@web/pages/chat/MessageView";
import { reduceChatEvents } from "@web/pages/chat/model";
import { ArrowUp } from "@web/pages/chat/icons";
import "@web/components/shell/shell.css";
import type { ShowreelData } from "../data-schema";

export const FRAME_W = 1600;
export const FRAME_H = 980;
const BAND = { inShell: true } as const;

type Dash = ShowreelData["dashboard"];
type RunData = Dash["naive"];

/** Clouds inside the SkyBand drift with the frame (the web's GSAP loop is off in the film). */
function useCloudDrift(root: React.RefObject<HTMLElement | null>) {
  const frame = useCurrentFrame();
  useLayoutEffect(() => {
    root.current?.querySelectorAll<HTMLElement>(".clouds-track").forEach((el, i) => {
      el.style.transform = `translateX(${-(frame * (0.05 + i * 0.03)) % 33.333}%)`;
    });
  });
}

function Sidebar({ active, hover, press }: { active: string; hover?: string; press?: number }) {
  return (
    <aside className="side" aria-label="Dashboard" style={{ height: "100%", position: "relative" }}>
      <div className="side-top">
        <span className="side-brand">Notary</span>
      </div>
      <nav className="side-nav" aria-label="Pages">
        <ul>
          {navRoutes().map((r) => (
            <li key={r.id}>
              <span
                className="side-item"
                aria-current={active === r.id ? "page" : undefined}
                data-film-hover={hover === r.id || undefined}
                style={hover === r.id && press ? { transform: `scale(${1 - 0.03 * press})` } : undefined}
              >
                <span>{r.title}</span>
              </span>
            </li>
          ))}
        </ul>
      </nav>
      <div className="side-foot">
        <span className="side-item">Report</span>
      </div>
    </aside>
  );
}

/** The Run page's five-step bar (RunPage StageBar markup), counts as streamed so far. */
function StageBar({ stages }: { stages: { stage: string; label: string; count: number; state: string; current?: boolean }[] }) {
  return (
    <ol className="run-stages">
      {stages.map((s) => (
        <li key={s.stage} data-state={s.state} data-current={s.current || undefined}>
          <span className="run-stage-bar" aria-hidden="true" />
          <span className="run-stage-label">
            {s.label}
            <span className="run-stage-count">{s.count}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export type RunViewProps = {
  run: RunData;
  title: string;
  summary: string;
  /** Rows on screen (fractional = the last one entering). */
  rows: number;
  /** Transcript scroll in px. */
  scroll: number;
  stats: ReactNode;
  /** Extra content under a row, by row key (the held card, the certificate it relies on). */
  under?: Record<string, ReactNode>;
  /** Row keys with the hover lift. */
  lifted?: string;
};

export function RunView({ run, title, summary, rows, scroll, stats, under = {}, lifted }: RunViewProps) {
  const shown = Math.ceil(rows);
  const streamed = run.rows.slice(0, Math.max(0, shown));
  const enforce = streamed.length + (rows >= run.rows.length ? Math.max(0, (run.stages.at(-1)?.count ?? 0) - run.rows.length) : 0);
  const stages = run.stages.map((s) =>
    s.stage === "enforce"
      ? { ...s, count: enforce, state: enforce === 0 ? "idle" : streamed.some((r) => r.tone === "unsafe") ? "alert" : rows < run.rows.length ? "active" : "done", current: rows < run.rows.length }
      : s,
  );
  return (
    <Page className="run-page">
      <SkyBand title={title} summary={summary}>
        <StageBar stages={stages} />
      </SkyBand>
      <PageBody>
        <StatRow label="This run">{stats}</StatRow>
        <Card as="section" padding="none" className="run-transcript" aria-label="Transcript">
          <header className="run-transcript-head">
            <div className="run-status">
              <h2 className="ui-title ui-title-card">Transcript</h2>
              <span>
                {streamed.length} {streamed.length === 1 ? "event" : "events"}
                {rows >= run.rows.length ? " · finished" : " · running"}
              </span>
            </div>
          </header>
          <div className="run-scroll" style={{ height: 520, overflow: "hidden" }}>
            <div style={{ transform: `translateY(${-scroll}px)` }}>
              {streamed.map((r, i) => {
                const t = Math.min(1, Math.max(0, rows - i));
                const style: CSSProperties = {
                  opacity: t,
                  transform: `translateX(${(1 - t) * -10}px)${lifted === r.key ? " translateY(-2px)" : ""}`,
                  boxShadow: lifted === r.key ? "0 10px 28px rgb(47 106 235 / 0.12)" : undefined,
                  borderRadius: 14,
                  background: lifted === r.key ? "var(--card)" : undefined,
                  position: "relative",
                  zIndex: lifted === r.key ? 2 : undefined,
                };
                return (
                  <div key={r.key} data-row={r.key} style={style}>
                    <TranscriptRow row={r as unknown as RunRow} card={under[r.key]} />
                  </div>
                );
              })}
            </div>
          </div>
        </Card>
      </PageBody>
    </Page>
  );
}

/** The held-action card under a held row: the Run page's .run-held peach WashCard with the reason and
 * evidence as recorded, and the approval controls inert (approvals need a local test-mode server). */
export function HeldCard({ held, hover, focus }: { held: Dash["held"]; hover?: "approve"; focus?: number }) {
  return (
    <WashCard
      wash="peach"
      padding="sm"
      className="run-held"
      style={{ boxShadow: focus ? `0 0 0 ${2 * focus}px var(--accent)` : undefined }}
    >
      <p className="run-held-reason">
        <span className="run-held-label">Held</span> {held.reason}
      </p>
      {held.evidence.length > 0 && (
        <ul className="run-held-evidence">
          {held.evidence.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <div className="run-held-actions" aria-hidden="true">
        {held.amount && <span className="run-muted">Held amount {held.amount}</span>}
        <Button size="sm" tabIndex={-1} data-film-hover={hover === "approve" || undefined}>
          Approve…
        </Button>
        <Button size="sm" variant="secondary" tabIndex={-1}>
          Reject…
        </Button>
      </div>
    </WashCard>
  );
}

export type ChatViewProps = {
  question: string;
  /** Characters of the question typed into the composer (before it is sent). */
  typed: number;
  sent: boolean;
  /** Chat events applied so far. */
  events: ShowreelData["chat"]["events"];
  caret: boolean;
  sendHover?: boolean;
};

export function ChatView({ question, typed, sent, events, caret, sendHover }: ChatViewProps) {
  const frame = useCurrentFrame();
  const view = reduceChatEvents(events);
  const draft = sent ? "" : question.slice(0, typed);
  return (
    <div className="chat-page" style={{ minHeight: 0 }}>
      <SkyBand className="chat-band" title="Notary Chat" summary="Ask about runs, certificates, approvals and the APIs Notary checks." />
      <div className="chat-thread" aria-label="Conversation" style={{ minHeight: 380 }}>
        {sent && (
          <>
            <UserMessage text={question} />
            {/* Remounted every frame: its internal state (collapse on finish) starts from the view. */}
            <MessageView key={frame} view={view} mode="replay" messageKey="film" compact />
          </>
        )}
      </div>
      <div className="chat-dock" style={{ position: "relative" }}>
        <form className="chat-composer" onSubmit={(e) => e.preventDefault()} style={{ borderColor: !sent && typed > 0 ? "var(--accent)" : undefined }}>
          <div style={{ flex: 1, minHeight: 26, padding: "4px 0", fontSize: 15, lineHeight: "22px", color: draft ? "var(--text)" : "var(--text-muted)", whiteSpace: "pre" }}>
            {draft || (sent ? "Ask Notary a question…" : typed === 0 && !caret ? "Ask Notary a question…" : "")}
            {caret && !sent && <span style={{ display: "inline-block", width: 1.5, height: 18, marginLeft: 1, verticalAlign: -3, background: "var(--accent)" }} />}
          </div>
          <button type="button" className="chat-send" disabled={!draft} aria-label="Send" data-film-hover={sendHover || undefined}>
            <ArrowUp />
          </button>
        </form>
      </div>
    </div>
  );
}

/** The browser window + shell around a page. */
export function Dashboard({ active, hover, press, children, address }: { active: string; hover?: string; press?: number; children: ReactNode; address: string }) {
  const root = useRef<HTMLDivElement>(null);
  useCloudDrift(root);
  return (
    <div ref={root} className="film-app" style={{ width: FRAME_W }}>
      <BrowserFrame address={address} decorative>
        <SkyBandContext.Provider value={BAND}>
          <div className="app-shell" style={{ height: FRAME_H - 41, minHeight: 0, overflow: "hidden" }}>
            <Sidebar active={active} hover={hover} press={press} />
            <div className="app-column">
              <main className="app-main" style={{ paddingBottom: 32 }}>
                {children}
              </main>
            </div>
          </div>
        </SkyBandContext.Provider>
      </BrowserFrame>
    </div>
  );
}

export { Stat };
