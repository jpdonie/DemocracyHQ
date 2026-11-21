# Contributing

Thank you for looking. DemocracyHQ is a small research tool whose whole value is
that a reader can trust what it shows and check it. Contributions are welcome on
those terms.

## The rules that matter most

1. **Nothing is invented.** No case details, docket entries, bill text, dates,
   counts or boundaries that did not come from a source. If the source is silent,
   the record says "not verified" or "unavailable".
2. **Every record links to a primary source**: a court, a legislature or the
   Census Bureau. A news report, a press release or an advocacy tracker is a lead,
   not a source.
3. **Neutral wording.** Describe what a record says in the record's own terms.
   No "win", "loss", "attack", "reform", "rigged" or similar. Do not characterise
   the motives of any party, legislator or court.
4. **No legal advice and no voting guidance.**
5. **No personal data.** No voter records, no individual's party affiliation, and
   nothing about private individuals beyond names that appear in public court
   dockets and legislative records.
6. **Respect the sources.** Do not bypass a login, a paywall, a rate limit or a
   block on automated requests. Follow each site's `robots.txt`, including its
   crawl delay. Do not imitate a browser. If a source says no, the answer is no.
7. **Synthetic data stays in tests.** Test fixtures are labelled as synthetic, and
   made-up addresses use the reserved `example.test` domain. The pipeline tests
   answer the adapters' real addresses from a fake session with the network
   blocked. A few tests of the HTTP client talk to a server the test itself starts
   on 127.0.0.1, and any other address fails the test. Nothing synthetic goes in
   `public/data/`.

## Reporting a data problem

Open an issue with the **Data correction** template. Say which record, what is
wrong, and give a link to the primary source that shows the right information.
On a deployed site, the "Report a correction" link on each case and bill page
fills in the record for you.

Please do not put personal information in an issue. Report a security problem
privately, as [SECURITY.md](SECURITY.md) describes, not in an issue.

## Setting up

See the [README](README.md#quick-start). In short:

```sh
npm ci
npm run dev

python -m venv .venv && . .venv/bin/activate
pip install -r pipeline/requirements-dev.txt
```

To install exactly what CI installs, use the lock file instead, with Python 3.13
(the hashes cover only the wheels that CPython 3.13 can install):
`pip install --require-hashes --only-binary=:all: -r pipeline/requirements-dev-lock.txt`.

## Before you open a pull request

```sh
npm run typecheck
npm test
npm run data:validate
npm run build && npm run test:e2e
npm run test:pipeline
```

All of them should pass. `npm run test:e2e` makes its own build in `dist-e2e/`
first; run `npx playwright install chromium` once per machine. `npm run
data:validate` also fails on any file under `public/data/` that is not a `.json`
file the data refers to, hidden files such as `.DS_Store` included, because a
local build would publish them. If you changed how something looks, look at it at
1366 x 768 and at phone width, with the keyboard as well as the mouse.

## Tests

| Suite | Where | Command | What it uses |
| --- | --- | --- | --- |
| Unit | `tests/unit/*.test.ts(x)` | `npm test` (Vitest) | Synthetic fixtures from `tests/unit/fixtures.ts`. A few files also read the published data in `public/data/`: for example, `schemas.test.ts` checks the published index files and every case and bill record against the schemas, and `compare-real-versions.test.tsx` compares every pair of consecutive mirrored versions of every measure. |
| Browser | `tests/e2e/*.spec.ts` | `npm run test:e2e` (Playwright) | The browser-test build and the real dataset, served under a sub-path as on GitHub Pages. `phone.spec.ts` runs in a phone project; every other file runs in a desktop project at 1366 x 768, unless a test sets another size. A few tests answer one data file with an error or an altered copy to check what a view says then. Any console error, failed request, HTTP error or request outside the site's sub-path fails a test, apart from the errors a test causes on purpose. |
| Pipeline | `pipeline/tests/test_*.py` | `npm run test:pipeline` (pytest) | Synthetic sources answered from a fake session (`conftest.py`). `test_network_limits.py` starts its own servers on 127.0.0.1. `test_rules_and_seeds.py` also checks the real seed files against the curation rule below, and one of its tests reads a cached official bill text and is skipped when `pipeline/.cache/` does not hold it. |

The build that is deployed is checked too: the Pages workflow builds `dist/` and
runs the sub-path tests against it before it publishes. To do the same locally
(`CI=1` makes Playwright start its own server for `dist/` instead of reusing a
test server that is already running):

```sh
npm run build
CI=1 E2E_DIST=dist npx playwright test tests/e2e/subpath.spec.ts --project=desktop --grep "Static hosting under a sub-path"
```

Put a test for site logic in `tests/unit/`, a test of what a reader sees in
`tests/e2e/`, and a test for the pipeline in `pipeline/tests/`, next to the tests
of the same module.

## Python dependencies

The pipeline has two pairs of requirement files:

- `pipeline/requirements.txt` and `pipeline/requirements-dev.txt` hold version
  ranges, for local development.
- `pipeline/requirements-lock.txt` (what the pipeline needs at run time) and
  `pipeline/requirements-dev-lock.txt` (that, plus pytest and what it needs) pin
  every package, direct or not, to one version, with the SHA-256 hashes PyPI lists
  for its source archive and for every wheel that CPython 3.13 can install on
  Linux, macOS and Windows. The workflows install them with
  `pip install --require-hashes --only-binary=:all: -r <file>`, so pip refuses any
  other version or any file whose hash is not listed.

To add or update a package:

1. Change its range in `requirements.txt` or `requirements-dev.txt`.
2. In the matching lock file, change the pinned version and replace all of its
   hashes. Add a line, with its hashes, for every package the new version needs
   that is not pinned yet. Keep every pin inside the ranges, and keep
   `pydantic-core` at the exact version that the pinned `pydantic` requires.
3. In a fresh virtual environment, run the `pip install --require-hashes ...`
   command above with `requirements-dev-lock.txt`, then `npm run test:pipeline`.

Dependabot is configured to propose these updates once a week
(`.github/dependabot.yml`). Minor and patch updates of the pipeline's packages come
in one pull request, because `pydantic` pins `pydantic-core` exactly; a major
update comes on its own. Check such a pull request in the same way.

## What a pipeline run reports

`python -m dhq.run` ends with one of these exit codes:

| Code | Meaning |
| --- | --- |
| 0 | No stage raised, no source is marked as failed and no record has gone unrefreshed for longer than its source allows. An optional source without its key is marked `credential_missing`, which does not count as a failure. |
| 1 | A stage raised, a source is marked as failed, or a record has not been refreshed for longer than its source allows. Everything else was published; a failed stage keeps its last published files. |
| 2 | The pipeline's own validation of the staged data failed, or `DHQ_NOW` is set, allowed and not a full UTC timestamp. Nothing was published. |
| 3 | Publishing itself failed. The published data was left as it was. |
| 4 | The arguments were not accepted (for example an unknown stage), the pipeline could not be loaded, or an unexpected error stopped it outside its stages. Nothing new was published. |

Anything uncertain goes into the review queue, `pipeline/staging/review.json`.
Each item has a kind (such as `evidence_check_failed` or `regression`), the record
it concerns, a detail and the stage that flagged it. A run keeps the earlier items
of the stages that did not run, or that failed, in that run, because those stages
left their published files as they were. What a failed stage flagged in the run
itself describes data that was discarded: it stays in the file marked
`notPublished` and is not carried into the next run. When a run publishes nothing
(exit code 2 or 3), its items are marked the same way and the earlier queue is
kept. The manifest in `public/data/` counts the items of the published queue.

## Kinds of change

### How a quoted passage is checked

Every curated link and every curated tag quotes a passage of a named document.
The pipeline checks that the passage is in that document: a case's links to
places and its tags on every run that refreshes the docket, and a link in
`pipeline/seeds/relationships.json` on every run of the relationships stage that
has the cited text (the bill's latest mirrored text, or a case document fetched in
the same run). A link or tag that fails the check is not published at all, and is
listed in `pipeline/staging/review.json`. If the document was not fetched, a link
already published is kept with the date of its last check, and a new link is not
published (see below).

- Copy the words exactly. The check ignores white space, hyphens and dashes
  (including the soft hyphen), letter case and the style of quotation marks (a
  prime mark counts as an apostrophe). It reads Unicode compatibility characters,
  such as ligatures, superscript digits and full-width forms, as their plain
  forms. Every other letter, digit and mark must match, in order.
- To leave words out, write `[…]` between the parts. The parts must appear in the
  document in that order, and each part must be at least 25 characters long, not
  counting white space, hyphens and dashes.
- A passage behind a link to a place must also name the place: the state's name
  for `state:`, the county's name as the Census Bureau gives it (for example
  "Galveston County") for `county:`, and "District N" or "CD N" for a district.
- The check shows that the document says the words. It does not check your
  description of the link, so the description should say no more than the
  passage supports. Do not trim a passage until it passes; choose one that
  supports the link.

### Choosing a passage

The seed files state the curation rule in their `_readme`, and
`pipeline/tests/test_rules_and_seeds.py` checks parts of it:

- Prefer the Court's own text (a per curiam opinion, an order or the opinion of
  the Court), the operative text of a bill, or, where those do not name the place,
  a sentence that describes the facts, such as what a law provides or what a court
  held.
- Never use as a link's evidence a sentence in which a Justice or a party
  characterises another Justice's or another party's position or argument, such
  as a concurrence describing what the dissent would do, or one side's account of
  the other side's case. Avoid argumentative wording where a descriptive sentence
  in the same document names the place.
- Apply party labels symmetrically. A passage names the political party that drew
  or benefited from a map only if the passages of every comparable case or link
  do too; at present none does.
- When a passage comes from a separate opinion (a concurrence or a dissent), say
  so in `evidenceLabel`.
- Curate links of one kind alike, whichever party's members wrote the measures.
  When a measure is linked because its text makes it depend on another, link the
  other measures in the dataset whose text makes them depend on it in the same
  way.

The test also checks a rule that the `_readme` does not state: the passage of a
case's link to a place starts at the beginning of a sentence or a question (the
test looks for a capital letter or a digit), so that the words left out cannot
turn its sense around. The test names the three dockets whose passages start
inside a sentence and were checked by hand.

### Adding a court case

Cases come from `pipeline/seeds/cases.json`. Each entry in `cases` has these
fields:

| Field | What it holds |
| --- | --- |
| `docket` | The Court's docket number |
| `evidence` | The document that the case's links and tags quote unless they name another: `"qp"` (the Court's Questions Presented document), `"initiating"` (the first document linked from the docket, usually the filing that opened it) or `"opinion"` (the opinion linked from the latest entry that links one). An opinion is used only if it names the docket number on its first pages. |
| `evidenceUrl` | Optional. The address of a different document. It must be linked from the docket itself and be on www.supremecourt.gov. It takes the place of `evidence`. |
| `evidenceLabel` | Optional. What that document is, in words. Readers see it beside the passage. |
| `geographies` | One entry for each place the case concerns (below) |
| `tags` | Optional. Subject tags the keyword rules miss (see the next section) |

Each entry in `geographies` has:

| Field | What it holds |
| --- | --- |
| `key` | The place: `state:SS`, `county:SSCCC`, `cd119:SSDD` or `cd120:SSDD`, using Census GEOIDs |
| `scope` | `statewide`, `county`, `congressional_district`, `multi_state` or `unknown` |
| `relationship` | What the link says, for example `concerns_congressional_plan` or `concerns_state_law` |
| `note` | Your description of the link. Readers see it as the maintainer's. It is not checked by machine. |
| `quote` | The passage from the document |
| `evidence`, `evidenceUrl`, `evidenceLabel` | Optional. A different document for this link only |

Then run:

```sh
cd pipeline && python -m dhq.run scotus
```

The relationships and events stages run after it automatically. The pipeline
fetches the docket and the documents the seed names, and checks every passage.
A link that fails is listed in `pipeline/staging/review.json` with the kind
`evidence_check_failed`.

If the docket page cannot be fetched, the docket is listed as `fetch_failed` and
its last published record, if any, is kept. If a cited document cannot be
fetched, the docket is still refreshed and the document is listed as
`document_unavailable`. A link or tag that cites it is kept if it was published
before with the same passage and document and its seed entry is otherwise
unchanged; if not, it is left out and listed as `evidence_unavailable` (a link)
or `curated_tag_check_failed` (a tag). A refreshed docket that is smaller than the
published one (fewer entries or documents, or questions presented that it no
longer has) is held and listed as `regression`, and the published record stays.

In the pull request, say why the case belongs in an election-law dataset. The
list is curated, so the reasons for inclusion are part of the record.

### Adding a subject tag to a case

Use this only where the keyword rules miss the central subject of a case. Add an
entry to the case's `tags` list in `pipeline/seeds/cases.json`:

| Field | What it holds |
| --- | --- |
| `tag` | A tag id from `ISSUE_RULES` in `pipeline/dhq/classify.py`, for example `redistricting` |
| `quote` | The passage that supports the tag |
| `evidence`, `evidenceUrl`, `evidenceLabel` | Optional. The document the passage is from, as for a link. Without them the case's own document is used. |

The tag is published with rule id `tag-curated-1` and its passage. If the keyword
rules already assign the same tag, the curated one is not added. A tag whose
passage is not found is listed in the review queue with the kind
`curated_tag_check_failed`.

### Adding a link between bills, or between a case and a bill

Links from a case to a place go in `pipeline/seeds/cases.json` (above). Every
other link goes in `pipeline/seeds/relationships.json`, with these fields:

| Field | What it holds |
| --- | --- |
| `source`, `target` | `case:<id>`, `bill:<id>` or `geography:<key>`, for example `case:scotus-25a839`, `bill:ca-20252026-ab604` or `geography:state:06` |
| `relationshipType` | What the link says, for example `operative_only_if` or `litigation_concerns_measure` |
| `scope` | `{"kind": ..., "note": ...}`. `kind` takes the same values as a case link's `scope`. `note` is your description and is not checked by machine. |
| `evidenceIn` | `bill:<id>` for the latest mirrored text version of that bill, or `case:<id>` for that case's document as set in `cases.json` |
| `quote` | The passage from that document |

A link whose evidence is a bill can be checked with:

```sh
cd pipeline && python -m dhq.run relationships events
```

A link whose evidence is a case document needs that document fetched in the same
run, so run `python -m dhq.run scotus` instead. If it is not fetched, a link that
was published before with the same passage is kept as it was; a new or edited
link is not published and is listed with the kind `evidence_unavailable`. A link
whose passage is not found is listed as `evidence_check_failed`.

### Changing a classification rule

Issue tags and the phrases excluded from them, docket-entry labels,
legislative-action labels, the bill selection rule with its exclusion pattern,
the rule that finds conditions in bill text (`ca-cond-1`) and the rule that finds
sentences saying that a measure, or a part of it, remains in effect until a date
or an event and is then repealed (`ca-sunset-1`) are
regular expressions in `pipeline/dhq/classify.py` and the adapters. They are
published in `public/data/classification.json`, and the site shows the rule and
the matched text beside every tag, so a change is visible to readers. Before the
issue-tag rules read a court document, a word that the PDF broke across two lines
with a hyphen is joined (`join_line_hyphens` in `classify.py`, which keeps the
hyphen of a compound such as "three-judge"); the passage checks use the text as
extracted. Add a test in `pipeline/tests/` with a synthetic
example that the rule should match and one it should not, rerun the pipeline, and
review the tags that changed.

### Adding a source or a state

Open an issue first. A new source needs: a primary publisher, terms that allow
the use, a stable identifier for each record, an adapter with tests that use
synthetic responses, an entry in `pipeline/dhq/sources.py` with its coverage and
limits, and an honest statement of what it does not cover.

### Changing the data model

The model is defined twice: `src/types/schemas.ts` for the site and
`pipeline/dhq/schemas.py` for the pipeline. Change both, bump `schemaVersion` if
existing files would no longer validate, and update the tests on both sides.
`scripts/validate-data.mjs` uses the site's schemas, so a new kind of file under
`public/data/` must also be read there, or the check refuses it.

### Interface changes

Read [design/DESIGN_PLAN.md](design/DESIGN_PLAN.md) first. A few constraints are
not negotiable: colour marks the type of record and nothing else, red and blue
are not used for map fills, missing data is hatched and explained, every date
says what it is the date of, and the map is never the only way to reach a record.

## Style

- TypeScript: strict, no `any`, pure logic in `src/lib/` with unit tests.
- Python: type hints, one adapter per source, the network only through
  `pipeline/dhq/http.py`. A file whose name comes even in part from a source is
  written with `write_json` or `write_bytes_atomic` from `pipeline/dhq/util.py`,
  passing `root=` the folder it must stay in.
- Text in the interface: plain sentences, sentence case, no jargon where a plain
  word will do.
- Commits: say what changed and why. Data refreshes are committed separately from
  code changes.

## Licence

By contributing you agree that your contribution is licensed under the
[Apache License 2.0](LICENSE). The licence covers the code, the documentation and
the design files written for this project, not the upstream data; see
[NOTICE](NOTICE).
