import { useLocation, useNavigate } from "react-router";
import { Select } from "../../ui";
import { useData } from "../../app/catalog";
import { withRun } from "../../app/links";
import { matchAppRoute, routeById } from "../../routes";

/**
 * Selected-run picker. One <optgroup> per cohort, real runs first (live or recorded), then
 * recorded fixtures; never mixed.
 * Switching runs on a record page returns to that record's list, since records belong to a world.
 */
export function RunPicker() {
  const { runGroups, selectedRunId, loading, error } = useData();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const onChange = (runId: string) => {
    const route = matchAppRoute(pathname)?.route;
    const target = route?.record && route.parent ? (routeById(route.parent)?.path ?? "/app/run") : pathname;
    navigate(withRun(target, runId));
  };
  const empty = !runGroups.length;
  return (
    <label className="run-picker">
      <span className="sr-only">Selected run</span>
      <Select
        value={empty ? "" : (selectedRunId ?? "")}
        disabled={empty || loading}
        onChange={(e) => onChange(e.target.value)}
      >
        {empty && <option value="">{loading ? "Loading runs…" : error ? "Runs withheld" : "No runs published"}</option>}
        {runGroups.map((group) => (
          <optgroup key={group.kind} label={group.label}>
            {group.runs.map((run) => (
              <option key={run.runId} value={run.runId}>
                {run.runId}
                {run.variant !== run.kind ? ` · ${run.variant}` : ""}
              </option>
            ))}
          </optgroup>
        ))}
      </Select>
    </label>
  );
}
