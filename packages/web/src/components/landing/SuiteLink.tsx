import { Link } from "react-router";
import { FIXTURES_PARAM, fixturesInLocation } from "../../app/links";

/** The link under a landing empty state (default view only). */
export const SUITE_LINK_TEXT = "See it on the labelled evaluation suite";

/** This page in the development-only fixture view, where the fixture banner is shown. */
export const SUITE_HREF = `/?${FIXTURES_PARAM}=1`;

/**
 * Under an honest empty state of the real view ("No held refund is published yet."), a link to the
 * same page on the evaluation suite: the fixture runs, under the visible fixture banner. Never in
 * the fixture view itself (the flag is read on every render).
 */
export function SuiteLink({ className }: { className?: string }) {
  if (fixturesInLocation()) return null;
  return (
    <Link className={className ? `l-suite-link ${className}` : "l-suite-link"} to={SUITE_HREF}>
      {SUITE_LINK_TEXT}
    </Link>
  );
}
