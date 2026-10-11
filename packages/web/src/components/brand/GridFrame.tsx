// The grid framework for white sections: thin vertical hairlines at the content edges, and small
// hollow circle nodes where a section's top boundary crosses them. Decorative (aria-hidden).
//
//   <GridFrame>
//     <GridSection aria-labelledby="proof-title" rule>   ← hairline across + nodes at both edges
//       <div className="grid-inner">…content…</div>
//     </GridSection>
//   </GridFrame>
import type { ComponentPropsWithRef, ReactNode } from "react";
import "./brand.css";

export function GridFrame({ children, className, ...rest }: ComponentPropsWithRef<"div">) {
  return (
    <div className={["grid-frame", className].filter(Boolean).join(" ")} {...rest}>
      <div className="grid-frame-lines" aria-hidden="true" />
      {children}
    </div>
  );
}

type GridSectionProps = ComponentPropsWithRef<"section"> & {
  children?: ReactNode;
  /** Draw a hairline across the top boundary (nodes are drawn either way). */
  rule?: boolean;
  /** Hide the nodes (e.g. the first section under a full-bleed block). */
  nodes?: boolean;
};

export function GridSection({ children, className, rule = false, nodes = true, ...rest }: GridSectionProps) {
  return (
    <section className={["grid-section", className].filter(Boolean).join(" ")} data-rule={rule || undefined} {...rest}>
      {nodes && (
        <div className="grid-rail" aria-hidden="true">
          <span className="grid-node grid-node-l" />
          <span className="grid-node grid-node-r" />
        </div>
      )}
      {children}
    </section>
  );
}
