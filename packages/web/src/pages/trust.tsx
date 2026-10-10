// Trust group: Certificates (+ detail), API reports (+ per tool), Beliefs (+ detail), revocation demo.
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { PlayIcon as Play } from "@phosphor-icons/react/dist/csr/Play";
import { Beliefs, BeliefCard } from "../Beliefs";
import {
  CertificateDetail,
  CertificatesView,
  ReportToolView,
  ReportsView,
  RevocationSteps,
} from "../Certificates";
import {
  Button,
  EmptyState,
  ErrorState,
  FixtureBanner,
  LoadingState,
  PageHeader,
} from "../components/ui";
import { useData } from "../state/DataProvider";
import {
  loadCertificateWorld,
  type CertificateWorld,
} from "../state/certificates";
import { readOptionalJSON } from "../optional-json";
import { FixtureIndexSchema } from "../../../core/src/schema";
import { RecordNotFound, RunLink, WithCertificates, useBundle, useRunPath } from "./shared";

export function CertificatesPage() {
  const { bundles, bundle, certificates } = useData();
  const revoked =
    certificates.status === "ready" && certificates.data.sample
      ? certificates.data.revocations.length
      : 0;
  return (
    <>
      <PageHeader
        title="Certificates"
        description="API behavior, certified within the scope it was probed. Revocable."
        actions={
          <>
            <Button variant="outline" asChild>
              <RunLink to="/app/beliefs">All beliefs</RunLink>
            </Button>
            {revoked > 0 && (
              <Button variant="outline" asChild>
                <RunLink to="/app/revocation-demo">Replay revocation</RunLink>
              </Button>
            )}
          </>
        }
      />
      <WithCertificates>
        {(world) => (
          <CertificatesView
            world={world}
            bundles={bundles}
            runId={bundle?.runId}
          />
        )}
      </WithCertificates>
    </>
  );
}

export function CertificateDetailPage() {
  const { certificateId = "" } = useParams();
  const { bundles, bundle } = useData();
  const path = useRunPath();
  return (
    <WithCertificates>
      {(world) => {
        const cert = world.certificates.find((c) => c.id === certificateId);
        if (!cert)
          return (
            <EmptyState
              title={`Certificate ${certificateId} is not in this data world`}
              actions={
                <Button asChild>
                  <Link to={path("/app/certificates")}>All certificates</Link>
                </Button>
              }
            >
              {world.sample
                ? `The fixture scenario "${world.scenario}" has no certificate with this id. Select a run from another scenario to look there.`
                : "The recorded certificate export has no certificate with this id."}
            </EmptyState>
          );
        return (
          <>
            <PageHeader
              eyebrow={`Certificate · ${cert.tool}`}
              title={cert.id}
              description={cert.claimId}
            />
            <CertificateDetail
              certificate={cert}
              world={world}
              bundles={bundles}
              runId={bundle?.runId}
            />
          </>
        );
      }}
    </WithCertificates>
  );
}

export function ReportsPage() {
  const { bundle } = useData();
  return (
    <>
      <PageHeader
        title="API reports"
        description="Each provider's documented promises, the evidence and the certificate coverage."
      />
      <WithCertificates>
        {(world) => <ReportsView world={world} runId={bundle?.runId} />}
      </WithCertificates>
    </>
  );
}

export function ReportDetailPage() {
  const { tool = "" } = useParams();
  const { bundles, bundle } = useData();
  return (
    <>
      <PageHeader
        eyebrow="API report"
        title={tool}
        description="Certificates, revocations and unproven claims for one provider."
      />
      <WithCertificates>
        {(world) => (
          <ReportToolView
            world={world}
            tool={tool}
            bundles={bundles}
            runId={bundle?.runId}
          />
        )}
      </WithCertificates>
    </>
  );
}

export function BeliefsPage() {
  const bundle = useBundle();
  return (
    <>
      <PageHeader
        title="Beliefs"
        description="Trust earned through evidence: P(documentation holds) per claim."
      />
      <Beliefs key={bundle.runId} bundle={bundle} />
    </>
  );
}

export function BeliefDetailPage() {
  const { beliefId = "" } = useParams();
  const bundle = useBundle();
  const belief =
    bundle.beliefs.after.find((b) => b.id === beliefId) ??
    bundle.beliefs.before.find((b) => b.id === beliefId);
  if (!belief)
    return (
      <RecordNotFound
        kind="Belief"
        id={beliefId}
        listPath="/app/beliefs"
        find={(b) =>
          [...b.beliefs.after, ...b.beliefs.before].some(
            (x) => x.id === beliefId,
          )
        }
      />
    );
  const snapshot = bundle.beliefs.after.includes(belief) ? "after" : "before";
  return (
    <>
      <PageHeader
        eyebrow={`Belief · ${belief.tool} · ${snapshot} the run`}
        title={belief.id}
        description={belief.claimId}
      />
      <div className="detail-single">
        <BeliefCard bundle={bundle} belief={belief} open />
      </div>
    </>
  );
}

/** Fixture-only: the scenario whose certificate export records a revocation. */
export function RevocationDemoPage() {
  const { bundles } = useData();
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; world: CertificateWorld }
    | { status: "missing" }
    | { status: "error"; error: string }
  >({ status: "loading" });
  const [replay, setReplay] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      const raw = await readOptionalJSON(
        "certificates/fixture/index.json",
        controller.signal,
      );
      if (raw === undefined) return setState({ status: "missing" });
      const index = FixtureIndexSchema.parse(raw);
      const scenario = index.scenarios.find((s) => s.overall.revoked > 0);
      if (!scenario) return setState({ status: "missing" });
      const world = await loadCertificateWorld(
        true,
        scenario.sourceBundles[0],
        controller.signal,
      );
      if (!controller.signal.aborted)
        setState(world ? { status: "ready", world } : { status: "missing" });
    })().catch((e: Error) => {
      if (!controller.signal.aborted)
        setState({ status: "error", error: e.message });
    });
    return () => controller.abort();
  }, []);
  return (
    <>
      <FixtureBanner variant="inline" />
      <PageHeader
        eyebrow="Fixture-only scenario"
        title="Revocation"
        description="A changed API loses its certificate, and money stops moving on it."
        actions={
          state.status === "ready" && (
            <Button onClick={() => setReplay((n) => n + 1)}>
              <Play aria-hidden="true" />
              Replay
            </Button>
          )
        }
      />
      {state.status === "loading" ? (
        <LoadingState title="Verifying fixture certificates…" />
      ) : state.status === "error" ? (
        <ErrorState title="Certificates withheld">{state.error}</ErrorState>
      ) : state.status === "missing" ? (
        <EmptyState title="No revocation recorded">
          No published fixture scenario records a revoked certificate.
        </EmptyState>
      ) : (
        <>
          <p className="world-note">
            {state.world.report.header}
          </p>
          <RevocationSteps
            key={replay}
            world={state.world}
            bundles={bundles.filter((b) => b.sample)}
            playing={replay > 0}
          />
        </>
      )}
    </>
  );
}
