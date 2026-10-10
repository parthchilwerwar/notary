// Adapted from UIAble block-process-1. MIT (c) 2026 CodedThemes; see docs/CREDITS.md.
export function ProcessSteps() {
  const steps = [
    {
      name: "Checker",
      tag: "Docs vs wire",
      copy: "Extract claims from documentation and compare them with observed tool behavior.",
    },
    {
      name: "Probes",
      tag: "Predict before calling",
      copy: "Commit rival predictions before the API call, then inspect the observation and control.",
    },
    {
      name: "Adversary",
      tag: "Try to refute",
      copy: "A stronger model challenges the evidence. Unproven claims stay unproven.",
    },
    {
      name: "Guards",
      tag: "Gate every money call",
      copy: "Compile proven beliefs into guards. Hold actions when required beliefs are missing.",
    },
    {
      name: "Queue run",
      tag: "Refunds and plans",
      copy: "Process customer requests with guards, recorded decisions and trace receipts.",
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
