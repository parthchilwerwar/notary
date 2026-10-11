import type { ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "../lib/utils";
import { StatusPill } from "./StatusPill";

/**
 * The certificate seal: a ring in the status color (the landing's .l-art-seal) and, when given,
 * the first characters of the recorded sha256. Revoked seals are gray and struck through.
 */
export function Seal({ sha256, revoked = false, className }: { sha256?: string; revoked?: boolean; className?: string }) {
  return (
    <span className={cn("ui-seal", className)} data-revoked={revoked || undefined}>
      <span className="ui-seal-ring" aria-hidden="true" />
      {sha256 && (
        <code className="ui-seal-hash" title={`sha256 ${sha256}`}>
          sha256 {sha256.slice(0, 12)}…
        </code>
      )}
    </span>
  );
}

/**
 * The landing's certificate card (Key features 01), data-agnostic: the page passes what the
 * certificate recorded. `href` links the claim to its detail page.
 */
export function CertificateCard({
  tool,
  claimId,
  revoked = false,
  verdict,
  scope,
  evidence,
  sha256,
  href,
  footer,
  compact = false,
  className,
}: {
  tool: string;
  claimId: string;
  revoked?: boolean;
  verdict?: ReactNode;
  scope?: ReactNode;
  evidence?: ReactNode;
  sha256?: string;
  href?: string;
  footer?: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <article className={cn("ui-card ui-pad-md ui-cert", compact && "ui-cert-compact", className)} data-revoked={revoked || undefined} data-reveal>
      <div className="ui-cert-head">
        <span className="ui-cert-kicker">{tool} certificate</span>
        <StatusPill tone={revoked ? "revoked" : "safe"}>{revoked ? "Revoked" : "Certified"}</StatusPill>
      </div>
      <h3 className="ui-cert-claim">
        {href ? (
          <Link to={href}>
            <code>{claimId}</code>
          </Link>
        ) : (
          <code>{claimId}</code>
        )}
      </h3>
      {!compact && (verdict || scope || evidence || sha256) && (
        <dl className="ui-facts ui-facts-2">
          {verdict && (
            <div>
              <dt>Verdict</dt>
              <dd>{verdict}</dd>
            </div>
          )}
          {evidence && (
            <div>
              <dt>Evidence</dt>
              <dd className="num">{evidence}</dd>
            </div>
          )}
          {scope && (
            <div className="ui-facts-wide">
              <dt>Scope</dt>
              <dd>{scope}</dd>
            </div>
          )}
          {sha256 && (
            <div className="ui-facts-wide">
              <dt>Seal</dt>
              <dd>
                <Seal sha256={sha256} revoked={revoked} />
              </dd>
            </div>
          )}
        </dl>
      )}
      {footer && <div className="ui-cert-foot">{footer}</div>}
    </article>
  );
}
