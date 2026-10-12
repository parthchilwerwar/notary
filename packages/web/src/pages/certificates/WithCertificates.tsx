import type { ReactNode } from "react";
import { useData } from "../../app/catalog";
import type { CertificateView } from "../../data";
import { EmptyState, Page, PageBody, PageHeader, PageSkeleton } from "../../ui";

/** Renders children with the selected run's certificate world, or the right state under the page's band. */
export function WithCertificates({ title, children }: { title: string; children: (world: CertificateView) => ReactNode }) {
  const { certificates, bundle } = useData();
  if (certificates.status === "loading") return <PageSkeleton label="Verifying certificate seals…" />;
  if (certificates.status === "ready") return <>{children(certificates.data)}</>;
  return (
    <Page>
      <PageHeader title={title} />
      <PageBody>
        {certificates.status === "error" ? (
          <EmptyState tone="error" title="Certificates withheld">
            <p>A certificate file failed its seal or schema check in this browser, so none of it is shown. Re-export with <code>pnpm notary export --certificates</code>.</p>
            <p className="certs-detail">{certificates.error}</p>
          </EmptyState>
        ) : (
          <EmptyState title="No certificates for this run yet">
            {bundle?.sample
              ? "No certificate export is published for this fixture scenario. "
              : "No certificate export is published for these runs yet. "}
            Certificates are built with <code>pnpm notary export --certificates</code> after a notarize run.
          </EmptyState>
        )}
      </PageBody>
    </Page>
  );
}
