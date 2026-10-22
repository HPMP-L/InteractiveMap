# W→T→R→C Research Map

An interactive map of the state of research on predicting the infrastructure demand of LLM agents:
the chain **Workload → Trajectory → Resources → Capacity**, the 123 papers that document it, the open questions,
and three matrices that code every paper.

- **Map**: columns follow the chain (W, T, R, C); horizontal lanes separate **execution**, **orchestration** and
  **characterization**. Click a box to highlight it with everything below it, a lane name to highlight the lane, a column
  header to highlight the column. A paper that matters to both execution and orchestration appears once in each lane.
- **Matrices**: approaches × chain link, inputs × outputs, orchestration. Click a paper, a cell, a row or a column.
- **Papers**: the full list, searchable and sortable.

## Suggest a change (no account needed)

Every paper, map box, cell and text has a **Suggest an edit** button, and **Suggest a new paper** (top bar, map boxes,
matrix cells) proposes a missing paper with its place in a matrix and on the map. Collect as many changes as you like, write one or two
sentences on why, and send them. Each suggestion becomes a pull request in this repository; nothing changes on the site until
the maintainer reviews and merges it.

## How it works

| File | Role |
|---|---|
| `index.html` | The whole site: one page, no build step, no framework. |
| `data.json` | All the content: papers, matrices, map boxes and links. Suggestions edit this file. |
| `core.js` | Checks and applies suggested changes. The page uses it to preview, the worker to build the pull request. |
| `worker/worker.js` | A small Cloudflare Worker that holds the GitHub token and opens the pull requests. It refuses to run without the Turnstile anti-spam check and a list of allowed sites. |
| `tools/check-data.js` | Consistency check run on every pull request (`.github/workflows/check-data.yml`). |
| `.github/workflows/suggestion-files.yml` | Fails any pull request the owner did not open (suggestions, forks) that changes files other than `data.json` and `suggestions/*.md`. It runs from `main`, so a pull request cannot change it. |
| `.github/CODEOWNERS` | Makes the owner's approval the one that counts on the protected `main` branch. |
| `tools/sync_core.py` | Copies `core.js` into `worker/worker.js` after you edit it. |
| `tools/format_data.py` | Puts `data.json` back in its canonical format after a hand edit (same as `node tools/check-data.js --fix`). |
| `tools/worker-test.html` | Runs the worker against a simulated GitHub in the browser (no token needed). |

Hosting and setup: see [HOSTING.md](HOSTING.md).

To preview locally, run `py -m http.server` (Windows) or `python3 -m http.server` (macOS, Linux) in this folder and open <http://localhost:8000>
(browsers do not load `data.json` from a page opened straight from the disk).

## How the map is stored

The map has no drawn coordinates: the page lays it out from its structure, so a new box never overlaps another.
In `data.json`, `map.lanes` lists the lanes, `map.columns` ties each column (W, T, R, C) to its header box, and each box in
`map.nodes` has either a `parent` (the box it sits under) or, for the top box of a branch, a `lane` and a `column`.
`also` lists related boxes, drawn as dotted links when one end is selected. To move a branch, change its `parent`
(or its `lane` and `column`); `node tools/check-data.js` tells you if something no longer fits
(without Node, open `tools/check-data-test.html` through the local preview).
