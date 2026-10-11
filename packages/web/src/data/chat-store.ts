// Replay chat conversations: kept in sessionStorage for this tab (never localStorage — the hosted
// site is read-only and nothing outlives the tab), with an in-memory copy that is the fallback
// when storage is blocked. Everything read back is schema-checked; anything invalid is dropped.
import { z } from "zod";
import { ChatConversationSchema, ChatMessageSchema } from "../../../core/src/schema";
import type { ChatConversation, ChatMessage } from "../../../core/src/schema";

export type StoredConversation = {
  conversation: ChatConversation;
  /** The run selected when the conversation started: its world is the only world it answers from. */
  runId?: string;
  messages: ChatMessage[];
};

const StoredSchema = z.array(
  z.object({
    conversation: ChatConversationSchema,
    runId: z.string().optional(),
    messages: z.array(ChatMessageSchema),
  }),
);

export interface ChatStore {
  load(): StoredConversation[];
  save(list: StoredConversation[]): void;
}

export const REPLAY_CHAT_STORAGE_KEY = "notary.chat.replay";

/** In-memory only (tests, blocked storage). */
export function memoryChatStore(initial: StoredConversation[] = []): ChatStore {
  let list = structuredClone(initial);
  return {
    load: () => structuredClone(list),
    save: (next) => {
      list = structuredClone(next);
    },
  };
}

/** sessionStorage (this tab only), falling back to memory when storage throws or is absent. */
export function sessionChatStore(key = REPLAY_CHAT_STORAGE_KEY, storage?: Pick<Storage, "getItem" | "setItem">): ChatStore {
  const memory = memoryChatStore();
  const store = (): Pick<Storage, "getItem" | "setItem"> | undefined => {
    try {
      return storage ?? globalThis.sessionStorage;
    } catch {
      return undefined;
    }
  };
  let loaded = false;
  return {
    load() {
      if (!loaded) {
        loaded = true;
        try {
          const raw = store()?.getItem(key);
          if (raw) {
            const parsed = StoredSchema.safeParse(JSON.parse(raw));
            if (parsed.success) memory.save(parsed.data);
          }
        } catch {
          // Unreadable or blocked: start empty.
        }
      }
      return memory.load();
    },
    save(list) {
      memory.save(list);
      loaded = true;
      try {
        store()?.setItem(key, JSON.stringify(list));
      } catch {
        // Storage blocked or full: the in-memory copy lasts for this page view.
      }
    },
  };
}
