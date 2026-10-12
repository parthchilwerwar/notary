# deploy/aws/data

`deploy/aws/stage-data.sh` fills `runs/` here (gitignored) with copies of the **real** run bundles
(`<runId>.json`, `index.json`, `timeline.jsonl`) from `packages/core/runs/`, and the Dockerfile
bakes this directory into the image at `/app/data/runs`. Nothing is committed here; an empty
directory builds an image whose hosted API simply has no runs to show.
