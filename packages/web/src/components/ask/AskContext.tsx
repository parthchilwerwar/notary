// Ask Notary panel state for the whole app shell: open/closed, the answer selected in the panel,
// and the Ctrl+J / Cmd+J shortcut (next to Ctrl+K for the command palette).
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type AskState = {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  /** Precomputed answer selected in the panel (the full page keeps its own in ?answer=). */
  selectedId?: string;
  setSelectedId: (id: string | undefined) => void;
};

const AskContext = createContext<AskState | null>(null);

export function useAsk(): AskState {
  const ctx = useContext(AskContext);
  if (!ctx) throw new Error("useAsk must be used within an AskProvider.");
  return ctx;
}

export const ASK_SHORTCUT_LABEL = "Ctrl J";
export const ASK_KEYSHORTCUTS = "Control+J Meta+J";

export function isAskShortcut(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): boolean {
  return e.key.toLowerCase() === "j" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
}

export function AskProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const toggle = useCallback(() => setOpen((v) => !v), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isAskShortcut(e)) {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);
  const value = useMemo(
    () => ({ open, setOpen, toggle, selectedId, setSelectedId }),
    [open, toggle, selectedId],
  );
  return <AskContext.Provider value={value}>{children}</AskContext.Provider>;
}
