// Notary Chat persistence: conversations and messages in SQLite (node:sqlite DatabaseSync, like
// src/store/db.ts but a separate file: `notary serve` uses runs/chat.sqlite, gitignored; tests pass
// ":memory:"). Assistant messages keep their full ChatEvent list (JSON) so a reload re-renders the
// steps, notes and citations exactly as streamed. Every row read back is re-validated with the
// shared zod contract (src/schema/chat.ts); a row that no longer parses is skipped, never patched.
//
// Deliberately NOT under src/store/: this file holds chat transcripts only and imports nothing that
// can act (test/chat-safety.test.ts checks the chat module's import graph).
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ChatConversationSchema, ChatEventSchema, ChatMessageSchema } from "../schema/chat.js";
import type { ChatConversation, ChatEvent, ChatMessage } from "../schema/chat.js";

/** Title of a conversation before its first message. */
export const NEW_CONVERSATION_TITLE = "New conversation";
/** Longest title (the first user message, truncated on a word boundary when possible). */
export const CHAT_TITLE_CHARS = 60;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS chat_conversations (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_messages (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content         TEXT NOT NULL,
  events_json     TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_messages_by_conversation ON chat_messages (conversation_id, seq);
`;

/** The first user message as a title: whitespace collapsed, cut at CHAT_TITLE_CHARS (word boundary when one is near). */
export function titleFrom(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  if (flat.length <= CHAT_TITLE_CHARS) return flat || NEW_CONVERSATION_TITLE;
  const cut = flat.slice(0, CHAT_TITLE_CHARS - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space >= CHAT_TITLE_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

type ConversationRow = { id: string; title: string; created_at: string; updated_at: string };
type MessageRow = { id: string; conversation_id: string; role: string; content: string; events_json: string | null; created_at: string };

export class ChatStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;
  private last = 0;

  constructor(path: string, opts: { now?: () => Date } = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA_SQL);
    this.now = opts.now ?? (() => new Date());
  }

  /** Strictly increasing ISO timestamps (newest-first ordering stays stable within one millisecond). */
  private stamp(): string {
    const t = Math.max(this.now().getTime(), this.last + 1);
    this.last = t;
    return new Date(t).toISOString();
  }

  private conversationOf(row: ConversationRow): ChatConversation | null {
    const parsed = ChatConversationSchema.safeParse({ id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at });
    return parsed.success ? parsed.data : null;
  }

  createConversation(): ChatConversation {
    const at = this.stamp();
    const conv: ChatConversation = { id: `conv-${randomUUID()}`, title: NEW_CONVERSATION_TITLE, createdAt: at, updatedAt: at };
    this.db.prepare("INSERT INTO chat_conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(conv.id, conv.title, conv.createdAt, conv.updatedAt);
    return conv;
  }

  /** Newest first (last activity, then creation). */
  listConversations(): ChatConversation[] {
    const rows = this.db.prepare("SELECT id, title, created_at, updated_at FROM chat_conversations ORDER BY updated_at DESC, created_at DESC, id DESC").all() as ConversationRow[];
    return rows.map((r) => this.conversationOf(r)).filter((c): c is ChatConversation => c !== null);
  }

  getConversation(id: string): ChatConversation | null {
    const row = this.db.prepare("SELECT id, title, created_at, updated_at FROM chat_conversations WHERE id = ?").get(id) as ConversationRow | undefined;
    return row ? this.conversationOf(row) : null;
  }

  /** Messages oldest first. */
  messages(conversationId: string): ChatMessage[] {
    const rows = this.db
      .prepare("SELECT id, conversation_id, role, content, events_json, created_at FROM chat_messages WHERE conversation_id = ? ORDER BY seq ASC")
      .all(conversationId) as MessageRow[];
    const out: ChatMessage[] = [];
    for (const r of rows) {
      let events: unknown;
      if (r.events_json !== null) {
        try {
          events = JSON.parse(r.events_json);
        } catch {
          continue;
        }
      }
      const parsed = ChatMessageSchema.safeParse({
        id: r.id,
        conversationId: r.conversation_id,
        role: r.role,
        content: r.content,
        ...(events === undefined ? {} : { events }),
        createdAt: r.created_at,
      });
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  }

  /** true when it existed (its messages go with it). */
  deleteConversation(id: string): boolean {
    this.db.prepare("DELETE FROM chat_messages WHERE conversation_id = ?").run(id);
    const res = this.db.prepare("DELETE FROM chat_conversations WHERE id = ?").run(id);
    return Number(res.changes) > 0;
  }

  /** Append a user message; the first one becomes the conversation's title. */
  addUserMessage(conversationId: string, content: string): ChatMessage {
    const at = this.stamp();
    const msg = ChatMessageSchema.parse({ id: `msg-${randomUUID()}`, conversationId, role: "user", content, createdAt: at });
    const first = (this.db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE conversation_id = ? AND role = 'user'").get(conversationId) as { n: number }).n === 0;
    this.db.prepare("INSERT INTO chat_messages (id, conversation_id, role, content, events_json, created_at) VALUES (?, ?, 'user', ?, NULL, ?)").run(msg.id, conversationId, content, at);
    if (first) this.db.prepare("UPDATE chat_conversations SET title = ?, updated_at = ? WHERE id = ?").run(titleFrom(content), at, conversationId);
    else this.db.prepare("UPDATE chat_conversations SET updated_at = ? WHERE id = ?").run(at, conversationId);
    return msg;
  }

  /** Append an assistant message with its full event list (validated before it is written). */
  addAssistantMessage(conversationId: string, content: string, events: readonly ChatEvent[]): ChatMessage {
    const at = this.stamp();
    const checked = events.map((e) => ChatEventSchema.parse(e));
    const msg = ChatMessageSchema.parse({ id: `msg-${randomUUID()}`, conversationId, role: "assistant", content, events: checked, createdAt: at });
    this.db
      .prepare("INSERT INTO chat_messages (id, conversation_id, role, content, events_json, created_at) VALUES (?, ?, 'assistant', ?, ?, ?)")
      .run(msg.id, conversationId, content, JSON.stringify(checked), at);
    this.db.prepare("UPDATE chat_conversations SET updated_at = ? WHERE id = ?").run(at, conversationId);
    return msg;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }
}
