// Everything below the hero (lazy: the first paint only needs the nav and the hero). Every number
// comes from hash-verified data through the data layer; see landing-data.ts.
import { useCallback, useEffect, useRef, useState } from "react";
import { finishedEntries, type DataSource } from "../../data";
import { proofNumbers, proofPair, type PricingPlan } from "../../landing-data";
import { GridFrame } from "../brand/GridFrame";
import { BuiltWith } from "./BuiltWith";
import { ChatSection } from "./ChatSection";
import { ClosingCta } from "./ClosingCta";
import { Features } from "./Features";
import { Footer } from "./Footer";
import { HowItWorks } from "./HowItWorks";
import { Pricing } from "./Pricing";
import { Proof, type ProofState } from "./Proof";
import { ScrollTrigger } from "./gsap";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function Below({ source, ready, plans }: { source: DataSource; ready: boolean; plans: PricingPlan[] | null }) {
  const [proof, setProof] = useState<ProofState>({ status: "loading" });

  // Lazy sections change the page height after load; keep every scroll trigger's position true.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let timer = 0;
    let last = el.offsetHeight;
    const ro = new ResizeObserver(() => {
      if (el.offsetHeight === last) return;
      last = el.offsetHeight;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => ScrollTrigger.refresh(), 200);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      window.clearTimeout(timer);
    };
  }, []);

  const [proofWanted, setProofWanted] = useState(false);
  const wantProof = useCallback(() => setProofWanted(true), []);
  useEffect(() => {
    if (!ready || !proofWanted) return;
    const controller = new AbortController();
    const { signal } = controller;
    (async () => {
      const all = finishedEntries(await source.listRuns(signal));
      const pair = proofPair(all);
      if (!pair.naive || !pair.guarded) {
        if (!signal.aborted)
          setProof({
            status: "empty",
            message:
              "No naive and guarded run pair from one scenario has been exported yet, so there is nothing to compare.",
          });
        return;
      }
      // Hash-verified by the data layer; a mismatch throws and the error is shown instead.
      // One after the other so each bundle's hash check is its own main-thread task.
      const naive = await source.getRun(pair.naive.runId, signal);
      const guardedRun = await source.getRun(pair.guarded.runId, signal);
      if (signal.aborted) return;
      setProof({ status: "ready", naive, guarded: guardedRun, numbers: proofNumbers(naive, guardedRun), note: pair.note });
    })().catch((e) => {
      if (!signal.aborted) setProof({ status: "error", message: message(e) });
    });
    return () => controller.abort();
  }, [source, ready, proofWanted]);

  return (
    <div ref={root}>
      <BuiltWith />
      <GridFrame className="l-frame-sections">
        <HowItWorks source={source} />
        <Features source={source} />
        <Proof state={proof} onNear={wantProof} />
        <ChatSection source={source} />
        {plans && <Pricing plans={plans} />}
      </GridFrame>
      <ClosingCta />
      <Footer />
    </div>
  );
}
