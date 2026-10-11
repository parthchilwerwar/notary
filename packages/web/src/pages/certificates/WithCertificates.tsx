import type { ReactNode } from "react";
import { useData } from "../../app/catalog";
import type { CertificateView } from "../../data";
import { EmptyState, ErrorState, LoadingState } from "../../components/ui/states";

/** Renders children with the selected run's certificate world, or the right state. */
export function WithCertificates({ children }: { children: (world: CertificateView) => ReactNode }) {
  const { certificates, bundle } = useData();
  if (certificates.status === "loading")
    return (
      <LoadingState title="Verifying certificate seals…">
        Checking the shared certificate schema and recomputing every seal.
      </LoadingState>
    );
  if (certificates.status === "error")
    return <ErrorState title="Certificates withheld">{certificates.error}</ErrorState>;
  if (certificates.status === "missing")
    return (
      <EmptyState title="No certificates for this run's world">
        {bundle?.sample
          ? "No fixture certificate export is published for this simulated world. "
          : "No certificate export is published for recorded runs. "}
        Certificates are built with <code>pnpm notary export --certificates</code>.
      </EmptyState>
    );
  return <>{children(certificates.data)}</>;
}
