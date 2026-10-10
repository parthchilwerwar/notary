// Adapted from UIAble block-cta-1. MIT (c) 2026 CodedThemes; see docs/CREDITS.md.
import { Link } from "react-router";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
export function FinalCTA() {
  return (
    <section className="landing-section">
      <Card className="landing-cta">
        <span className="eyebrow">Inspect the evidence</span>
        <h2>
          Before the next money call,
          <br />
          ask what the agent has proven.
        </h2>
        <p>
          Explore the decisions, committed predictions and guards in the
          dashboard.
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
