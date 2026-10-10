// Adapted from UIAble block-cta-1. MIT (c) 2026 CodedThemes; see docs/CREDITS.md.
import { Link } from "react-router";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { DitherGradient } from "../dither-kit/gradient";
export function FinalCTA() {
  return (
    <section className="landing-section">
      <Card className="landing-cta">
        <DitherGradient
          from="blue"
          direction="right"
          opacity={0.4}
          cell={2}
          bloom="off"
        />
        <span className="eyebrow">Inspect the evidence</span>
        <h2>
          Before the next money call,
          <br />
          inspect the certificate.
        </h2>
        <p>
          Explore API behavior certificates, challenged evidence and enforced
          decisions.
        </p>
        <div className="landing-actions">
          <Button size="lg" asChild>
            <Link to="/app">Open the dashboard</Link>
          </Button>
          <Button size="lg" variant="outline" asChild>
            <a
              href="https://github.com/parthchilwerwar/notary"
              target="_blank"
              rel="noreferrer"
            >
              View on GitHub
            </a>
          </Button>
        </div>
      </Card>
    </section>
  );
}
