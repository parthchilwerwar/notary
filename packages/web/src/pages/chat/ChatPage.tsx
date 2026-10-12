// /app/chat: Notary Chat. A plain header line, messages in a centered reading column, the composer
// docked at the bottom, steps
// streaming live inside each answer. Everything goes through `source.chat` (src/data): live =
// `notary serve` /api/chat (token required), replay = the deterministic engine over the published
// files. ?c= is the open conversation, ?q= prefills the composer (from ⌘K; never auto-sent).
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router";
import type { ChatConversation, ChatEvent, ChatMessage } from "../../../../core/src/schema";
import { AGENTS } from "../../../../core/src/schema";
import { Button, EmptyState, ReplayBadge, Skeleton, SkyBand, usePageMotion } from "../../ui";
import { replayBadge } from "../../app/links";
import { ArrowDown, ArrowUp, CaretDown, CaretRight, Plus, StopSquare, Trash } from "./icons";
import { useData } from "../../app/catalog";
import { LocalApiError, REPLAY_CHAT_BANNER, date, useDataSource, useSessionToken, worldKeyOf, worldLabel, type WorldKey } from "../../data";
import { MessageView, UserMessage, CodeText } from "./MessageView";
import {
  EMPTY_TURN,
  INITIAL_FOLLOW,
  afterContentGrew,
  afterScroll,
  buildSuggestionCards,
  jumpToLatest,
  reduceChatEvents,
  type FollowState,
  type TurnView,
} from "./model";
import "./chat-tokens.css";
import "./chat.css";

type Streaming = { question: string; events: ChatEvent[]; finished: boolean };
type LoadFailure = "list" | "open" | "delete";

const MAX_LENGTH = 4000;
/** The dock's standing note: what Chat can and cannot do (product copy, not data). */
const CAPABILITY_HINT = "Notary Chat can read runs, certificates, approvals and allowed docs. It cannot move money.";

/**
 * Which records a replay conversation answers from, in plain words. The shell already discloses a
 * selected sample run, so a scenario then reads "the default scenario"; when the conversation's
 * world is a scenario but the selected run is real, the data layer's full label (with its
 * disclosure) stays.
 */
function worldPhrase(key: WorldKey, selectedIsSample: boolean): string {
  if (key === "real") return "real runs";
  if (key.startsWith("fixture:") && selectedIsSample) return `the ${key.slice("fixture:".length)} scenario`;
  return worldLabel(key);
}

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
  const { selectedRunId, bundle, bundles, certificates } = useData();
  // The selected run is a replay: say so wherever the chat names it ("Replay of <original>").
  const selectedReplay = replayBadge(bundle, bundles);
  const chat = source.chat;
  const [params, setParams] = useSearchParams();
  const convId = params.get("c") ?? undefined;
  const [token, setToken] = useSessionToken();
  const needsToken = mode === "live" && !token;

  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [history, setHistory] = useState<ChatMessage[]>([]);
  // Which load failed (shown as a state with its fix; the raw error text is never shown).
  const [loadError, setLoadError] = useState<LoadFailure>();
  const [opening, setOpening] = useState(false);
  const [reopen, setReopen] = useState(0);
  const [streaming, setStreaming] = useState<Streaming | null>(null);
  const [draft, setDraft] = useState(() => params.get("q") ?? "");
  const [inputError, setInputError] = useState<string>();
  const [follow, setFollow] = useState<FollowState>(INITIAL_FOLLOW);
  const [world, setWorld] = useState<WorldKey>();
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
      setLoadError("list");
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
    setOpening(true);
    chat
      .getConversation(convId, controller.signal)
      .then((d) => {
        if (!controller.signal.aborted) setHistory(d.messages);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setHistory([]);
          setLoadError("open");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setOpening(false);
      });
    return () => {
      controller.abort();
      setOpening(false);
    };
    // `reopen` re-runs this load after a failure ("Try again").
  }, [chat, convId, ready, needsToken, reopen]);

  // Replay: which world this conversation answers from (for the label under the banner).
  useEffect(() => {
    let live = true;
    const replayChat = chat as typeof chat & { conversationWorld?: (id: string) => Promise<{ world: WorldKey } | undefined> };
    if (mode !== "replay") return setWorld(undefined);
    if (convId && replayChat.conversationWorld)
      void replayChat.conversationWorld(convId).then((w) => live && setWorld(w?.world ?? (bundle ? worldKeyOf(bundle) : undefined)));
    else setWorld(bundle ? worldKeyOf(bundle) : undefined);
    return () => {
      live = false;
    };
  }, [chat, convId, mode, bundle, history.length]);

  useEffect(() => () => abort.current?.abort(), []);

  // The page fills the viewport below whatever sits above it (banners, top bar), so the composer
  // rests at the bottom even when the thread is short. Re-measured when the layout above changes.
  // Kit page motion: the band title's words rise in once (nothing under reduced motion).
  const pageRef = usePageMotion([]);
  useLayoutEffect(() => {
    const el = pageRef.current;
    if (!el) return;
    const measure = () => {
      const top = Math.max(0, Math.round(el.getBoundingClientRect().top + window.scrollY));
      if (el.style.getPropertyValue("--chat-offset") !== `${top}px`) el.style.setProperty("--chat-offset", `${top}px`);
    };
    measure();
    window.addEventListener("resize", measure);
    const ro = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    ro?.observe(document.body);
    return () => {
      window.removeEventListener("resize", measure);
      ro?.disconnect();
    };
  }, []);

  // ------------------------------------------------------------------------- auto-scroll
  useEffect(() => {
    const onScroll = () => {
      const m = scrollMetrics();
      setFollow((s) => afterScroll(s, m, lastTop.current));
      lastTop.current = m.scrollTop;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    // Scrolling up while text streams in: a chunk lands every few ms and would scroll the page
    // back down before the scroll event arrives, so the user's intent is read from the input
    // itself (wheel up, finger dragging down, PageUp/ArrowUp/Home) and following stops at once.
    const release = () => {
      if (!followRef.current.follow) return;
      followRef.current = { ...followRef.current, follow: false };
      setFollow((s) => ({ ...s, follow: false }));
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) release();
    };
    let touchY = 0;
    const onTouchStart = (e: TouchEvent) => {
      touchY = e.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      if ((e.touches[0]?.clientY ?? 0) > touchY + 4) release();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable)) return;
      if (e.key === "PageUp" || e.key === "ArrowUp" || e.key === "Home") release();
    };
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("keydown", onKey);
    };
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
    } catch {
      setLoadError("delete");
      return;
    }
    if (id === convId) newChat();
    void refreshList();
  };

  // Live chat reads real runs only: a fixture run's records would make misleading prompts there.
  const suggestions = useMemo(() => {
    const usable = mode === "replay" || (bundle && !bundle.sample);
    return buildSuggestionCards(usable ? bundle : undefined, usable && certificates.status === "ready" ? certificates.data.certificates : []);
  }, [bundle, certificates, mode]);

  const busy = !!streaming && !streaming.finished;
  const empty = !history.length && !streaming && !opening;
  const currentTitle = convId ? conversations.find((c) => c.id === convId)?.title : undefined;
  const hintId = `${inputId}-hint`;
  // Try again: reload the list, and reopen the conversation in ?c= (re-run the open effect).
  const retry = () => {
    setLoadError(undefined);
    void refreshList();
    if (convId) setReopen((n) => n + 1);
  };
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
    <div className="chat-page" ref={pageRef} data-empty={empty || undefined}>
      <SkyBand
        className="chat-band"
        title={AGENTS.chat.name}
        summary={currentTitle ?? "Ask about runs, certificates, approvals and the APIs Notary checks."}
        action={
          <>
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
            <Button variant="primary" size="sm" className="chat-new" onClick={newChat}>
              <Plus />
              New chat
            </Button>
          </>
        }
      />
      {mode === "replay" && (
        <p className="chat-banner" role="note">
          <span className="chat-banner-main">{REPLAY_CHAT_BANNER}</span>
          {world && <span className="chat-banner-world">Answers from {worldPhrase(world, !!bundle?.sample)}</span>}
          {selectedReplay && <ReplayBadge className="chat-banner-replay">{selectedReplay}</ReplayBadge>}
        </p>
      )}

      <div className="chat-thread" aria-label="Conversation">
        {loadError ? (
          <LoadFailureState failure={loadError} mode={mode} onRetry={retry} onNew={newChat} />
        ) : opening ? (
          <ThreadSkeleton />
        ) : empty ? (
          <section className="chat-empty" aria-labelledby={`${inputId}-welcome`}>
            <h2 id={`${inputId}-welcome`} className="chat-empty-title">
              What should Notary check?
            </h2>
            <p className="chat-empty-lead">Ask about its runs, certificates or the APIs it checks. Every answer cites the records it read.</p>
            {suggestions.length > 0 && (
              <ul className="chat-suggestions" aria-label="Suggested questions">
                {suggestions.map((s) => (
                  <li key={s.prompt}>
                    <button type="button" disabled={needsToken} onClick={() => void send(s.prompt)}>
                      <span className="chat-suggestion-text">
                        <span className="chat-suggestion-title">{s.prompt}</span>
                        {s.detail && <span className="chat-suggestion-detail">{s.detail}</span>}
                      </span>
                      <CaretRight className="chat-suggestion-go" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
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
              window.scrollTo({ top: document.documentElement.scrollHeight, behavior: reducedMotion() ? "auto" : "smooth" });
            }}
          >
            <ArrowDown />
            Jump to latest
          </button>
        )}
        {needsToken ? (
          <TokenForm onToken={setToken} />
        ) : (
          <form className="chat-composer" onSubmit={onSubmit} data-busy={busy || undefined}>
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
              enterKeyHint="send"
              aria-describedby={[inputError ? errorId : undefined, hintId].filter(Boolean).join(" ")}
              aria-invalid={inputError ? true : undefined}
              onChange={(e) => {
                setDraft(e.target.value);
                if (inputError) setInputError(undefined);
              }}
              onKeyDown={onKeyDown}
            />
            {busy ? (
              <button type="button" className="chat-send" data-kind="stop" onClick={stop} aria-label="Stop">
                <StopSquare />
              </button>
            ) : (
              <button type="submit" className="chat-send" disabled={!draft.trim()} aria-label="Send">
                <ArrowUp />
              </button>
            )}
          </form>
        )}
        {inputError && (
          <p id={errorId} className="chat-input-error" role="alert">
            {inputError}
          </p>
        )}
        <p className="chat-hint" id={hintId}>
          {CAPABILITY_HINT}
          <span className="chat-hint-keys"> Enter sends, Shift+Enter adds a line.</span>
        </p>
      </div>
    </div>
  );
}

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/* -------------------------------------------------------------------- loading and errors */

/** Skeleton in the shape of a conversation (question bubble, badge, steps line, answer lines). */
function ThreadSkeleton() {
  return (
    <div className="chat-skeleton" role="status" aria-live="polite">
      <span className="sr-only">Opening the chat…</span>
      <Skeleton shape="block" className="chat-skel-bubble" />
      <Skeleton shape="line" className="chat-skel-badge" />
      <Skeleton shape="line" width="40%" />
      <Skeleton shape="line" />
      <Skeleton shape="line" />
      <Skeleton shape="line" width="62%" />
    </div>
  );
}

const FAILURE: Record<LoadFailure, { title: string; live: string; replay: string }> = {
  list: {
    title: "Recent chats did not load",
    live: "Check that `notary serve` is still running, then try again. New questions still work.",
    replay: "Replay keeps chats in this tab only. Try again, or start a new chat.",
  },
  open: {
    title: "This chat could not be opened",
    live: "It may have been deleted, or `notary serve` stopped. Try again, or start a new chat.",
    replay: "Replay chats last only as long as this tab. Start a new chat to ask again.",
  },
  delete: {
    title: "The chat was not deleted",
    live: "Check that `notary serve` is still running, then delete it again from Recent chats.",
    replay: "Reload the page, then delete it again from Recent chats.",
  },
};

function LoadFailureState({ failure, mode, onRetry, onNew }: { failure: LoadFailure; mode: "live" | "replay"; onRetry: () => void; onNew: () => void }) {
  const f = FAILURE[failure];
  return (
    <EmptyState
      tone="error"
      className="chat-failure"
      title={f.title}
      action={
        <>
          {failure !== "delete" && (
            <Button variant="secondary" size="sm" onClick={onRetry}>
              Try again
            </Button>
          )}
          <Button variant="primary" size="sm" onClick={onNew}>
            New chat
          </Button>
        </>
      }
    >
      <p>
        <CodeText text={mode === "live" ? f.live : f.replay} />
      </p>
    </EmptyState>
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
      <p className="chat-token-help">
        <CodeText text="Paste the token `notary serve` printed at startup. It stays in this tab only." />
      </p>
      <div className="chat-token-row">
        <input id={id} name="session-token" type="password" autoComplete="off" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} />
        <Button type="submit" variant="accent" size="sm" disabled={!value.trim()}>
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
  const menu = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  // The menu is portaled to <body> (the page header may clip its overflow) and placed under the button.
  const [place, setPlace] = useState<{ top: number; left?: number; right?: number }>();
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const r = button.current?.getBoundingClientRect();
      if (!r) return;
      const narrow = window.innerWidth < 640;
      setPlace(narrow ? { top: r.bottom + 6, left: Math.max(16, r.left) } : { top: r.bottom + 6, right: Math.max(16, window.innerWidth - r.right) });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, { passive: true });
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update);
    };
  }, [open]);
  useEffect(() => {
    if (!open) {
      setConfirm(undefined);
      return;
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!root.current?.contains(t) && !menu.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    // Keyboard: the portaled menu takes focus when it opens; tabbing out of it closes it.
    const onFocusOut = (e: FocusEvent) => {
      const next = e.relatedTarget as Node | null;
      if (next && !menu.current?.contains(next) && !root.current?.contains(next)) setOpen(false);
    };
    const el = menu.current;
    el?.addEventListener("focusout", onFocusOut);
    const raf = requestAnimationFrame(() => menu.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true }));
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      el?.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="chat-recent" ref={root}>
      <Button
        ref={button}
        variant="secondary"
        size="sm"
        className="chat-recent-button"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((v) => !v)}
      >
        Recent chats
        {conversations.length > 0 && <span className="chat-recent-count tabular">{conversations.length}</span>}
        <CaretDown className="chat-recent-caret" />
      </Button>
      {open &&
        createPortal(
        <div
          id={menuId}
          ref={menu}
          className="chat-recent-menu"
          role="region"
          aria-label="Recent chats"
          style={place ? { top: place.top, left: place.left, right: place.right } : { visibility: "hidden" }}
        >
          {conversations.length === 0 ? (
            <p className="chat-recent-empty">No chats yet. Ask a question to start one.</p>
          ) : (
            <ul>
              {conversations.map((c) => (
                <li key={c.id} aria-current={c.id === current || undefined} data-confirm={confirm === c.id || undefined}>
                  {confirm === c.id ? (
                    <div className="chat-recent-confirm">
                      <span className="chat-recent-confirm-text">Delete “{c.title}”?</span>
                      <span className="chat-recent-confirm-actions">
                        <button type="button" className="chat-text-button" onClick={() => setConfirm(undefined)}>
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="chat-text-button chat-danger"
                          onClick={() => {
                            setConfirm(undefined);
                            onDelete(c.id);
                          }}
                        >
                          Delete
                        </button>
                      </span>
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
                        <span className="chat-recent-date">{date(c.updatedAt)}</span>
                      </button>
                      <button type="button" className="chat-recent-delete" aria-label={`Delete chat “${c.title}”`} onClick={() => setConfirm(c.id)}>
                        <Trash />
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>,
          document.body,
        )}
    </div>
  );
}
