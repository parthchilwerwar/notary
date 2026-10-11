// /app/chat: Notary Chat. Messages in a centered column, the composer pinned at the bottom, steps
// streaming live inside each answer. Everything goes through `source.chat` (src/data): live =
// `notary serve` /api/chat (token required), replay = the deterministic engine over the published
// files. ?c= is the open conversation, ?q= prefills the composer (from ⌘K; never auto-sent).
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useSearchParams } from "react-router";
import type { ChatConversation, ChatEvent, ChatMessage } from "../../../../core/src/schema";
import { Button } from "../../components/ui/button";
import { useData } from "../../app/catalog";
import { LocalApiError, REPLAY_CHAT_BANNER, date, useDataSource, useSessionToken, worldKeyOf, worldLabel } from "../../data";
import { MessageView, UserMessage, CodeText } from "./MessageView";
import {
  EMPTY_TURN,
  INITIAL_FOLLOW,
  afterContentGrew,
  afterScroll,
  buildSuggestions,
  jumpToLatest,
  reduceChatEvents,
  type FollowState,
  type TurnView,
} from "./model";
import "./chat.css";

type Streaming = { question: string; events: ChatEvent[]; finished: boolean };

const MAX_LENGTH = 4000;

/** A stored assistant message as a view: its recorded events, else its final text alone. */
function storedView(m: ChatMessage): TurnView {
  if (m.events?.length) return reduceChatEvents(m.events, { finished: true });
  return { ...EMPTY_TURN, text: m.content, status: "done" };
}

const scrollMetrics = () => ({
  scrollTop: window.scrollY,
  scrollHeight: document.documentElement.scrollHeight,
  clientHeight: window.innerHeight,
});

export function ChatPage() {
  const { source, mode, ready } = useDataSource();
  const { selectedRunId, bundle, certificates } = useData();
  const chat = source.chat;
  const [params, setParams] = useSearchParams();
  const convId = params.get("c") ?? undefined;
  const [token, setToken] = useSessionToken();
  const needsToken = mode === "live" && !token;

  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [loadError, setLoadError] = useState<string>();
  const [streaming, setStreaming] = useState<Streaming | null>(null);
  const [draft, setDraft] = useState(() => params.get("q") ?? "");
  const [inputError, setInputError] = useState<string>();
  const [follow, setFollow] = useState<FollowState>(INITIAL_FOLLOW);
  const [world, setWorld] = useState<string>();
  const abort = useRef<AbortController | null>(null);
  const ownConversation = useRef<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const lastTop = useRef(0);
  const followRef = useRef(follow);
  followRef.current = follow;
  const inputId = useId();
  const errorId = useId();

  // The replay engine pins a new conversation to the selected run's world.
  useEffect(() => {
    chat.setContext?.({ runId: selectedRunId });
  }, [chat, selectedRunId]);

  // ?q= (from the command palette) prefills once, then leaves the URL.
  useEffect(() => {
    const q = params.get("q");
    if (q === null) return;
    setDraft(q);
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        next.delete("q");
        return next;
      },
      { replace: true },
    );
    requestAnimationFrame(() => textarea.current?.focus());
  }, [params, setParams]);

  const refreshList = useCallback(async () => {
    if (!ready || needsToken) return;
    try {
      setConversations(await chat.listConversations());
    } catch (e) {
      if (e instanceof LocalApiError && e.status === 401) return;
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [chat, ready, needsToken]);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  // Open the conversation named in ?c= (not when we just created it while sending).
  useEffect(() => {
    if (!ready || needsToken) return;
    if (!convId) {
      setHistory([]);
      return;
    }
    if (ownConversation.current === convId) return;
    abort.current?.abort();
    setStreaming(null);
    const controller = new AbortController();
    setLoadError(undefined);
    chat
      .getConversation(convId, controller.signal)
      .then((d) => {
        if (!controller.signal.aborted) setHistory(d.messages);
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) {
          setHistory([]);
          setLoadError(e.message);
        }
      });
    return () => controller.abort();
  }, [chat, convId, ready, needsToken]);

  // Replay: which world this conversation answers from (for the label under the banner).
  useEffect(() => {
    let live = true;
    const replayChat = chat as typeof chat & { conversationWorld?: (id: string) => Promise<{ label: string } | undefined> };
    if (mode !== "replay") return setWorld(undefined);
    if (convId && replayChat.conversationWorld)
      void replayChat.conversationWorld(convId).then((w) => live && setWorld(w?.label ?? (bundle ? worldLabel(worldKeyOf(bundle)) : undefined)));
    else setWorld(bundle ? worldLabel(worldKeyOf(bundle)) : undefined);
    return () => {
      live = false;
    };
  }, [chat, convId, mode, bundle, history.length]);

  useEffect(() => () => abort.current?.abort(), []);

  // ------------------------------------------------------------------------- auto-scroll
  useEffect(() => {
    const onScroll = () => {
      const m = scrollMetrics();
      setFollow((s) => afterScroll(s, m, lastTop.current));
      lastTop.current = m.scrollTop;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const contentSize = (streaming?.events.length ?? 0) + history.length;
  useLayoutEffect(() => {
    if (!streaming && !history.length) return;
    if (followRef.current.follow) {
      window.scrollTo({ top: document.documentElement.scrollHeight });
      lastTop.current = window.scrollY;
    } else setFollow(afterContentGrew);
  }, [contentSize, streaming, history.length]);

  // --------------------------------------------------------------------------- sending
  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content) return setInputError("Type a question first.");
      if (content.length > MAX_LENGTH) return setInputError(`Questions are limited to ${MAX_LENGTH} characters.`);
      if (streaming && !streaming.finished) return;
      setInputError(undefined);
      setDraft("");
      setFollow(jumpToLatest());
      const controller = new AbortController();
      abort.current = controller;
      setStreaming({ question: content, events: [], finished: false });
      const push = (e: ChatEvent) => setStreaming((s) => (s ? { ...s, events: [...s.events, e] } : s));
      let id = convId;
      try {
        if (!id) {
          const conversation = await chat.createConversation();
          id = conversation.id;
          ownConversation.current = id;
          setParams((p) => {
            const next = new URLSearchParams(p);
            next.set("c", conversation.id);
            return next;
          });
        } else ownConversation.current = id;
        await chat.sendMessage(id, content, push, controller.signal);
      } catch (e) {
        if (!controller.signal.aborted) {
          if (e instanceof LocalApiError && e.status === 401) setToken(null);
          push({ type: "error", message: e instanceof Error ? e.message : String(e) });
        }
      }
      setStreaming((s) => (s ? { ...s, finished: true } : s));
      if (abort.current === controller) abort.current = null;
      // Sync with what the source recorded (live: the server's sqlite; replay: sessionStorage).
      try {
        if (id) {
          const detail = await chat.getConversation(id);
          if (detail.messages.some((m) => m.role === "user" && m.content === content)) {
            setHistory(detail.messages);
            setStreaming(null);
          }
        }
      } catch {
        // Keep the streamed copy on screen.
      }
      void refreshList();
    },
    [chat, convId, refreshList, setParams, setToken, streaming],
  );

  const stop = () => {
    abort.current?.abort();
    setStreaming((s) => (s ? { ...s, finished: true } : s));
  };

  const newChat = () => {
    abort.current?.abort();
    ownConversation.current = null;
    setStreaming(null);
    setHistory([]);
    setLoadError(undefined);
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.delete("c");
      return next;
    });
    requestAnimationFrame(() => textarea.current?.focus());
  };

  const remove = async (id: string) => {
    try {
      await chat.deleteConversation(id);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (id === convId) newChat();
    void refreshList();
  };

  // Live chat reads real runs only: a fixture run's records would make misleading prompts there.
  const suggestions = useMemo(() => {
    const usable = mode === "replay" || (bundle && !bundle.sample);
    return buildSuggestions(usable ? bundle : undefined, usable && certificates.status === "ready" ? certificates.data.certificates : []);
  }, [bundle, certificates, mode]);

  const busy = !!streaming && !streaming.finished;
  const empty = !history.length && !streaming;
  const streamView = useMemo(
    () => (streaming ? reduceChatEvents(streaming.events, { finished: streaming.finished }) : undefined),
    [streaming],
  );

  // Grow the textarea with its content (up to the CSS max-height).
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(draft);
    }
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(draft);
  };

  return (
    <div className="chat-page" data-empty={empty || undefined}>
      <header className="chat-head">
        <h1>Chat</h1>
        <div className="chat-head-actions">
          <RecentChats
            conversations={conversations}
            current={convId}
            onOpen={(id) => {
              ownConversation.current = null;
              setParams((p) => {
                const next = new URLSearchParams(p);
                next.set("c", id);
                return next;
              });
            }}
            onDelete={remove}
          />
          <Button type="button" variant="outline" size="sm" onClick={newChat}>
            New chat
          </Button>
        </div>
      </header>
      {mode === "replay" && (
        <p className="chat-banner" role="note">
          {REPLAY_CHAT_BANNER}
          {world && <span className="chat-muted"> · Answers from {world}</span>}
        </p>
      )}
      {loadError && (
        <p className="chat-error" role="alert">
          {loadError}
        </p>
      )}

      <div className="chat-thread" aria-label="Conversation">
        {empty ? (
          <div className="chat-empty">
            <h2>Ask Notary anything about its runs, certificates or the APIs it checks</h2>
            <ul className="chat-suggestions" aria-label="Suggested questions">
              {suggestions.map((s) => (
                <li key={s}>
                  <button type="button" disabled={needsToken} onClick={() => void send(s)}>
                    {s}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <>
            {history.map((m) =>
              m.role === "user" ? (
                <UserMessage key={m.id} text={m.content} />
              ) : (
                <MessageView key={m.id} view={storedView(m)} mode={mode} messageKey={m.id} runId={selectedRunId} traceLinks={bundle?.traceLinks} />
              ),
            )}
            {streaming && streamView && (
              <>
                <UserMessage text={streaming.question} />
                <MessageView view={streamView} mode={mode} messageKey="streaming" runId={selectedRunId} traceLinks={bundle?.traceLinks} />
              </>
            )}
          </>
        )}
      </div>

      <div className="chat-dock">
        {follow.unseen && (
          <button
            type="button"
            className="chat-jump"
            onClick={() => {
              setFollow(jumpToLatest());
              window.scrollTo({ top: document.documentElement.scrollHeight });
            }}
          >
            Jump to latest
          </button>
        )}
        {needsToken ? (
          <TokenForm onToken={setToken} />
        ) : (
          <form className="chat-composer" onSubmit={onSubmit}>
            <label htmlFor={inputId} className="sr-only">
              Message Notary
            </label>
            <textarea
              id={inputId}
              ref={textarea}
              name="message"
              rows={1}
              value={draft}
              maxLength={MAX_LENGTH + 200}
              placeholder="Ask Notary a question…"
              autoComplete="off"
              aria-describedby={inputError ? errorId : undefined}
              aria-invalid={inputError ? true : undefined}
              onChange={(e) => {
                setDraft(e.target.value);
                if (inputError) setInputError(undefined);
              }}
              onKeyDown={onKeyDown}
            />
            {busy ? (
              <Button type="button" variant="outline" size="sm" onClick={stop}>
                Stop
              </Button>
            ) : (
              <Button type="submit" size="sm" disabled={!draft.trim()}>
                Send
              </Button>
            )}
          </form>
        )}
        {inputError && (
          <p id={errorId} className="chat-input-error" role="alert">
            {inputError}
          </p>
        )}
        <p className="chat-hint">
          Enter sends · Shift+Enter adds a line ·{" "}
          {mode === "replay" ? "Replay reads recorded files only" : "Answers cite the records each step returned"}
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------- token form */

function TokenForm({ onToken }: { onToken: (t: string) => void }) {
  const [value, setValue] = useState("");
  const id = useId();
  return (
    <form
      className="chat-token"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) onToken(value.trim());
      }}
    >
      <label htmlFor={id}>Session token</label>
      <p className="chat-muted">
        <CodeText text="Paste the token `notary serve` printed at startup. It stays in this tab only." />
      </p>
      <div className="chat-token-row">
        <input id={id} name="session-token" type="password" autoComplete="off" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} />
        <Button type="submit" size="sm" disabled={!value.trim()}>
          Use token
        </Button>
      </div>
    </form>
  );
}

/* ----------------------------------------------------------------------- recent chats */

function RecentChats({
  conversations,
  current,
  onOpen,
  onDelete,
}: {
  conversations: ChatConversation[];
  current?: string;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<string>();
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="chat-recent" ref={root}>
      <Button ref={button} type="button" variant="outline" size="sm" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen((v) => !v)}>
        Recent chats{conversations.length ? ` (${conversations.length})` : ""}
      </Button>
      {open && (
        <div id={menuId} className="chat-recent-menu" role="region" aria-label="Recent chats">
          {conversations.length === 0 ? (
            <p className="chat-muted">No chats yet. Ask a question to start one.</p>
          ) : (
            <ul>
              {conversations.map((c) => (
                <li key={c.id} aria-current={c.id === current || undefined}>
                  {confirm === c.id ? (
                    <div className="chat-recent-confirm">
                      <span>Delete “{c.title}”?</span>
                      <button
                        type="button"
                        className="chat-link-button chat-danger"
                        onClick={() => {
                          setConfirm(undefined);
                          onDelete(c.id);
                        }}
                      >
                        Delete
                      </button>
                      <button type="button" className="chat-link-button" onClick={() => setConfirm(undefined)}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="chat-recent-open"
                        onClick={() => {
                          setOpen(false);
                          onOpen(c.id);
                        }}
                      >
                        <span className="chat-recent-title">{c.title}</span>
                        <span className="chat-muted">{date(c.updatedAt)}</span>
                      </button>
                      <button type="button" className="chat-link-button" aria-label={`Delete chat “${c.title}”`} onClick={() => setConfirm(c.id)}>
                        Delete
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
