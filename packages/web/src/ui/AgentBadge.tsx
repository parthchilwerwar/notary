import { AGENTS, agentKindLabel, type AgentId } from "../../../core/src/schema/agents";
import { cn } from "../lib/utils";

/**
 * Who acted: one of the five names from core/src/schema/agents.ts (Executor, Reflector, Adversary,
 * Notary Chat, Guard). A hairline pill, no avatar or icon. `model` is the model id from data
 * (never hardcoded); rules (Guard) never show one and are announced as a rule, not an agent —
 * `showKind` prints that as a visible "· rule" (the landing's badges).
 */
export function AgentBadge({
  agent,
  model,
  showKind = false,
  className,
}: {
  agent: AgentId;
  model?: string | null;
  showKind?: boolean;
  className?: string;
}) {
  const a = AGENTS[agent];
  const kind = agentKindLabel(agent);
  return (
    <span className={cn("ui-agent", className)} data-agent={agent} data-kind={kind} title={a.role}>
      {a.name}
      {kind === "rule" && (showKind ? <span className="ui-agent-kind"> · rule</span> : <span className="sr-only"> (rule)</span>)}
      {model && kind === "agent" && <span className="ui-agent-model">{model}</span>}
    </span>
  );
}
