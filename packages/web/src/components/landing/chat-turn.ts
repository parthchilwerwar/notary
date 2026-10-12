// The chat turn the landing shows (feature card 03 and the chat showcase): one turn of the data
// layer's deterministic chat engine (ReplayChat: no model, no backend) over the published runs,
// asked a question built from those runs. The events are collected
// once (no pacing) and the components replay them on screen. Conversations stay in memory only.
import type { ChatCitation, ChatEvent, ChatToolName } from "../../../../core/src/schema";
import { entryOfBundle, memoryChatStore, ReplayChat, type ReplaySource } from "../../data";
import { answerParagraphs, chatQuestions, showable } from "../../landing-data";
import { memoByView, replayPair } from "./replay";

export type TurnStep = {
  id: string;
  tool: ChatToolName;
  title: string;
  status?: "ok" | "error" | "unavailable" | "aborted";
  output?: string;
  durationMs?: number;
};

export type ChatTurn = {
  question: string;
  runId: string;
  sample: boolean;
  steps: TurnStep[];
  /** The engine's disclosure line ("Answering from fixture scenario …"), when it wrote one. */
  disclosure?: string;
  paragraphs: string[];
  citations: ChatCitation[];
};

/** Fold one turn's events into steps, answer text and citations. */
export function foldChat(events: readonly ChatEvent[]): Pick<ChatTurn, "steps" | "disclosure" | "paragraphs" | "citations"> {
  const steps: TurnStep[] = [];
  let text = "";
  let citations: ChatCitation[] = [];
  for (const e of events) {
    if (e.type === "step_started") steps.push({ id: e.id, tool: e.tool, title: e.title });
    else if (e.type === "step_finished") {
      const s = steps.find((x) => x.id === e.id);
      if (s) Object.assign(s, { status: e.status, output: e.output, durationMs: e.durationMs });
    } else if (e.type === "text_delta") text += e.text;
    else if (e.type === "citations") citations = e.items;
  }
  const { disclosure, paragraphs } = answerParagraphs(text);
  return { steps, disclosure, paragraphs, citations };
}


/**
 * Keep only what the landing may show: steps whose title and output pass `showable`, the answer
 * paragraphs that pass it (so run identifiers and environment notes stay in the dashboard), and
 * the citations those paragraphs use. The engine's disclosure line is dropped here.
 */
export function presentable(turn: ChatTurn): ChatTurn {
  // One block per line (the engine writes "- " list items under a heading line).
  const paragraphs = turn.paragraphs.flatMap((p) => p.split("\n")).map((l) => l.trim().replace(/^- /, "• ")).filter((l) => l && showable(l));
  return {
    ...turn,
    disclosure: undefined,
    steps: turn.steps.filter((s) => showable(s.title) && showable(s.output ?? "")),
    paragraphs,
    citations: turn.citations.filter((c) => showable(c.label)),
  };
}

/**
 * One chat turn of the replay engine over the published runs: the first candidate question (see
 * landing-data `chatQuestions`) whose presentable part has at least two steps and an answer.
 * null when none qualifies or the engine errors.
 */
export const loadChatTurn: (replay: ReplaySource, fixtures?: boolean) => Promise<ChatTurn | null> = memoByView(
  async (replay: ReplaySource, fixtures: boolean): Promise<ChatTurn | null> => {
    const { preview: guarded } = await replayPair(replay, fixtures);
    if (!guarded) return null;
    const world = await replay.certificates(entryOfBundle(guarded));
    // Pinned to the showcase run and to this view: only that cohort's bundles are fetched.
    const chat = new ReplayChat(replay, { store: memoryChatStore(), pace: "instant", fixtures: () => fixtures });
    chat.setContext({ runId: guarded.runId });
    for (const question of chatQuestions(guarded, world.tools.map((t) => t.tool))) {
      const conversation = await chat.createConversation();
      const events: ChatEvent[] = [];
      await chat.sendMessage(conversation.id, question, (e) => events.push(e));
      if (events.some((e) => e.type === "error")) continue;
      const turn = presentable({ question, runId: guarded.runId, sample: guarded.sample, ...foldChat(events) });
      if (turn.steps.length >= 2 && turn.paragraphs.length >= 1) return turn;
    }
    return null;
  },
);

// ------------------------------------------------------------------------------- answer text

export type Token =
  | { kind: "text"; s: string }
  | { kind: "code"; s: string }
  | { kind: "strong"; s: string }
  | { kind: "cite"; n: number };

/** The answer's light markdown as tokens: `code`, **strong**, [n] citation markers, plain text. */
export function tokenize(paragraph: string): Token[] {
  const out: Token[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[(\d+)\]/g;
  let last = 0;
  for (let m = re.exec(paragraph); m; m = re.exec(paragraph)) {
    if (m.index > last) out.push({ kind: "text", s: paragraph.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: "code", s: m[1] });
    else if (m[2] !== undefined) out.push({ kind: "strong", s: m[2] });
    else out.push({ kind: "cite", n: Number(m[3]) });
    last = m.index + m[0].length;
  }
  if (last < paragraph.length) out.push({ kind: "text", s: paragraph.slice(last) });
  return out;
}

/** Number of visible characters in tokens (a citation counts as one). */
export const tokenLength = (tokens: readonly Token[]) =>
  tokens.reduce((n, t) => n + (t.kind === "cite" ? 1 : t.s.length), 0);

/** Citation numbers used in some text. */
export const citedNumbers = (paragraphs: readonly string[]) =>
  new Set(paragraphs.flatMap((p) => tokenize(p).flatMap((t) => (t.kind === "cite" ? [t.n] : []))));
