// Adapted from UIAble block-bento-5. MIT (c) 2026 CodedThemes; see docs/CREDITS.md.
import { Card } from "../ui/card";
export function ProblemBento() {
  const problems = [
    {
      title: "Undocumented units",
      copy: "The docs say amount. The wire expects minor units. A valid request can still move the wrong amount.",
      left: "Docs: amount",
      right: "Wire: minor units",
    },
    {
      title: "Retries that duplicate writes",
      copy: "A timeout does not mean a write failed. Retrying can refund the same customer again.",
      left: "Timeout",
      right: "Write may have succeeded",
    },
    {
      title: "Silently capped pagination",
      copy: "A successful list response can stop before the full result set. Missing records can quietly change a decision.",
      left: "Successful page",
      right: "Complete set still unproven",
    },
  ];
  return (
    <section id="problem" className="landing-section">
      <div className="chapter-heading">
        <span className="eyebrow">The problem</span>
        <h2>
          The call worked.
          <br />
          The assumption didn't.
        </h2>
        <p>
          Agents read the documentation. Money follows the behavior on the wire.
        </p>
      </div>
      <div className="problem-bento">
        {problems.map((p, i) => (
          <Card className={`problem-tile problem-${i}`} key={p.title}>
            <span className="tile-kicker">A gap between docs and behavior</span>
            <h3>{p.title}</h3>
            <p>{p.copy}</p>
            <div className="contract-fragment">
              <code>{p.left}</code>
              <span aria-hidden="true">→</span>
              <code>{p.right}</code>
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}
