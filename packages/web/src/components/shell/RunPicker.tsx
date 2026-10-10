import { useLocation, useNavigate } from "react-router";
import { StackIcon as Stack } from "@phosphor-icons/react/dist/csr/Stack";
import { SelectControl } from "../SelectControl";
import { useData } from "../../state/DataProvider";
import { withRun } from "../../state/data-mode";
import { matchAppRoute, routeById } from "../../routes";

/**
 * Selected-run picker. One <optgroup> per cohort (live or recorded, fixture), never mixed.
 * Switching runs on a record page returns to that record's list, since record ids are per run.
 */
export function RunPicker() {
  const { runGroups, selectedRunId, loading } = useData();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const onChange = (runId: string) => {
    const match = matchAppRoute(pathname);
    const route = match?.route;
    const target =
      route?.record && route.record !== "report" && route.parent
        ? (routeById(route.parent)?.path ?? "/app")
        : pathname;
    navigate(withRun(target, runId));
  };
  const empty = !runGroups.length;
  return (
    <label className="run-picker">
      <span className="sr-only">Selected run</span>
      <SelectControl
        icon={<Stack size={16} />}
        aria-label="Selected run"
        value={empty ? "" : (selectedRunId ?? "")}
        disabled={empty || loading}
        onChange={(e) => onChange(e.target.value)}
      >
        {empty && (
          <option value="">{loading ? "Loading runs…" : "No runs published"}</option>
        )}
        {runGroups.map((group) => (
          <optgroup key={group.kind} label={group.label}>
            {group.runs.map((run) => (
              <option key={run.runId} value={run.runId}>
                {run.runId} · {run.kind}
                {run.variant !== run.kind ? ` / ${run.variant}` : ""}
              </option>
            ))}
          </optgroup>
        ))}
      </SelectControl>
    </label>
  );
}
