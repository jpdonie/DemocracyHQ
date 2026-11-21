# DemocracyHQ

**Election litigation, voting laws and district boundaries, linked to their sources.**

DemocracyHQ is a free, open-source research tool that puts three kinds of public
record on one map: court dockets in election cases, election bills with their text
versions, and the official boundaries those cases and bills are about. Every record
links to the court, legislature or Census Bureau page it came from and says when it
was last checked.

It is a static website with no backend, no accounts and no tracking. A Python
pipeline retrieves the records from official sources and writes plain JSON; the
site reads that JSON.

> **Status: an early, working prototype.** It covers Congress and one state
> legislature, the Supreme Court and the federal courts of appeals. It is published at <https://democracy-hq.org/> by the deploy
> workflow (GitHub Pages); the scheduled data update has not yet run on GitHub. Read
> [Known limitations](docs/KNOWN_LIMITATIONS.md) before relying on anything here.

> **A data gap is not evidence of absence.** If a case, a bill or a count is not in
> DemocracyHQ, that means only that it is not in this dataset.

## What is in this release

| Module | What it holds today | Source |
| --- | --- | --- |
| Election litigation | 25 hand-picked U.S. Supreme Court dockets in election cases, with every docket entry, links to filed documents, the latest ruling entry and, where the docket links them, the questions presented | supremecourt.gov docket pages |
| Election litigation, courts of appeals | 128 election cases of the federal courts of appeals, selected by a published rule from the 27,813 cases GovInfo lists with a document issued since 2025, each with its opinion, where the appeal began and why it was selected | GovInfo, United States Courts Opinions |
| Election measures of Congress | 273 of the 20,191 measures of the 119th Congress, selected by a published rule, with their actions, the stage reached, every text version and a version comparison | GovInfo bulk data (Bill Status and Bills) |
| Courts | The Supreme Court and the thirteen courts of appeals, with the states and territories of each circuit as 28 U.S.C. § 41 lists them, drawn on the map | United States Code on GovInfo |
| California election legislation | 132 of the 5,041 measures of the 2025-2026 Regular Session, selected by a published rule, with official history, every text version and a version comparison | California Legislative Information bulk data |
| Redistricting | Boundaries for 56 states and state equivalents, 3,235 counties and county equivalents, and the congressional districts of the 119th Congress (441) and of the 120th Congress, elected in 2026 (441), with 2020 Census counts shown only on the lines they were tabulated for, or on a 2026 district that the Census Bureau reports as unchanged | U.S. Census Bureau |

Across the modules: a workspace for any place, a dated "What changed here?"
timeline of the docket entries and legislative actions that the published rules
mark as key, changed bill texts and boundary-file dates (1,475 events), 38 links
between cases, bills and places that each quote the passage supporting them, a
search box, a watchlist kept in your own browser, and a "legal source pack" export
as JSON, CSV or a printable page.

Figures are those of the data release generated on 2026-11-21. [The federal level](docs/FEDERAL_LEVEL.md)
describes the measures of Congress, the courts of appeals and the circuits. The site's
**Data and methodology** page gives the release date and each source's current
record count, and `public/data/manifest.json` holds the current totals.

## What it is not

- **Not legal advice**, and not a substitute for reading the source documents.
- **Not an official source.** It is not operated by any court, legislature or
  election office. The official record controls.
- **Not complete.** Coverage is deliberately narrow and is set out in full under
  **Data and methodology**. Ballot and election results are not tracked.
- **Not a voter tool.** It holds no voter records, makes no predictions and gives
  no voting guidance.
- **Not partisan.** It reports what records say and takes no position on any case,
  bill or map.

Every view ends with a note that DemocracyHQ is a research and educational tool,
not legal advice and not an official source, with a link to About and corrections.

The people it is built for are election-law attorneys, legal researchers,
reporters, academics, students and election officials. Naming them describes the
intended audience. No organisation uses, endorses or is affiliated with this
project.

## Quick start

Requirements: Node.js 22 (the version it was developed and tested with). The published data is in the repository, so the
site runs without the pipeline.

```sh
npm ci
npm run dev            # development server at http://localhost:5173
```

### Tests

```sh
npm run typecheck      # TypeScript
npm test               # unit tests (Vitest)
npm run data:validate  # checks the published data in public/data

npx playwright install chromium   # once per machine
npm run test:e2e       # builds the browser-test build in dist-e2e/, then runs the
                       # browser tests against it, served under a sub-path
```

The suites hold 337 unit tests in 24 files, 247 browser tests in 17 files (a
desktop project at 1366 x 768 and a phone project) and 708 pipeline tests.
[CONTRIBUTING.md](CONTRIBUTING.md#tests) says what each covers.

### Data pipeline

Requirements: Python 3.13 (the version it was developed and tested with; older
versions have not been tried), `pdftotext` and `pdftohtml` from poppler-utils on
the `PATH`, and the Node dependencies above (the pipeline uses the `mapshaper` binary that `npm ci`
installs).

```sh
python -m venv .venv && . .venv/bin/activate
pip install -r pipeline/requirements-dev.txt

npm run test:pipeline              # pipeline tests; synthetic data, no request leaves the machine
npm run pipeline                   # every stage, against the live sources
cd pipeline && python -m dhq.run scotus california congress circuits   # or only some stages
npm run data:validate
cd pipeline && python -m tools.verify_dockets        # re-read every published docket from the Court
cd pipeline && python -m tools.check_links           # request a sample of the external links
```

The workflows install the hash-locked `pipeline/requirements-lock.txt` and
`pipeline/requirements-dev-lock.txt` instead; [CONTRIBUTING.md](CONTRIBUTING.md#python-dependencies)
explains how to update them.

The pipeline keeps its downloads in `pipeline/.cache/` (about 820 MB after the
run of 2026-11-21, most of it the text of the court of appeals documents) and reads the large archives, including California's 1.3 GB
one, with HTTP range requests instead of downloading them whole. The pipeline
spaces its requests to supremecourt.gov at least 1.1 seconds apart, because the
Court's `robots.txt` sets a crawl delay of one second. No API key is needed. Two
optional sources can be switched on with keys; their records go to separate files
under `public/data/` (`litigation_secondary.json` and `legislation_secondary.json`)
for a maintainer to review, and the site does not display them. See
[`.env.example`](.env.example).

The pipeline writes to a staging folder, checks the staged cases, bills and links
against its data model, and only then replaces the files in `public/data/`. If
that check fails, nothing is published; if publishing itself fails, the published
data is left as it was. Anything uncertain is listed in
`pipeline/staging/review.json`. [CONTRIBUTING.md](CONTRIBUTING.md#what-a-pipeline-run-reports)
gives the exit codes and how the review queue is kept. `npm run data:validate`
then checks the whole dataset, including that `public/data/` holds nothing but
the `.json` files the data refers to.

Two hand-run tools check the result. Both need the network and are not part of
the test suites or of the scheduled run.

- `tools.verify_dockets` fetches the Court's docket page for each published docket
  again and reads all of it with its own class built on Python's HTML parser. The
  pipeline's adapter reads the page structure, and the links inside entry text,
  with regular expressions, and the filing links and the Questions Presented link
  with Python's HTML parser. The two share no project code except the HTTP
  client. The tool compares the docket number, both titles, the docketed date,
  every entry's date and text, and every document link. `--limit N` checks
  only the first N dockets. It exits non-zero on any difference or on a page it
  could not fetch. An entry the Court added after the last pipeline run is
  reported but does not count as a difference by itself (a document link in it
  does), so run the pipeline first.
- `tools.check_links` collects every address in `public/data/` except those inside
  mirrored bill text, groups them by host, and sends a HEAD request to an evenly
  spaced sample from each host, one request a second. `--sample N` sets the
  sample size per host (default 40, 0 for all) and `--host`, which can be
  repeated, limits the check to the hosts named. It never requests
  `leginfo.legislature.ca.gov`, which blocks automated clients, or the API hosts
  of the optional sources. It exits non-zero if any
  sampled address does not answer 200. A reachable address does not show that the
  page says what the record says.

### Production build and deployment

```sh
npm run build          # output in dist/, works from any sub-path
```

The Pages workflow type-checks the code, runs the unit tests and the data check,
builds the site, and opens every view of that build in a browser under a sub-path
before it publishes. A scheduled workflow runs the pipeline every day for the
dockets and the legislation and every Monday for everything, commits only the
validated `.json` files under `public/data/`, and redeploys the site when the data
changed. Built pages carry a Content-Security-Policy and a no-referrer policy as
meta tags: scripts, styles, fonts, data and the map's worker may come only from
the site's own origin, which on a github.io address the account's other GitHub
Pages sites share. Deployment to GitHub Pages is described in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md),
and the security policy in [SECURITY.md](SECURITY.md).

## Repository layout

```
src/                 the website (React, TypeScript, MapLibre GL JS)
  types/schemas.ts   the data model, validated at runtime with zod
  lib/               routing, data loading, search, diff, export, population joins
  features/          one folder per view
  components/        the map and shared interface parts
public/data/         the published dataset (written by the pipeline)
pipeline/            the data pipeline (Python)
  dhq/adapters/      one module per source
  seeds/             the hand-curated case list and link list, with their evidence
  tests/             pipeline tests (synthetic fixtures; a few also check the real seed files)
  tools/             hand-run checks: published dockets against the Court, and a link sample
tests/unit/          unit tests for the site logic (synthetic fixtures; a few also read public/data)
tests/e2e/           browser tests against the real build and dataset
scripts/             data validation and the sub-path test server
design/              design plan and the generative identity study
docs/                research, architecture, sources, validation, limits
.github/workflows/   CI, Pages deployment, scheduled ingestion
```

## Documentation

- [Product research](docs/PRODUCT_RESEARCH.md): the problem, existing tools, what was verified and what is assumed
- [Architecture](docs/ARCHITECTURE.md): how the site and the pipeline fit together
- [Data sources](docs/DATA_SOURCES.md): every source, its terms and its limits
- [Data validation report](docs/DATA_VALIDATION_REPORT.md): what was checked against the sources, and the results
- [The federal level](docs/FEDERAL_LEVEL.md): Congress, the courts of appeals and the circuits
- [Known limitations](docs/KNOWN_LIMITATIONS.md): what does not work, is not covered or is not verified
- [Deployment](docs/DEPLOYMENT.md): GitHub Pages, scheduled ingestion, secrets
- [Skill audit](docs/SKILL_AUDIT.md): which agent skills were actually used to build this, and how
- [Design](design/README.md): the design plan and the identity
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## How records are handled

- **Nothing is invented.** Case details, docket entries, bill text and counts are
  taken from the source. Where the source is silent the site says "not verified" or
  "unavailable".
- **The verification label says what was checked.** Every case, bill and link in
  this release is marked "Checked against the official source". For a case or a
  bill this means the record was retrieved from the official publisher, parsed
  without error and links to that source, and that it matches what the source
  published when DemocracyHQ last checked it. DemocracyHQ's own rule outputs
  (entry labels, issue tags, the latest-ruling entry, derived dates) and the link
  descriptions written by maintainers are not part of that check, and it does not
  mean a lawyer reviewed the record. For a link it means that the quoted passage
  was found in the cited document when that document was last fetched. The site
  shows this next to the label.
- **Dates say what they are.** The date something happened, the date the source
  published it and the date DemocracyHQ last checked it are kept apart. So are a
  bill's legislative status, its enactment, its effective date and whether a court
  has acted. An effective date that a rule derives from official data is labelled
  as derived. A sentence of the latest text saying that the measure, or a named
  part of it, remains in effect until a date or an event and is then repealed
  (rule `ca-sunset-1`) is quoted beside the effective date, as applying to the
  provision it names. An Assembly or Senate bill of the 2025-26 session still
  shown as pending in a release dated after August 31, 2026 carries a note on the
  constitutional deadline for passing bills, judged against the release date and
  never against the reader's clock.
- **Actions taken under an earlier subject say so.** When a bill's official
  subject line changed between versions, an action taken under an earlier subject
  says so ("Taken when the measure's subject was: …"), judged from the latest text
  version dated before the action. An action dated the same day as a new version,
  or one that adopted the amendments that changed the subject, is not marked,
  because the record does not say which text it concerned.
- **Text comparisons show only what changed.** The version comparison marks added
  and removed words. With the removals taken out it reads as the later version,
  and with the additions taken out as the earlier one, apart from white space.
  Removed and added paragraphs that do not correspond are listed as all the
  removals, then all the additions, not interleaved. Choosing the two versions in
  reverse order brings a note and a button that swaps them.
- **Opinions and orders whose address no longer works are not shown as links.**
  Each time the pipeline refreshes a docket, it asks the Court for each opinion or
  order linked inside a docket entry and fetches each document that the case's
  links and tags cite. A document of the docket whose address answered "not
  found" is then shown as its address in plain text, with the date of the check,
  and in an export its source is the docket page, with a note on the document's
  availability. Other links to filed documents are not checked on each run.
- **Every label has a rule.** Issue tags and event labels come from published
  keyword rules, and the matching text is shown. Where the rules miss the central
  subject of a case, a maintainer may add a tag, which is shown with a quoted
  passage that the pipeline checks. There are no confidence scores and no
  machine-written summaries.
- **What a record is about is quoted, not written.** Each row of a list says what
  the measure or case is about in the words of an official text, under the name of
  that text: the summary of the Congressional Research Service, a measure's
  official title, the Legislative Counsel's Digest, the Court's Question
  Presented, a passage cited from a document of the docket, or the opening of the
  opinion. A published rule takes each quotation (rules `about-*` in
  `classification.json`); it runs in whole sentences, and one that is cut says so
  with an ellipsis. A Supreme Court docket also shows the latest question an order
  of the Court put to the parties, under the question presented. The opening of
  an opinion is its first paragraph, read from the layout of the PDF, so that
  footnotes and page heads stay out of it. It is published only if every letter
  of it is then found in the plain text of the same file, with other matter
  between its letters only where it crosses a page. A record
  for which no rule finds a passage has none: 12 of the 128 court of appeals cases
  and 27 of the 273 measures of Congress, which are listed under their official
  title already. The words a selection rule matched are marked where they stand
  in a text the rule read (a title, the opinion; never a summary or a digest),
  and a measure listed under a title that does not say why it is here also shows
  the title the rule matched.
- **Links carry their evidence.** Every curated link (case to place, case to bill,
  bill to bill, bill to place) quotes a passage of a named primary document. The
  pipeline checks that the passage is in that document, and that a passage behind
  a link to a place names the place: a case's link to a place on every run that
  refreshes the docket, and any other link on every run that rebuilds the links
  with the cited text at hand. A link that fails is not published. If the
  document was not fetched in a run, a link already published keeps the date of
  its last check, and a new or edited link is not published. The check shows that
  the document says the words; it does not check the maintainer's description of
  the link. Passages are chosen under a written rule, kept in the seed files: the
  Court's own text or a sentence that describes the facts, never one side's
  account of another's position, and party labels applied alike.
- **Boundaries and counts state their vintage.** Counts are shown only on lines
  they were tabulated for, or on a 2026 district in a state the Census Bureau
  reports as unchanged, where the district's official land area agrees.

## Corrections

If a record is wrong, out of date or missing its source, please open an issue with
the "Data correction" template and include a link to the primary source. On the
deployed site every case and bill page has a "Report a correction" link that
fills in the record for you.

## Licence

The code, the documentation and the design files written for this project are
licensed under the [Apache License 2.0](LICENSE). The licence does not cover the
upstream data published under `public/data/`, which remains subject to the terms
of each source. See [NOTICE](NOTICE) and [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md).
