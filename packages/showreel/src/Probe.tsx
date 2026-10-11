// Review aid: the dashboard pages at camera scale 1 (not part of the film).
import { MemoryRouter } from "react-router";
import { AbsoluteFill } from "remotion";
import "./web";
import "./fonts";
import type { ShowreelData } from "./data-schema";
import { ChatView, Dashboard, HeldCard, RunView, Stat } from "./v2/Dashboard";

export function Probe(data: ShowreelData) {
  const g = data.dashboard.guarded;
  return (
    <MemoryRouter>
      <AbsoluteFill style={{ background: "#dfe6f2", display: "flex", gap: 20, padding: 20, transform: "scale(0.6)", transformOrigin: "0 0", width: 3200 }}>
        <Dashboard active="run" address="127.0.0.1:5173/app/run">
          <RunView
            run={g}
            title="Run"
            summary="The agent with Notary · 20 requests"
            rows={12}
            scroll={0}
            stats={
              <>
                <Stat label="Unsafe actions" value={0} note="Measured on Notary's evaluation suite" />
                <Stat label="Held for a person" value={g.held} />
                <Stat label="Credits spent" value={22} of="of 200" />
              </>
            }
            under={{ [data.dashboard.held.rowKey]: <HeldCard held={data.dashboard.held} /> }}
          />
        </Dashboard>
        <Dashboard active="chat" address="127.0.0.1:5173/app/chat">
          <ChatView question={data.chat.question} typed={99} sent events={data.chat.events} caret={false} />
        </Dashboard>
      </AbsoluteFill>
    </MemoryRouter>
  );
}
