// /app/ask: the full-page Ask Notary. The selected precomputed answer lives in ?answer= so it can
// be shared like any other record URL.
import { useSearchParams } from "react-router";
import { PageHeader } from "../ui/page-header";
import { AskNotary } from "./AskNotary";
import { ASK_SHORTCUT_LABEL } from "./AskContext";

export function AskPage() {
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("answer") ?? undefined;
  return (
    <>
      <PageHeader
        title="Ask"
        description={`Answers built only from records, each backed by citations. ${ASK_SHORTCUT_LABEL} opens the panel from any page.`}
      />
      <AskNotary
        variant="page"
        selectedId={selectedId}
        onSelect={(id) =>
          setParams((p) => {
            const next = new URLSearchParams(p);
            if (id) next.set("answer", id);
            else next.delete("answer");
            return next;
          })
        }
      />
    </>
  );
}
