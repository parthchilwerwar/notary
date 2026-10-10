// Budget meters from the run's BudgetSnapshot (a `budget` event, or run.finished's copy):
// credits, tool calls and model spend in USD by role. A cap is drawn only when one is recorded;
// a null cap reads "no cap configured". In replay the meters stay empty until the snapshot event
// has been replayed — nothing is interpolated.
import { motion } from "motion/react";
import { StatusPill } from "../../components/ui";
import { meterView, usdView, type BudgetAt, type MeterView } from "./model";

function Meter({
  label,
  view,
  note,
  reduced,
}: {
  label: string;
  view: MeterView;
  note?: string;
  reduced: boolean;
}) {
  return (
    <div className="meter">
      <div className="meter-line">
        <span className="meter-label">{label}</span>
        <span className="meter-value">
          <motion.strong
            key={view.used}
            initial={reduced ? false : { opacity: 0.4 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3 }}
          >
            {view.used}
          </motion.strong>{" "}
          <span className={view.ratio === null ? "meter-nocap" : "muted"}>{view.capText}</span>
        </span>
      </div>
      {view.ratio !== null ? (
        <div
          className="meter-track"
          role="meter"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(view.ratio * 100)}
        >
          <motion.span
            className={view.over ? "over" : undefined}
            initial={reduced ? false : { width: 0 }}
            animate={{ width: `${view.ratio * 100}%` }}
            transition={{ duration: reduced ? 0 : 0.5, ease: "easeOut" }}
          />
        </div>
      ) : (
        <div className="meter-track nocap" aria-hidden="true" />
      )}
      {note && <p className="meter-note">{note}</p>}
    </div>
  );
}

export function BudgetMeters({
  budget,
  firstSeq,
  replaying,
  reduced,
}: {
  budget?: BudgetAt;
  /** seq of the event that carries the snapshot in the full timeline, if any. */
  firstSeq?: number;
  replaying: boolean;
  reduced: boolean;
}) {
  return (
    <>
      <div className="mc-card-head">
        <div>
          <h2>Budget</h2>
          <p className="muted">
            {budget ? `Snapshot from event #${budget.seq}` : "One exact snapshot per run"}
          </p>
        </div>
        {budget?.snapshot.stopReason && (
          <StatusPill tone="unsafe">Stopped: {budget.snapshot.stopReason}</StatusPill>
        )}
      </div>
      {budget ? (
        <BudgetBody budget={budget} reduced={reduced} />
      ) : (
        <p className="budget-pending">
          {firstSeq === undefined
            ? "This timeline carries no budget snapshot."
            : replaying
              ? `The budget snapshot is event #${firstSeq}; it has not been replayed yet.`
              : "No budget snapshot has arrived yet."}
        </p>
      )}
    </>
  );
}

function BudgetBody({ budget, reduced }: { budget: BudgetAt; reduced: boolean }) {
  const s = budget.snapshot;
  const usd = usdView(s);
  return (
    <div className="meters">
      <Meter label="Credits" view={meterView(s.credits)} reduced={reduced} />
      <Meter
        label="Tool calls"
        view={meterView(s.toolCalls)}
        note="Probe calls plus decision effects."
        reduced={reduced}
      />
      <Meter label="Model spend (USD)" view={usd.total} reduced={reduced} />
      <dl className="role-spend">
        {usd.roles.map((r) => (
          <div key={r.role}>
            <dt>{r.role}</dt>
            <dd>{r.usd}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
