// Business group: Economics, Evidence.
import { Economics } from "../Economics";
import { Evidence } from "../Evidence";
import { PageHeader } from "../components/ui";
import { useData } from "../state/DataProvider";
import { useBundle } from "./shared";

export function EconomicsPage() {
  const bundle = useBundle();
  const { baseline } = useData();
  return (
    <>
      <PageHeader
        title="Economics"
        description="The cost of earning trust, from recorded usage and credits."
      />
      <Economics bundle={bundle} comparison={baseline} />
    </>
  );
}

export function EvidencePage() {
  const { bundles, evidence } = useData();
  return (
    <>
      <PageHeader
        title="Evidence"
        description="Receipts behind the demonstration: required tools, then the fixture demo."
      />
      <Evidence all={bundles} evidence={evidence} />
    </>
  );
}
