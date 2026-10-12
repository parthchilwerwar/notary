// Reasoning Steps (src/components/ui/reasoning-steps.tsx): static renders. Stages and sources come
// only from props, the settled summary counts the stages, a pending stage never shows, and reduced
// motion shows everything without pacing.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { MotionConfig } from "motion/react";
import { describe, expect, it } from "vitest";
import { ReasoningSteps, type ReasoningStepsProps } from "../src/ui/reasoning-steps";

const render = (props: ReasoningStepsProps, reduced = false) => {
  const el = createElement(ReasoningSteps, props);
  return renderToStaticMarkup(createElement(MemoryRouter, null, reduced ? createElement(MotionConfig, { reducedMotion: "always" }, el) : el));
};

const STAGES = [
  { id: "a", label: "Searching certificates", status: "done" as const },
  { id: "b", label: "Opening run demo-run-guarded", status: "done" as const },
  { id: "c", label: "Reading run events", status: "done" as const },
];
const SOURCES = [
  { id: "cert", label: "dodo.refund.amount-minor-units", href: "/app/certificates/cert-1", stage: "a" },
  { id: "doc", label: "Refunds API", href: "https://docs.example.com/refunds", external: true, stage: 2 },
];
const REASONING = [{ text: "Checking the certificate first.", tag: "Replay engine", stage: "a" }, "Unattached closing thought."];

const count = (html: string, slot: string) => html.split(`data-slot="${slot}"`).length - 1;

describe("ReasoningSteps", () => {
  it("renders exactly the stages and sources it is given, with links", () => {
    const html = render({ stages: STAGES, sources: SOURCES, reasoning: REASONING, live: true, open: true });
    expect(count(html, "reasoning-steps-stage")).toBe(3);
    for (const s of STAGES) expect(html).toContain(s.label);
    expect(count(html, "reasoning-steps-source")).toBe(2);
    expect(html).toContain('href="/app/certificates/cert-1"');
    expect(html).toContain('href="https://docs.example.com/refunds" target="_blank" rel="noreferrer noopener"');
    expect(html).toContain("Checking the certificate first.");
    expect(html).toContain("Unattached closing thought.");
    expect(html).toContain('aria-expanded="true"');
    // Plain strings work as stages too.
    expect(count(render({ stages: ["One", "Two"], live: true, open: true }), "reasoning-steps-stage")).toBe(2);
  });

  it("settles into a summary whose count is the number of stages, closed by default", () => {
    const html = render({ stages: STAGES, sources: SOURCES, live: true, meta: "1.2s · no model call" });
    expect(html).toContain(`Reasoned in ${STAGES.length} steps`);
    expect(html).toContain("1.2s · no model call");
    expect(html).toContain('data-state="settled"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-slot="reasoning-steps-list"');
    expect(render({ stages: ["Only"], live: true })).toContain("Reasoned in 1 step<");
  });

  it("while running: the header is the latest stage with a live region; it never settles", () => {
    const html = render({ stages: [STAGES[0]!, { label: "Reading run events", status: "active" }], reasoning: [{ text: "Looking for the hold.", stage: 1 }], live: true, running: true });
    expect(html).toContain('data-state="running"');
    expect(html).toContain('role="status" aria-live="polite"');
    expect(html).toContain("In progress: Reading run events");
    expect(html).toContain("Looking for the hold."); // the current stage's reasoning, in the strip
    expect(html).not.toContain("Reasoned in");
  });

  it("never shows a pending stage or anything after it", () => {
    const html = render({ stages: [STAGES[0]!, { label: "Not yet", status: "pending" }, STAGES[2]!], live: true, open: true });
    expect(html).toContain(STAGES[0]!.label);
    expect(html).not.toContain("Not yet");
    expect(html).not.toContain(STAGES[2]!.label);
  });

  it("paced: shows nothing before its first tick; reduced motion shows every stage, line and source at once", () => {
    const paced = render({ stages: STAGES, sources: SOURCES, reasoning: REASONING, open: true, running: true });
    expect(count(paced, "reasoning-steps-stage")).toBe(0);
    expect(paced).toContain("Working…");
    const reduced = render({ stages: STAGES, sources: SOURCES, reasoning: REASONING, open: true }, true);
    expect(reduced).toContain("data-reduced");
    expect(count(reduced, "reasoning-steps-stage")).toBe(3);
    expect(count(reduced, "reasoning-steps-source")).toBe(2);
    expect(count(reduced, "reasoning-steps-reasoning-line")).toBe(2);
    // Reduced motion and not running → already settled.
    expect(render({ stages: STAGES }, true)).toContain("Reasoned in 3 steps");
  });
});
