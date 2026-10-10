// Adapted from UIAble block-hero-3. MIT (c) 2026 CodedThemes; see docs/CREDITS.md.
import { Link } from "react-router";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
export function Hero() {
  return (
    <section className="landing-hero" aria-labelledby="hero-title">
      <div className="hero-copy">
        <span className="eyebrow">Notary / evidence before action</span>
        <h1 id="hero-title">
          Notary issues certificates for API behavior. No certificate, no money
          moves.
        </h1>
        <p className="hero-subline">
          My agent refunded a customer twice, and every API call returned 200.
        </p>
        <div className="landing-actions">
          <Button size="lg" asChild>
            <Link to="/app">Open the dashboard</Link>
          </Button>
          <Button variant="outline" size="lg" asChild>
            <a
              href="https://github.com/parthchilwerwar/notary"
              target="_blank"
              rel="noreferrer"
            >
              View on GitHub
            </a>
          </Button>
        </div>
      </div>
      <Card className="hero-proof">
        <div className="proof-top">
          <span>From a claim to a certificate</span>
          <span className="proof-dot" />
        </div>
        <div className="proof-flow">
          {[
            { title: "Documentation", note: "What the tool promises" },
            {
              title: "Committed predictions",
              note: "What each hypothesis expects",
            },
            { title: "Wire evidence", note: "What the call actually returned" },
            {
              title: "Behavior certificate",
              note: "Scoped, challenged and revocable",
            },
            {
              title: "Guarded action",
              note: "No certificate, no money moves",
            },
          ].map((step, i) => (
            <div
              className={i === 4 ? "proof-node gate" : "proof-node"}
              key={step.title}
            >
              <span className="proof-marker" aria-hidden="true" />
              <div>
                <h2>{step.title}</h2>
                <p>{step.note}</p>
              </div>
            </div>
          ))}
        </div>
        <p className="proof-caption">
          A successful response is an observation.
          <br />
          It is not permission to move money.
        </p>
      </Card>
    </section>
  );
}
