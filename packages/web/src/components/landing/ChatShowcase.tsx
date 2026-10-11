// The chat showcase window (lazy): one recorded turn of the replay chat engine, replayed on screen
// step by step — steps appear one at a time, the cited answer streams in, then it holds. It
// restarts only when the window re-enters the viewport. Reduced motion: the whole turn at once.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { DataSource } from "../../data";
import { clipText } from "../../landing-data";
import { AgentBadge } from "../../ui/AgentBadge";
import "../../ui/kit.css";
import {
  loadChatTurn,
  tokenize,
  tokenLength,
  type ChatTurn,
} from "./chat-turn";
import { ChatWindow } from "./ChatWindow";
import { gsap, MOTION_OK, ScrollTrigger, useGSAP } from "./gsap";
import { replayFor } from "./replay";

type State =
  | { status: "loading" }
  | { status: "ready"; turn: ChatTurn }
  | { status: "empty"; message: string };

/** The first answer lines, clipped for the window (the full answer is in the dashboard's Chat). */
const showcaseParagraphs = (turn: ChatTurn) => turn.paragraphs.slice(0, 6).map((p) => clipText(p, 150));

export default function ChatShowcase({ source }: { source: DataSource }) {
  const [state, setState] = useState<State>({ status: "loading" });
  useEffect(() => {
    let live = true;
    loadChatTurn(replayFor(source)).then(
      (turn) =>
        live &&
        setState(
          turn
            ? { status: "ready", turn }
            : {
                status: "empty",
                message: "No chat answer is published yet.",
              },
        ),
      (e: unknown) =>
        live &&
        setState({
          status: "empty",
          message: e instanceof Error ? e.message : String(e),
        }),
    );
    return () => {
      live = false;
    };
  }, [source]);

  if (state.status !== "ready")
    return (
      <div
        className="l-chat-window l-chat-window-pending"
        aria-busy={state.status === "loading"}
      >
        <p className="l-lede">
          {state.status === "loading"
            ? "Loading the chat…"
            : state.message}
        </p>
      </div>
    );
  return <Replay turn={state.turn} />;
}

function Replay({ turn }: { turn: ChatTurn }) {
  const root = useRef<HTMLDivElement>(null);
  const paragraphs = showcaseParagraphs(turn);
  const total = paragraphs.reduce((n, p) => n + tokenLength(tokenize(p)), 0);
  const shortened =
    turn.paragraphs.length > paragraphs.length ||
    paragraphs.some((p, i) => p !== turn.paragraphs[i]);
  const [steps, setSteps] = useState(turn.steps.length);
  const [chars, setChars] = useState(Infinity);

  useEffect(() => {
    ScrollTrigger.refresh();
  }, []);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(MOTION_OK, () => {
        const stream = { c: 0 };
        const tl = gsap.timeline({ paused: true });
        tl.call(() => {
          setSteps(0);
          setChars(0);
          stream.c = 0;
        });
        turn.steps.forEach((_, i) =>
          tl.call(() => setSteps(i + 1), [], `+=${i === 0 ? 0.35 : 0.7}`),
        );
        tl.to(stream, {
          c: total,
          duration: Math.min(3.2, total / 160),
          ease: "none",
          delay: 0.6,
          onUpdate: () => setChars(Math.round(stream.c)),
        });
        tl.call(() => setChars(Infinity));
        ScrollTrigger.create({
          trigger: root.current,
          start: "top 80%",
          end: "bottom 10%",
          onEnter: () => tl.restart(),
          onEnterBack: () => tl.restart(),
          // Out of view: jump to the end and hold there; re-entering replays it.
          onLeave: () => tl.progress(1, false).pause(),
          onLeaveBack: () => tl.progress(1, false).pause(),
        });
        return () => {
          setSteps(turn.steps.length);
          setChars(Infinity);
        };
      });
    },
    { scope: root, dependencies: [turn] },
  );

  return (
    <div className="l-chat-showcase">
      <div ref={root} className="l-chat-window">
        <ChatWindow
          question={turn.question}
          steps={turn.steps}
          paragraphs={paragraphs}
          citations={turn.citations}
          visibleSteps={steps}
          chars={chars}
          disclosure={turn.disclosure}
          header={
            <div className="l-chat-head">
              <span className="l-chat-title">Ask about your runs</span>
              <AgentBadge agent="chat" showKind className="l-agent" />
            </div>
          }
          footer={
            <div className="l-chat-input" aria-hidden="true" inert>
              <span>Ask about a held refund, a certificate or a run…</span>
              <span className="l-chat-send" />
            </div>
          }
        />
      </div>
      <p className="l-chat-note">
        {shortened ? "Answer shortened here. " : ""}
        <Link to="/app/chat">Ask your own question in the dashboard</Link>
      </p>
    </div>
  );
}
