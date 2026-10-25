# How the site works

The [README](README.md) is the list itself. This page is for whoever maintains the site: what each file does, and how
the list, the map and the suggestions fit together. Setting it up on GitHub and Cloudflare is described in the
maintainer's own guide, which stays on the maintainer's computer: it is no longer tracked in this repository (older
versions remain in its history).

The site is an interactive map of the state of research on predicting the infrastructure demand of LLM agents: the chain
**Workload → Trajectory → Resources → Capacity**, the papers that document it, the open questions, and three matrices that
code every paper.

- **Map**: columns follow the chain (W, T, R, C); horizontal lanes separate **execution**, **orchestration** and
  **characterization**. Click a box to highlight it with everything below it, a lane name to highlight the lane, a column
  header to highlight the column. A paper that matters to both execution and orchestration appears once in each lane.
- **Matrices**: approaches × chain link, inputs × outputs, orchestration. Click a paper, a cell, a row or a column.
- **Papers**: the full list, searchable and sortable.

## Suggestions (no account needed)

Every paper, map box, cell and text has a **Suggest an edit** button, and **Add your paper** (top bar, map boxes, matrix
cells) proposes a missing paper with its place in a matrix and on the map. Visitors collect their changes, say why in one
sentence and send them, in three steps on the **Suggest** tab. Each suggestion becomes a pull request in this repository;
nothing changes on the site, or in the README, until the maintainer approves and merges it.

The panel of a map box has an **Add below** block: **Add a paper**, **Add a sub-section** (a new concept box, a name and an
optional line under it), **Add a question or idea** and **Attach a listed paper**; a column header has **Add a section** and
**Add a question or idea**, in a lane the visitor picks. Forms start from where the visitor clicked:

- **Add a paper** from a box places the paper below that box, and in the matrix cell the box is linked to: its own `links`,
  or those of the nearest box above it, then the lane's, then the column header's. A row or a column is filled in only when
  the links agree on a single one; the boxes further up can complete what is left, on the same condition. What is not known
  stays to choose, and the form says so in its **Where it will go** summary.
- One suggestion adds at most 5 boxes to the map (`CORE.LIMITS.mapBoxes`): the panels say how many are left, and when none
  is, a paper can still be added to the list and its matrix, not on the map.
- **Add a paper** from a matrix cell places it in that cell, and below the map box linked to exactly that cell when there is
  only one; the boxes linked to the cell are listed first.
- A sub-section added a minute ago can take papers right away, before anything is sent: forms work on the data with the
  visitor's pending changes applied (`S.eff`), and `CORE.apply` gives the new box the same id in the page and in the worker
  (`s` + a hash of its parent and its text).

All of this is in `index.html`: `core.js` already accepts these changes, so the worker does not change.

## The README is generated

`README.md` is written from `data.json` by `CORE.readme` in `core.js`, in the style of an "awesome" list: one section per
link of the chain (the columns of the first matrix), split by kind of approach (its row groups), then the open questions
of the map. Each paper appears once, in its main cell of the first matrix.

- The worker regenerates `README.md` in every suggestion that changes `data.json`, so a merged suggestion updates the list
  in the same pull request.
- After a hand edit of `data.json`, regenerate it: open `tools/readme.html` through the local preview and copy the text into
  `README.md`. `tools/check-data.js` (run on every pull request) fails, and so blocks the merge, when `README.md` is not
  exactly what `CORE.readme` writes; with Node, `node tools/check-data.js --fix` rewrites both `data.json` and `README.md`.
  It also fails when the copy of `core.js` inside `worker/worker.js` is out of date.
- The README has no totals: each paper and each question is a line of its own, so two suggestions merged one after the other
  still give the README of the merged data (or a visible conflict on neighbouring lines).
- The site's address and repository are `SITE` and `REPO` in `core.js`, not in `data.json`, so a suggestion cannot change
  where the list points.
- To change the layout or the wording of the list, in one pull request: edit `CORE.readme` in `core.js`, run
  `py tools/sync_core.py`, regenerate `README.md`. Merge it, then paste `worker/worker.js` into Cloudflare right away: until
  then, suggestions arrive with a README that the check refuses.

## Files

| File | Role |
|---|---|
| `index.html` | The whole site: one page, no build step, no framework. |
| `data.json` | All the content: papers, matrices, map boxes and links, and the list's name and subtitle (`meta`). Suggestions edit this file. |
| `README.md` | The awesome list, generated from `data.json`. Do not edit by hand. |
| `core.js` | Checks and applies suggested changes, and writes the README. The page uses it to preview, the worker to build the pull request. |
| `worker/worker.js` | A small Cloudflare Worker that holds the GitHub token and opens the pull requests. It refuses to run without the Turnstile anti-spam check and a list of allowed sites. |
| `tools/check-data.js` | Consistency check run on every pull request (`.github/workflows/check-data.yml`). |
| `.github/workflows/suggestion-files.yml` | Fails any pull request the owner did not open (suggestions, forks) that changes files other than `data.json`, `README.md` and `suggestions/*.md`. It runs from `main`, so a pull request cannot change it. |
| `.github/CODEOWNERS` | Makes the owner's approval the one that counts on the protected `main` branch. |
| `tools/sync_core.py` | Copies `core.js` into `worker/worker.js` after you edit it. |
| `tools/format_data.py` | Puts `data.json` back in its canonical format after a hand edit (same as `node tools/check-data.js --fix`, without the README). |
| `tools/readme.html` | Shows the README generated from the current `data.json`, to copy into `README.md` after a hand edit. |
| `tools/worker-test.html` | Runs the worker against a simulated GitHub in the browser (no token needed). |
| `tools/check-data-test.html` | Runs the data check in the browser, without Node. |

To preview locally, run `py -m http.server` (Windows) or `python3 -m http.server` (macOS, Linux) in this folder and open
<http://localhost:8000> (browsers do not load `data.json` from a page opened straight from the disk).

## How the map is stored

The map has no drawn coordinates: the page lays it out from its structure, so a new box never overlaps another.
In `data.json`, `map.lanes` lists the lanes, `map.columns` ties each column (W, T, R, C) to its header box, and each box in
`map.nodes` has either a `parent` (the box it sits under) or, for the top box of a branch, a `lane` and a `column`.
`also` lists related boxes, drawn as dotted links when one end is selected. To move a branch, change its `parent`
(or its `lane` and `column`); `node tools/check-data.js` tells you if something no longer fits
(without Node, open `tools/check-data-test.html` through the local preview).

## The map view

- **The guide** ("How to read the map") is open until the visitor closes it with ×; that choice is remembered in the
  browser (`wtrc-guide`), and "Guide and legend" brings it back. Nothing else closes it. While a card is open on a screen
  narrower than 1280px it steps aside, and comes back when the card closes. On phones, where it covers the map, going to
  an area from it puts it aside without remembering that.
- **Zoomed out, titles grow.** Every box keeps the size the layout gave it; `fitTitles()` measures, box by box, how
  much its title can grow before anything spills out (titles, and the descriptions below them), up to a limit that rises
  as you zoom out. Headings may grow most, paper names and questions a little; peers share one size (the lane names, the
  four links of the chain), and no title ends larger than the one above it. Sizes are measured once per zoom step and
  level of detail, after the zoom settles, and measured again whenever the map is laid out again.
- **The overview.** Zoomed out (below 50%), the map is laid out again with its sections only: lanes, the links of
  the chain and the section boxes, in larger type, each saying how many papers and questions sit just below it. Papers,
  questions and key insights come back past 75% (the gap between the two keeps it from switching back and forth). While
  zooming, the section nearest the pointer stays in place; "Whole map", "Go to an area", clicking a box or opening a
  paper choose the layout that suits what they show (`frame()` in `index.html`).
- **Colours, recalled.** The side panel of a box says what its colour means on the map ("Colour on the map"): the
  status edge of a paper among the four, the shade of a section among the levels and its blue dot, the blue of a
  question, the colour shared by the top level. Panels that list papers as chips explain their shade.
