// Compatibility shim (K2): the dashboard's states now live in the kit (src/ui). Only main.tsx's
// Suspense fallback still imports from here; it renders the kit's page skeleton.
import type { ReactNode } from "react";
import { PageSkeleton } from "../../ui/States";

export function LoadingState({ title = "Loading…" }: { title?: ReactNode; children?: ReactNode }) {
  return <PageSkeleton label={typeof title === "string" ? title : "Loading…"} />;
}
