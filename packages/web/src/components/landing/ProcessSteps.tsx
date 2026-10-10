// Read → Test → Challenge → Certify → Enforce, each mapped to what Notary's code does
// (README "How it works", DECISIONS #107). Copy only: no measured numbers here.
export function ProcessSteps() {
  const steps = [
    {
      name: "Read",
      tag: "Docs become claims",
      copy: "Every concrete promise in the Crustdata and Dodo docs becomes a machine-checkable claim. Recon calls are compared with each claim by a deterministic checker.",
      where: "packages/core/src/contracts",
    },
    {
      name: "Test",
      tag: "Predict, then call",
      copy: "Rival explanations per anomaly. Each probe's prediction is hashed and stored before the HTTP call; fixed verdict rules update a Beta belief per claim.",
      where: "notary notarize --tool dodo",
    },
    {
      name: "Challenge",
      tag: "Try to refute",
      copy: "A different, stronger model reads only the raw probe records and tries to refute each belief: uphold, narrow or downgrade. Cited probes are checked against their spans.",
      where: "adversary + evidence check",
    },
    {
      name: "Certify",
      tag: "Scoped, sealed, revocable",
      copy: "Surviving beliefs become sha256-sealed certificates that match or contradict the docs. Later contrary evidence revokes them.",
      where: "notary export --certificates",
    },
    {
      name: "Enforce",
      tag: "No certificate, no money moves",
      copy: "Contradicting certificates compile into guards. A refund or plan change runs only if every certificate it depends on is active; otherwise it is held with an evidence pack.",
      where: "notary run --queue …",
    },
  ];
  return (
    <section
      id="how-it-works"
      className="landing-section"
      aria-labelledby="how-title"
    >
      <div className="chapter-heading">
        <span className="eyebrow">How it works</span>
        <h2 id="how-title">Read → Test → Challenge → Certify → Enforce</h2>
        <p>
          Deterministic code makes every decision. Models only propose
          hypotheses and review beliefs.
        </p>
      </div>
      <ol className="process-steps">
        {steps.map((step, i) => (
          <li key={step.name}>
            <span className="step-number" aria-hidden="true">
              {i + 1}
            </span>
            <span className="step-tag">{step.tag}</span>
            <h3>{step.name}</h3>
            <p>{step.copy}</p>
            <code className="step-where">{step.where}</code>
          </li>
        ))}
      </ol>
    </section>
  );
}
