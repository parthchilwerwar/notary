import { AGENTS, agentKindLabel, type AgentId } from "../../../../core/src/schema";

/**
 * Agent name badge (small text pill, no icon). Names come from the single source of truth in
 * core/src/schema/agents.ts. Rules (Guard) say "rule", never "agent". Local to the landing until
 * a shared badge exists in components/ui.
 */
export function AgentBadge({ id }: { id: AgentId }) {
  const kind = agentKindLabel(id);
  return (
    <span className="agent-badge" data-kind={kind} title={AGENTS[id].role}>
      {AGENTS[id].name}
      {kind === "rule" && <span className="agent-badge-kind"> · rule</span>}
    </span>
  );
}
