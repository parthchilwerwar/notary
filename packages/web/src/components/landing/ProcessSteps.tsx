// Adapted from UIAble block-process-1. MIT (c) 2026 CodedThemes; see docs/CREDITS.md.
export function ProcessSteps() {
  const steps = [
    {
      name: "Read",
      tag: "Docs vs wire",
      copy: "Extract claims from documentation and compare them with observed tool behavior.",
    },
    {
      name: "Test",
      tag: "Predict before calling",
      copy: "Commit rival predictions before the API call, then inspect the observation and control.",
    },
    {
      name: "Challenge",
      tag: "Try to refute",
      copy: "A stronger model challenges the evidence. Unproven claims stay unproven.",
    },
    {
      name: "Certify",
      tag: "Issue a scoped certificate",
      copy: "Certify proven API behavior with scope, an adversary verdict and evidence receipts. A certificate can contradict the docs.",
    },
    {
      name: "Enforce",
      tag: "No certificate, no money moves",
      copy: "Gate refunds and plan changes on active certificates. Revoke a certificate when behavior changes, then hold the money call.",
    },
  ];
  return (
    <section id="how-it-works" className="landing-section">
      <div className="chapter-heading">
        <span className="eyebrow">How it works</span>
        <h2>Proof comes before permission.</h2>
        <p>
          Follow the claim through the experiment, the challenge and the money
          call.
        </p>
      </div>
      <ol className="process-steps">
        {steps.map((step, i) => (
          <li key={step.name}>
            <span className="step-number" aria-label={`Step ${i + 1}`}>
              {i + 1}
            </span>
            <span className="step-tag">{step.tag}</span>
            <h3>{step.name}</h3>
            <p>{step.copy}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
