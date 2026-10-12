// Entire on the Report page: the checkpoints Entire recorded for this repo (AI agent sessions tied
// to the commits they made; adversary reviews among them) and the guard-coverage result of the
// `entire graph` backend. Everything comes from public/evidence/entire.json, written by
// `pnpm notary export --entire` from the real Entire CLI and validated here with the shared schema.
// No numbers are computed or invented on this page; empty lists show the file's own reason.
import { useEffect, useState } from "react";
import { GitCommitIcon as GitCommit } from "@phosphor-icons/react/dist/csr/GitCommit";
import { RobotIcon as Robot } from "@phosphor-icons/react/dist/csr/Robot";
import { FilesIcon as Files } from "@phosphor-icons/react/dist/csr/Files";
import { ShieldCheckIcon as ShieldCheck } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { ShieldWarningIcon as ShieldWarning } from "@phosphor-icons/react/dist/csr/ShieldWarning";
import { TerminalIcon as Terminal } from "@phosphor-icons/react/dist/csr/Terminal";
import type { EntireCheckpoint, EntireFile } from "../../../../core/src/schema/entire";
import { ENTIRE_FILE, loadEntireFile } from "../../data/entire";
import { dateTime } from "../../lib/time";
import { CodeText } from "./receipts";
import "./EntireSection.css";

const EXPORT_COMMAND = "pnpm notary export --entire";

type State =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error"; error: string }
  | { status: "ready"; file: EntireFile };

const fmt = new Intl.NumberFormat("en-US");
const short = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

export function EntireSection() {
  const [state, setState] = useState<State>({ status: "loading" });
  useEffect(() => {
    const ctl = new AbortController();
    loadEntireFile(ctl.signal)
      .then((file) => setState(file ? { status: "ready", file } : { status: "missing" }))
      .catch((e: Error) => {
        if (e.name !== "AbortError") setState({ status: "error", error: e.message });
      });
    return () => ctl.abort();
  }, []);

  if (state.status === "loading") {
    return (
      <p className="report-note" role="status">
        Reading the Entire checkpoint file…
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <p className="report-unsafe" role="alert">
        {state.error}
      </p>
    );
  }
  if (state.status === "missing") {
    return (
      <div className="entire">
        <p className="report-note">
          No Entire file is published (<code>{ENTIRE_FILE}</code>).
        </p>
        <Command text={EXPORT_COMMAND} />
      </div>
    );
  }
  return <EntireView file={state.file} />;
}

/** The validated file, rendered (no fetching; tests render it directly). */
export function EntireView({ file }: { file: EntireFile }) {
  const reviews = file.checkpoints.filter((c) => c.kind === "adversary-review").length;
  return (
    <div className="entire" aria-label="Entire checkpoints and guard coverage">
      <p className="entire-meta">
        {file.cli.installed ? (
          <>
            Entire CLI <span translate="no">{file.cli.version}</span>
            {file.cli.graphPlugin && (
              <>
                {" "}
                · entire-graph <span translate="no">{file.cli.graphPlugin}</span>
              </>
            )}
            {" "}· {file.repo.enabled ? `enabled for ${file.repo.agents.join(", ") || "no agent"}` : "not enabled in this repo"}
            {file.branch && <> · branch <code>{file.branch}</code></>}
          </>
        ) : (
          "Entire CLI not installed on the machine that wrote this file"
        )}
      </p>

      <div className="entire-figures">
        <p>
          <span className="entire-figure">{fmt.format(file.checkpoints.length)}</span>
          <span className="entire-figure-label">{file.checkpoints.length === 1 ? "checkpoint" : "checkpoints"}</span>
        </p>
        <p>
          <span className="entire-figure">{fmt.format(reviews)}</span>
          <span className="entire-figure-label">{reviews === 1 ? "adversary review" : "adversary reviews"}</span>
        </p>
        {file.coverage && (
          <p>
            <span className={`entire-figure${file.coverage.unguardedCallSites > 0 ? " entire-figure-bad" : ""}`}>
              {fmt.format(file.coverage.unguardedCallSites)}
            </span>
            <span className="entire-figure-label">unguarded call sites</span>
          </p>
        )}
      </div>

      {file.checkpoints.length === 0 ? (
        <div className="entire-empty">
          <p className="report-note">
            <CodeText text={file.checkpointsNote ?? ""} />
          </p>
        </div>
      ) : (
        <ol className="entire-rows">
          {file.checkpoints.map((c) => (
            <CheckpointRow key={c.id} c={c} />
          ))}
        </ol>
      )}

      <div className="entire-coverage">
        <h4 className="entire-subhead">Guard coverage via entire graph</h4>
        {file.coverage ? (
          <>
            <p className="entire-coverage-line">
              {file.coverage.unguardedCallSites === 0 ? (
                <ShieldCheck aria-hidden="true" className="entire-icon entire-icon-safe" weight="regular" />
              ) : (
                <ShieldWarning aria-hidden="true" className="entire-icon entire-icon-bad" weight="regular" />
              )}
              <span>
                {fmt.format(file.coverage.callEdges)} call and {fmt.format(file.coverage.constructEdges)} construct relations
                scanned; {fmt.format(file.coverage.sites)} sites over {fmt.format(file.coverage.ops)} money and data operations:{" "}
                {fmt.format(file.coverage.guarded)} guarded, {fmt.format(file.coverage.rawByDesign)} raw by design,{" "}
                {fmt.format(file.coverage.unguardedCallSites)} unguarded.
              </span>
            </p>
            {file.coverage.unguarded.length > 0 && (
              <ul className="entire-unguarded">
                {file.coverage.unguarded.map((s) => (
                  <li key={`${s.op}@${s.file}:${s.line}`}>
                    <code>{s.op}</code> at <code>{`${s.file}:${s.line}`}</code> — {s.detail}
                  </li>
                ))}
              </ul>
            )}
            <p className="report-note">
              {file.coverage.graphProvider} {file.coverage.graphVersion} on{" "}
              <code>{file.coverage.commit ? short(file.coverage.commit, 12) : "unknown commit"}</code>
              {file.coverage.worktree ? " plus the working tree" : ""}, completeness {file.coverage.completeness}.
            </p>
            <Command text={file.coverage.command} />
          </>
        ) : (
          <p className="report-note">
            <CodeText text={file.coverageNote ?? ""} />
          </p>
        )}
      </div>
    </div>
  );
}

function CheckpointRow({ c }: { c: EntireCheckpoint }) {
  return (
    <li className="entire-row">
      <div className="entire-row-head">
        <code className="entire-id" title={c.id}>
          {c.id}
        </code>
        <time dateTime={c.at}>{dateTime(c.at)}</time>
      </div>
      <p className="entire-row-msg">
        {c.review ? (
          <>
            Adversary review: <strong>{c.review.verdict}</strong> <code>{c.review.beliefId}</code>
          </>
        ) : (
          c.message || "No commit message recorded"
        )}
      </p>
      <dl className="entire-row-facts">
        <div>
          <dt>
            <Robot aria-hidden="true" className="entire-icon" />
            <span className="sr-only">Session</span>
          </dt>
          <dd>
            {c.agent}
            {c.model && <> · {c.model}</>} · session{c.sessionIds.length > 1 ? "s" : ""}{" "}
            {c.sessionIds.map((s, i) => (
              <code key={s} title={s}>
                {i > 0 ? ", " : ""}
                {short(s, 8)}
              </code>
            ))}
          </dd>
        </div>
        <div>
          <dt>
            <GitCommit aria-hidden="true" className="entire-icon" />
            <span className="sr-only">Commit</span>
          </dt>
          <dd>{c.commit ? <code title={c.commit}>{short(c.commit, 12)}</code> : "commit not on this branch"}</dd>
        </div>
        <div>
          <dt>
            <Files aria-hidden="true" className="entire-icon" />
            <span className="sr-only">Files touched</span>
          </dt>
          <dd>
            {c.filesTouched.length === 0 ? (
              c.logsOnly ? "session logs only" : "no files recorded"
            ) : (
              <>
                {fmt.format(c.filesTouched.length)}{" "}
                {c.filesTouched.length === 1 ? "file" : "files"}:{" "}
                {c.filesTouched.slice(0, 3).map((f, i) => (
                  <code key={f}>
                    {i > 0 ? ", " : ""}
                    {f}
                  </code>
                ))}
                {c.filesTouched.length > 3 && <> and {fmt.format(c.filesTouched.length - 3)} more</>}
              </>
            )}
          </dd>
        </div>
      </dl>
    </li>
  );
}

function Command({ text }: { text: string }) {
  return (
    <p className="entire-command">
      <Terminal aria-hidden="true" className="entire-icon" />
      <code>{text}</code>
    </p>
  );
}
