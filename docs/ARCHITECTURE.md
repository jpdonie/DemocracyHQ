# Architecture

DemocracyHQ is two programs that meet at a folder of JSON files.

```
 official sources                 pipeline (Python)                  site (static)
+---------------------+     +---------------------------+     +----------------------+
| supremecourt.gov    | --> | adapters: fetch, parse    |     | React + TypeScript   |
| CA bulk legislative | --> | classify by published     | --> | checks every file    |
| Census boundaries   | --> |   rules                   |     |   it loads           |
| Census 2020 counts  | --> | check links against the   |     | MapLibre GL JS map   |
+---------------------+     |   quoted evidence         |     | hash router          |
                            | validate, then publish    |     +----------------------+
                            +------------+--------------+                ^
                                         |                               |
                                         v                               |
                                  public/data/*.json  -------------------+
                                  (committed to the repository)
```

There is no server, database or API of our own. GitHub Actions runs the pipeline on
a schedule, commits the changed JSON and redeploys the site to GitHub Pages.

## Why static

- The records are public and change at most a few times a day, so a build step is
  enough.
- A static site can be hosted anywhere, mirrored and archived, and its data files
  can be read directly by other projects.
- There is no server-side code and nothing to log: no accounts, no cookies, no
  analytics. The built pages carry a Content-Security-Policy that lets them load
  and request only files from the site's own address.
- API keys stay in the pipeline. Nothing secret is ever built into the site.

## The published dataset (`public/data/`)

| File | Contents |
| --- | --- |
| `manifest.json` | When the release was generated, record counts, per-source status, size of the review queue, and a SHA-256 hash over every other published file |
| `sources.json` | Every source: publisher, licence, coverage, limits, update cadence, last attempt, last successful check, staleness limit, a hash of the files that hold its records, and a status detail such as the number of links found dead |
| `classification.json` | Every keyword rule that assigns an issue tag (with its exclusion pattern, where it has one) or an event label (for docket entries, with what the entry rules on), and a description of every other rule: dockets and places (`cases-seed-2`), related dockets (`same-lower-court-2`), links (`rel-seed-2`), curated tags (`tag-curated-1`), bill selection (`ca-select-2`), conditions (`ca-cond-1`) and repeal clauses (`ca-sunset-1`) in bill text, and changed text versions (`diff-meta-1`) |
| `courts.json` | Courts that appear in the dataset |
| `litigation/index.json`, `litigation/cases/{id}.json` | Case summaries, and one file per docket with every entry, every document link with its availability, the questions presented where the docket links them, and the related dockets |
| `legislation/index.json`, `legislation/bills/{id}.json` | Bill summaries with the selection rule, its patterns and the number of Regular Session measures it was applied to, and one file per bill with its history, its versions (each with its own subject line), and any conditions and repeal clauses quoted from its text |
| `legislation/text/{version}.json` | The text of one version as paragraphs, with a SHA-256 hash |
| `relationships.json` | Links between cases, bills and places, each with its quoted evidence |
| `events.json` | Key dated events for the timeline: the docket entries and legislative actions the rules mark as key, each changed text version, and Census boundary-file dates |
| `geo/*.topo.json`, `geo/index.json` | Boundaries as TopoJSON, and an index of every unit with its name and bounding box |
| `geo/county_cd119.json` | Which counties each 119th Congress district overlaps, with the Bureau's land and water area of each part |
| `population/{state,county,cd119}.json` | 2020 Census counts by GEOID, with the Bureau's variable codes and labels |
| `redistricting.json` | Which states have new congressional boundaries for 2026 and the Bureau's statement that all others are unchanged, both quoted from the Census Bureau, and a land-area check of the unchanged districts |
| `government.json` | Who holds office: for the United States and each of the fifty states the executive (name, party, the day the current term began), each chamber with its number of seats, the members a source lists by party label and group, the vacant seats, the party with more than half of the seats, and which party holds the government under rule `party-trifecta-1`. Every part names its source and the day it was read |
| `state-legislation/index.json`, `state-legislation/<state>.json` | The election measures of the other state legislatures, read from Open States: the index the lists read, and one file per state with each measure's actions, sponsors and text versions, which its page reads |

Nothing else may be in the folder. `scripts/validate-data.mjs` lists the whole
tree and fails on any file that is not a `.json` file the data refers to, because
the site serves `public/data/` as it is.

Geographic units are keyed by layer and Census GEOID: `state:06`, `county:06037`,
`cd119:0612`, `cd120:0612`. The two congressional plans are separate layers with
separate keys, because the same district number can describe different areas.

## The data model

The types live in [`src/types/schemas.ts`](../src/types/schemas.ts) (zod) and are
mirrored in [`pipeline/dhq/schemas.py`](../pipeline/dhq/schemas.py) (pydantic). The
pipeline checks the case, bill and relationship records against the pydantic
models before it publishes, and `scripts/validate-data.mjs` checks the whole
published dataset against the zod schemas. The site validates again when it loads
a file, so a malformed file produces an error message in one panel instead of
wrong content. A California bill id names the bill's file, so both schemas accept
only the form `ca-<8-digit session>-<type><number>` (for example
`ca-20252026-ab604`).

Two ideas run through every type.

**Dates are never bare.** Each date field has one meaning:

| Field | Meaning |
| --- | --- |
| an event's `date` | when the thing happened, as the source states it |
| `sourcePublishedAt` | the date the source gives for the file it published (for Census files, the server's Last-Modified date) |
| `retrievedAt` / `lastCheckedAt` | when the pipeline last fetched and checked it |
| `firstObservedAt` | when the pipeline first saw the record |
| `versionDate`, `approvedDate`, `chapteredDate`, `effective.date` | separate legislative dates; `effective` also records its basis: `not_verified`, `immediate_effect_flag` (a date derived by rule from the official immediate-effect flag, labelled as derived), `not_enacted`, or `not_applicable` (resolutions); `stated_in_text` is defined but not yet used |
| `expiryClauses[].date` | the calendar date a repeal clause states, or null when the clause names an event instead |

Some other fields need a word of explanation:

- `conditions` and `expiryClauses` on a bill are sentences quoted from its latest
  mirrored text, each with the version id and the rule id. A condition (rule
  `ca-cond-1`) is a sentence in which the measure, or a named part of it, takes
  effect only if, when, upon or after something happens. An expiry clause (rule
  `ca-sunset-1`) is a sentence in which it, or a named part of it, remains in
  effect until, or only until, a date or an event and is then repealed. A clause
  applies to the provision the sentence names, and only if the measure is
  enacted.
- `subjectInForce` on a bill's timeline event is the official subject line of the
  latest text version dated before the action. It is null when no version is
  dated before it, when a version is dated the same day (the record does not say
  which text the action concerned), or when the action adopted amendments. The
  site compares it with the current subject line, so that a vote taken before a
  bill's subject was replaced says which subject it was taken on.
- `rulesOn` on a docket-entry rule in `classification.json` says what a matching
  entry rules on: `case` (the case or petition itself), `application` (a stay, an
  injunction or another request addressed to a Justice), `review` (whether the
  Court will hear the case), or nothing. A docket's `latestDispositiveEntry` is
  the latest entry that rules on the case or, where there is none, the latest
  ruling on an application. An entry with `review` is never chosen.
- A court document's `availability` is `unavailable` when the address the
  Court's docket gives answered 404 or 410, and its `accessNote` gives the date
  of that check.

**Verification is a stated fact about method, not a score.** Every record carries
a status and the method that produced it.

| Status | Meaning |
| --- | --- |
| `verified_primary` | Shown as "Checked against the official source". The record was retrieved from the official publisher and parsed without error, and it links to that source; it matches what the source published at the last check. DemocracyHQ's own rule outputs (entry labels, issue tags, the latest-ruling entry, derived dates) and the link descriptions written by maintainers are not part of that check. On a link, the status means that the quoted passage was found in the cited document when that document was last fetched. It does not mean a lawyer reviewed it. |
| `imported_secondary` | Taken from a non-official aggregator and not compared with the primary source. No record in this release carries it. |
| `awaiting_review` | An automatic check could not be completed and a maintainer has not yet looked at the record. Defined but not yet used: nothing assigns it. Curated links never carry it: a link whose passage is not found is not published at all. |
| `disputed` | A specific problem has been reported and not yet resolved. Defined but not yet used: nothing assigns it, and reporting a correction does not change a record's status. |
| `outdated` | The source has changed since the record was captured. Defined but not yet used. |
| `unavailable` | DemocracyHQ does not have this information. A gap, not a statement that nothing exists. |

| Method | Meaning |
| --- | --- |
| `automated_primary_retrieval` | Retrieved automatically from the official source and parsed without error |
| `automated_secondary_import` | Imported automatically from an aggregator |
| `rule_derived` | Produced by a published rule and checked against the cited text |
| `maintainer_curated` | Written by a maintainer; the quoted passage was found in the cited document when it was last fetched |
| `manual_review` | Compared with the primary source by a maintainer |

Every curated link in this release carries `maintainer_curated`. Curated links
published before that method existed carried `rule_derived`, which both schemas
still accept. The site's Data and methodology page shows the same definitions,
and marks the states that nothing assigns as defined but not yet used. There are
no confidence percentages anywhere.

## The pipeline (`pipeline/dhq/`)

`python -m dhq.run [stage ...]` runs the named stages in the order given, or, with
no names, all of them in this order:

| Stage | What it does |
| --- | --- |
| `geo` | Downloads a Census boundary archive again when the server's Last-Modified date or size has changed (and refuses a download whose size differs from the one announced, or that is not a ZIP archive), builds the four TopoJSON layers with mapshaper (each simplified for display, as its vintage string says), writes the county and district pairs with the Bureau's land and water area of each part, reads the Census page's sentence that lists the redrawn states and its sentence that all other states had no changes, and compares the land areas of districts in the states not listed as redrawn |
| `population` | Reads 2020 Census P.L. 94-171 files and the 119th Congressional District Summary File |
| `scotus` | Fetches the Court's public docket page for each docket in `seeds/cases.json`, at least 1.1 seconds apart, labels entries by rule, fetches the questions presented and the documents the seeds cite, tags the case by rule, checks each curated link and tag against its document, asks the Court for each opinion or order linked inside an entry and publishes those that answer 404 or 410 as unavailable, and pairs dockets that come from the same lower-court case (rule `same-lower-court-2`) |
| `california` | Reads the Legislature's bulk archive by HTTP range request, selects Regular Session election measures by rule `ca-select-2` and counts the Regular Session measures it was applied to, and builds histories, versions, paragraph-level differences, issue tags and the conditions and repeal clauses quoted from the text by rules `ca-cond-1` and `ca-sunset-1` |
| `courtlistener` | Needs `COURTLISTENER_API_TOKEN`. Keeps the list of candidate decisions month by month in `decisions/scan.json` (the two newest months on every run, then the months not read yet, then the month read longest ago, at most 360 search requests a run at fifteen a minute, since the token is allowed twenty a minute and a thousand an hour; a full reading of the months since January 2024 takes about 220), reads the files of the decisions from CourtListener's storage, which has no such limit, applies the selection rule of the courts of appeals and the rule for the opening of an opinion, and publishes the selected cases under `decisions/`. A month that the requests left cannot finish is left for the next run, and a 429 answer ends the reading without a retry. It then reads the dockets of voting cases in the federal district courts from the RECAP Archive (`cl_dockets`, rule `docket-select-1`): one search for the dockets filed since 2024 with the clerk's nature of suit 441, then the entries of each docket, twenty a request, at most 300 further requests a run (`DHQ_CL_DOCKET_REQUESTS`) at the same pace. A docket never read comes first; one that CourtListener has not changed since it was read costs no request; one the run does not reach keeps its published record or waits. A case whose docket the archive holds is published from the docket (`docketType` "recap") under the same id as from its decisions. A failure of the dockets never stops the stage: the dockets published before are kept. Without a token it records `credential_missing` and publishes nothing |
| `openstates` | Needs `OPENSTATES_API_KEY` for the list of sessions (two requests). Reads the archive of every session since 2025 of the state legislatures but California's by HTTP range requests, table by table, and again only when Open States publishes a new archive (the reads are kept in `pipeline/.cache/openstates/`). Applies rules `state-select-1`, `state-status-1` and `secure-link-1`, and writes `state-legislation/`. A state whose list would shrink by more than a quarter at once keeps its published list for review. Without a key it records `credential_missing` and does nothing else |
| `government` | Reads the Senate's and the Clerk of the House's lists of members, the governors' pages of the National Governors Association and Open States' list of the current legislators of each state, counts the members of each chamber by party label (rule `party-group-1`), sets them against the number of seats in `seeds/chambers.json` (rule `party-seats-1`) and works out which party holds each government (rule `party-trifecta-1`). Each of the four sources stands on its own: when one cannot be read, what was published from it before is kept with the day it was read, and the source is marked `failed` |
| `relationships` | Checks the passage of each link in `seeds/relationships.json` when the run has the cited text (see Failure safety), adds these links to the case-to-place links from the `scotus` stage (or to the published ones that the seeds still list unchanged, if that stage did not run or failed), and drops any link whose ends do not resolve |
| `events` | Builds the timeline from the records above: key entries and actions only, each changed text version, and the boundary-file date of each redrawn state; each bill action carries its `subjectInForce` |

When `geo`, `scotus` or `california` runs, `relationships` and `events` always run
after it. Then, always: **validate** the staged case, bill and relationship records
against the pydantic models, and check that each bill id has the expected form,
that each bill's text files exist and that no staged text file is left without a
bill version pointing at it; then **publish**. The whole published dataset is
checked afterwards by `npm run data:validate`, which the scheduled workflow runs
before it commits and the deploy workflow runs again before it builds.

### The federal level

The stages `congress` and `circuits` (adapters `adapters/congress.py`,
`adapters/bill_text.py`, `adapters/uscourts.py`) write `congress/` and `circuits/`
under `public/data/`, and the `geo` stage writes `geo/circuits.json` and the circuit
and nation layers. Their rules, seeds (`seeds/circuit_exclusions.json`,
`seeds/tag_removals.json`) and retrieval are described in
[FEDERAL_LEVEL.md](FEDERAL_LEVEL.md). On the site, `src/lib/courts.ts` and
`src/lib/bills.ts` hold the fixed names of the fourteen courts and the order of the
stages of a measure; `npm run data:validate` compares both with the data.

### Who holds office

The stage `government` (adapter `adapters/officials.py`, rules in `government.py`)
writes `government.json`. It needs no key. Three rules, published with the others
in `classification.json`, decide what the site may show in a party's colour:

- `party-group-1`: which label of a source counts with which party. "Republican"
  and "Democratic" count as such, a label that names several parties
  ("Democratic/Working Families") counts with the one named first, and the
  Democratic-Farmer-Labor Party and the Democratic-Nonpartisan League Party count
  as Democratic. An independent stays an independent whichever party they caucus
  with. The count under each label as the source wrote it is published too.
- `party-seats-1`: a chamber is a party's when its members hold more than half of
  all the seats of the chamber, vacant seats included. The number of seats comes
  from `seeds/chambers.json`, not from the list of members. For the House of
  Representatives the majority is the one the Clerk states in the list. A list
  with more members than the chamber has seats gives no majority, and the state
  goes to the review queue (`chamber_size`).
- `party-trifecta-1`: a government is a party's when the executive and every
  chamber are that party's, and `divided` otherwise. It is `undetermined` when no
  executive was read, a chamber is missing, a list does not fit the seats, or the
  members are elected without party labels (the Nebraska Legislature).

The pipeline decides; the site only puts the record into words. `src/lib/government.ts`
works the rules out a second time from the published parts (`controlOf`,
`leadBySeats`), and `npm run data:validate` fails when the two disagree, when the
party figures do not add up to the members, or when the file holds anything other
than the United States and the fifty states. `src/components/WhoGoverns.tsx` draws
the block on the page of a state and of the country and the count on the overview,
and `partyControlTheme` in `src/lib/mapTheme.ts` colours the states. Red and blue
are used for this and for nothing else on the site, and every part also names its
party in words. The colouring is the query value `shade=party`, which `mapQuery` in
`src/lib/router.ts` carries from place to place.

### Failure safety

- Each stage runs in isolation. If one raises, the files it staged are
  discarded, so nothing from that stage is published and the `relationships` and
  `events` stages read the published files instead. Its sources are marked
  `failed`, their last successful check keeps its earlier date (so the site shows
  the data as stale), and the other stages continue.
- Within the California stage one bill that cannot be rebuilt does not fail the
  others; its last published record is kept and it is listed in the review queue
  (`bill_failed`). That includes a bill table row whose session year, measure type
  or measure number does not have the expected shape: no id or file is made from
  it. If not one selected bill could be refreshed, the source is marked `failed`.
  A bill that leaves the selected set is listed as `bill_left_selection`; if more
  than 10% of the published bills would leave at once, the stage fails and the
  previous set stays published.
- If a rebuilt record is smaller than the published one, the published record is
  kept and the drop is flagged for review (kind `regression`). For a docket the
  counts compared are its entries, its documents, its questions-presented link
  and their text (not compared when that document could not be read in the run);
  for a bill, its versions, its mirrored texts and its history actions. Any count
  that drops holds the record. A shrinking record is far more likely a truncated
  response than a real change.
- A curated link or tag whose passage is not found in its document is not
  published, and is listed in the review queue (`evidence_check_failed`,
  `curated_tag_check_failed`). There is no intermediate state.
- A docket that cannot be refreshed keeps its last published record, and the
  case-to-place links published with it are kept only if the seed still lists
  them unchanged; they are not checked again in that run. The source is marked
  `failed` only when no docket could be refreshed. A cited document that cannot
  be retrieved does not stop its docket from being refreshed: each link or tag
  that cites it keeps its last published check if the seed is unchanged, and is
  otherwise not published; the review queue lists the document
  (`document_unavailable`) with how many of each. If not one cited document could be
  read in the run, the source is marked `failed`. A link in
  `seeds/relationships.json` whose evidence document was not fetched in
  this run keeps its last published record, including the date it was last
  checked, only if its quoted passage, scope and cited document are unchanged;
  otherwise it is not published and is listed as `evidence_unavailable`. Two
  links produced with the same id fail the `relationships` stage.
- If the Census page that lists the redrawn states cannot be read, the last
  published list is kept and the page's source is marked `failed`. If new 120th
  Congress boundary files arrived in the same run, the whole geography stage fails
  instead, so the previous boundaries and the previous list stay published
  together.
- A case or bill whose last successful check is older than its source's staleness
  limit (7 days for dockets, 10 days for bills) is listed in the review queue
  (`stale_record`) and, when its source ran, counted in the source's status
  detail.
- Validation failure publishes nothing at all.
- **Publishing** builds the complete new release in `public/.data.incoming`: a copy
  of the published tree, in which the folders and files of the stages that
  succeeded replace theirs, with the rule list, the source register and the
  manifest written last. Only then are the folders swapped: the published tree is
  renamed to `public/.data.previous`, the new tree takes its place, and the old one
  is removed. A failure before the swap leaves the published tree as it was; a
  failure of the second rename puts the old tree back; and a run killed in the
  middle is cleaned up at the start of the next run.
- **Exit codes:**
  - `0`: no stage raised, no source was marked `failed`, and no record is stale.
  - `1`: the rest was published, but at least one stage raised, or a source was
    marked `failed` without its stage raising (for example when no docket could
    be refreshed, or the Census page that lists the redrawn states could not be
    read), or a record is stale.
  - `2`: the pipeline's own validation failed and nothing was published. It is also
    given when `DHQ_NOW`, where it is honoured, is not a full UTC timestamp.
  - `3`: publishing failed; the published data was left as it was.
  - `4`: the pipeline did not run its stages: its arguments were not accepted (an
    unknown stage or option), it could not be loaded (for example a missing
    package), or an unexpected error stopped it outside its stages. Nothing new
    was published. `--help` exits `0`.

  A source marked `credential_missing` does not count as failed. When the run
  published, its last log line reads `dhq.run INFO published to ...`; the
  scheduled workflow looks for it before it reads exit code 1 as a partial
  failure, because Python itself also exits 1 when it cannot start the pipeline.
- **The review queue** (`pipeline/staging/review.json`) holds the items this run
  raised, each with its kind, record, detail, time and stage, together with the
  earlier items of stages that did not run or that raised, which still describe
  their published files. An earlier item gives way to this run's item of the same
  kind and record. Items that a stage raised before it failed describe data that
  was discarded: they are kept beside the queue, marked `notPublished`, and are not
  carried into the next run. After exit code 2 or 3 the file holds this run's
  items, marked the same way, beside the earlier queue. The file is written before
  validation, so a run that fails validation or publishing still leaves it. The
  manifest gives the number of items in the queue, without the marked ones.
- `DHQ_NOW` pins the clock for tests. It is honoured only under pytest or when
  `DHQ_ALLOW_NOW=1` is also set, so that a value left in `.env` cannot back-date a
  real run; otherwise it is ignored with a warning.

### Retrieval

[`http.py`](../pipeline/dhq/http.py) is the only place that touches the network;
the hand-run tools use it too. Each stage that fetches anything has its own
`Fetcher`, which:

- spaces its requests, redirect hops included, by a minimum interval: 1.1 seconds
  for supremecourt.gov, whose `robots.txt` sets a crawl delay of one second, 1.5
  seconds for Open States, 1 second for CourtListener, and a fraction of a second
  for the Census and California bulk-file hosts;
- retries a network error and the statuses 408, 425, 429, 500, 502, 503 and 504, up
  to four times, with exponential backoff (1.5, 3, 6 and 12 seconds) or the number
  of seconds a `Retry-After` header gives, up to 120. It never retries any other
  status, so a 4xx response other than 408, 425 and 429 (for example 401, 403 or
  404) ends the request at once;
- gives each request a deadline of 15 minutes, retries and waits included. When it
  passes, the connections the request uses are shut down, whether a TLS handshake,
  the response headers or the body is under way, and the request fails as "not
  complete" without a retry. Each socket wait is also capped by the time left.
  Name lookups happen before a connection exists and are bounded only by the
  system resolver;
- streams each body and reads no more than a limit, 256 MB unless the caller sets
  a lower one; a response whose stated length is larger is refused before its
  body is read;
- follows redirects itself, at most five, and never reads a redirect's body. It
  does not follow one from https to plain http or to an address that is not a web
  address, and a request that carries a credential (an `Authorization`,
  `Proxy-Authorization`, `X-API-KEY` or `Cookie` header) follows one only to the
  same host and port over https. A refused redirect ends the request with an error
  that names the target's scheme and host but no header value, without a retry;
- accepts an answer to a range request only as a 206 whose `Content-Range` names
  exactly the range asked for (and, where the caller knows it, the file's size),
  and checks this before reading the body;
- identifies itself with a generic client name that an operator can replace with
  a contact address (`DHQ_USER_AGENT`). It never sends a browser-like identity and
  never works around a block.

[`remotezip.py`](../pipeline/dhq/remotezip.py) reads single members out of large
remote archives with range requests. It needs the server to offer byte ranges, and
a file whose size changes during the read is refused. A member whose directory
entry states more than 256 MB (64 MB for a bill text) is refused before it is
read; a member is never inflated beyond its stated size and must come out at
exactly that size, with a matching CRC-32; and a line longer than 1 MB ends a
line-by-line read. An archive's central directory is read whole, which the
archive's size bounds. A downloaded boundary archive is refused if its directory
states a member above 256 MB or more than 1 GB in all, and each member is
unpacked under its bare file name and must unpack to its stated size.

Downloads are kept in `pipeline/.cache/`. A cached California table or bill text
is used only if its size and CRC-32 match what the current archive's directory
gives for it, and the tables of other archive dates are deleted. A boundary
archive is downloaded again unless the server reports the same Last-Modified date
and size as when it was saved. Neither check is a check against tampering; see
[DEPLOYMENT.md](DEPLOYMENT.md) for how long the scheduled workflow keeps the cache.

### Curated inputs (`pipeline/seeds/`)

- `cases.json`: the dockets to track (rule `cases-seed-2`). For each docket, the
  places it concerns, each with a maintainer's note and a passage quoted from a
  named document of the docket, and any subject tags the keyword rules miss (rule
  `tag-curated-1`), each with a quoted passage.
- `relationships.json`: links from a bill to a bill or a place, and from a case
  to a bill (rule `rel-seed-2`), each with a note, a passage and the document it is
  quoted from.

These files are the editorial surface of the project. The `_readme` of each sets
the rule for choosing a passage: the Court's own text, the operative text of a
bill, or a sentence that describes the facts; never a sentence in which a Justice
or a party characterises another's position; and party labels applied alike to
comparable links. The pipeline tests also require the passage of each link from a
case to a place in `cases.json` to start with a capital letter or a digit, as a
sentence or a question does, apart from the passages of three dockets checked by
hand. A tag's passage and the passages in `relationships.json` are not tested this
way, and three of the latter begin inside a sentence.

[`evidence.py`](../pipeline/dhq/evidence.py) checks that each passage is in its
document, ignoring white space, hyphens and dashes, letter case and the style of
quotation marks, and reading Unicode compatibility characters (NFKC: ligatures,
superscript digits, full-width forms) as their plain forms. A case's links to
places and its tags are checked on every run that refreshes the docket. A link in
`relationships.json` is checked on every run of the `relationships` stage that has
the cited text: the bill's latest mirrored text, or a case document fetched in the
same run (see Failure safety for a document that was not fetched). `[…]`
separates parts that must appear in order, each at least 25 characters long
without white space, hyphens and dashes. A passage behind a link to a place must
also name the place (the state's name, the county's name, or "District N" or
"CD N"). Anything that fails is not published and is listed in
`staging/review.json`. The check shows that the document says the words. It does
not check the maintainer's note. [CONTRIBUTING.md](../CONTRIBUTING.md) gives the
field names.

### What a record is about

A list is useful only if each row says at once what the record is about. No line
is written for that. [`about.py`](../pipeline/dhq/about.py) quotes an official
text instead, and each record carries the quotation as `about`, with the text it
is from (`source`), where that text is published (`url`), the rule that took it
(`ruleId`) and whether it stops inside a sentence (`cut`). A Question Presented
can carry a further question that an order of the Court put to the parties
(`later`, with the date of the order), and the opening of an opinion says which
paragraph it is where the first could not be quoted (`paragraph`):

| Record | Text quoted | Rule |
| --- | --- | --- |
| Measure of Congress | The summary of the Congressional Research Service; without one, the official title, if the list shows another title | `about-crs-1`, `about-title-1` |
| California bill | The Legislative Counsel's Digest, from its first sentence that says what the bill would do | `about-digest-1` |
| Supreme Court docket | The Question Presented, followed by the latest question an order of the Court added; without a Question Presented, the passage cited for the docket's first link to a place; failing that, the entry that opens the docket | `about-question-1`, `about-cited-1`, `about-docket-1` |
| Court of appeals case | The first paragraph of the opinion the selection rests on | `about-opinion-1` |

A quotation runs in whole sentences until it is 220 characters long and never
beyond 560; a first sentence longer than that is cut at a word. A full stop after
an abbreviation does not end a sentence. The list of abbreviations cannot be
complete, so a short capitalised word before a full stop ("Tex.", "Cnty.") ends a
sentence only when the next word is one a sentence commonly begins with. An
ending missed that way makes a quotation one sentence longer; a wrong ending
would cut it inside a sentence without an ellipsis.

The opening of an opinion cannot be taken from the plain text of its PDF: at the
foot of a page the footnotes run into the body, and a footnote number sits in
the middle of a sentence. [`opening.py`](../pipeline/dhq/opening.py) reads the
layout instead (poppler's `pdftohtml -xml`, which gives every piece of text its
place and type size), drops page heads, footnotes and footnote marks, finds
where the opinion begins (after the line that names its author or its panel),
and takes its first paragraph. The words every order begins with are passed
over. A passage the court sets in from the margin, such as a clause of the
Constitution it quotes, ends the paragraph and is left out: it has no quotation
marks and would read as the court's words. The left edge of the text is the
leftmost edge several long lines begin at, so that a page filled by a set-in
quotation is still measured from the margin.

The passage is then checked against the plain text of the same file, which
another program reads (`pdftotext`): its letters must stand there one after the
other, with none left out. Other matter may stand between them only where the
passage crosses a page, because the plain text runs the footnotes and the page
head in there, and the layout says where those places are. A paragraph that
fails a check is not quoted: one that is too short, does not end with a
sentence, holds a remnant of a page head, holds a character of a wrongly mapped
typeface (some files give other signs for the joined letters "ff" and "ffi"), or
is not found in the plain text. The next paragraph is then tried, up to the
first heading and the fourth paragraph, and the quotation carries its number so
that the row can say "Paragraph 2 of the opinion". The layout of an opinion's
first pages is cached beside its text, so the file is fetched once more only for
the opinion of a selected case. When the layout cannot be read in a run, a
passage published before is kept only if it still stands in the plain text of
this run, whole or with the head of a page between its two parts.

The index entries also carry what shows why a record is listed: for a measure,
the words and the title the selection rule matched (`selection`), and for a court
of appeals case the four election phrases the rule found most often in the
opinion (`matchedTerms`). The site marks those words where they stand as whole
words, and only in a text the rule read: in a title of a measure, never in its
summary or digest, and in the opinion of an appeal.

### Classification

Issue tags, docket-entry labels, legislative-action labels, the bill selection
rule with its exclusion pattern, and the rules that quote conditions and repeal
clauses in bill text are regular expressions in
[`classify.py`](../pipeline/dhq/classify.py) and the adapters. The issue-tag,
docket-entry and legislative-action patterns are published in
`classification.json`, with a description of every other rule (the descriptions
of `ca-cond-1` and `ca-sunset-1` quote their patterns). The bill selection pattern
and its exclusion pattern are published in `legislation/index.json`.

The issue rules read a case's caption and its questions presented or, where a
docket has none, the full text of the document its seed names; and a bill's
subject line, title and Legislative Counsel's digest. In a whole document a rule
must be prominent (at least five matches, and at least 15% as many as the rule
that matches most often). Some rules leave text out:

- the digest's sentences about state-mandated local costs are not read;
- for the federal Voting Rights Act rule, only the digest's sentences that say
  what the bill would do are read, because a digest also names the federal act
  when it describes existing law;
- a match for the initiatives, referenda and recalls rule does not count inside
  its published exclusion pattern: campaign-finance phrases in which a committee
  or a payment supports or opposes a candidate or a ballot measure, and the words
  with which a digest says that an act the bill amends was itself adopted by
  initiative.

Before the rules read text taken from a PDF, a word that the document breaks
across two lines with a hyphen is joined again. The hyphen is kept where the
document also writes the same pair with a hyphen on one line, or where the first
part is one of the words listed in the classification note that begin compounds
(such as "well" or "three"). Quoted passages are still checked against the text as
extracted.

Each tag on the site shows the rule that produced it and the text it matched. A
curated tag shows its quoted passage instead. A tag's excerpt from a whole
document can come from a separate opinion (a concurrence or a dissent), and it is
not labelled with the part of the document it comes from. The pipeline never
derives an overall status for a case.

## The site (`src/`)

- **Routing.** A small hash router ([`lib/router.ts`](../src/lib/router.ts)).
  Every view, tab, filter, map layer and version comparison is in the address, so
  any state can be linked. Hash routing needs no server rewrite rules, which is
  what makes deep links work on GitHub Pages under a sub-path. The build uses
  relative asset paths (`base: './'`).
- **Data loading.** [`lib/data.ts`](../src/lib/data.ts) fetches a file once,
  validates it with zod and caches the result for the page; a failed load can be
  tried again. The manifest is always revalidated with the server. Every other
  file is requested with the release's hash in its address (`?v=`), so a browser
  or proxy cache cannot mix files of two releases. When a tab comes back into
  view, at most every five minutes, the site checks the manifest again and offers
  to reload if a newer release has been published. The TopoJSON boundary files
  get a structural check instead of a schema: the right type, the named object and
  at least one feature. The manifest, the source register, the geography, case
  and bill indexes, the links and the redistricting file load at start; the
  timeline loads with the views that show it; a case, a bill or a version text
  loads when opened; boundary layers load when shown.
- **The map.** [`components/MapView.tsx`](../src/components/MapView.tsx) draws the
  TopoJSON layers with MapLibre GL JS. There is no basemap and no tile server, so
  the map makes no external request; its worker is served from the site's own
  address. Shading is either a published count or a plain "has a linked record"
  class; units without data are hatched. The map stage is the night side of the
  site: the map reads its colours from the stage's own values of the colour
  tokens (`src/styles/tokens.css`), paints no water (the stage's ground shows
  through), fades a new colouring in and lays a wash of light over the unit under
  the pointer.
- **Two sides.** The top bar, the map stage and the title block of a page are
  dark; the reading panel is light. The dark side is the same token names with
  other values, scoped in `tokens.css` to the stage, the title block and the bar
  of the phone's sheet, on screens only. [`design/DESIGN_PLAN.md`](../design/DESIGN_PLAN.md)
  gives the reasons and the rules both sides keep.
- **Embedding.** [`lib/embed.ts`](../src/lib/embed.ts): with `?embed=1` before the
  `#` of an address the site is in its embedded form, for a frame in another
  page. The value is in the query, not in the route, so it stays while the reader
  moves inside the frame. The embedded form replaces the links to the watchlist,
  About and the repository by one link that opens the current view on the full
  site in a new tab. The About page gives the markup of a frame.
- **Views.** One folder per view under `features/`. The place workspace joins
  population, cases, legislation and the timeline for one geographic unit. Every
  view other than the overview ends with a footer that says the site is a research
  and educational tool, not legal advice and not an official source, and that a
  data gap is not evidence of absence, with a link to About and corrections. The
  overview has its own footer with a similar statement.
- **Focus and place.** After a move to another view, the panel returns to the top
  and keyboard focus goes to the view's heading once it is shown, unless the
  reader has meanwhile put focus somewhere else. On Back or Forward,
  [`lib/scrollMemory.ts`](../src/lib/scrollMemory.ts) and
  [`lib/focus.ts`](../src/lib/focus.ts) put the panel and the page back where the
  reader left them and focus the link they followed, or the heading if that link
  is gone. The places are kept in memory for each history entry and are never
  stored or sent. On very short, narrow screens (at most 899 by 300 CSS pixels,
  such as a laptop screen at 400% zoom) the page scrolls as one document, so the
  top and bottom bars cannot cover a focused control.
- **Content-Security-Policy.** The build adds two meta tags to `index.html`
  (`vite.config.ts`): a policy that allows scripts, styles, fonts, data, workers
  and the manifest from the site's own address only, images from it and from
  `data:` addresses, and no base URL, form target or plug-in; and a no-referrer
  policy. zod is set to `jitless` before any schema is made, so it never needs
  `eval`. A meta tag cannot set `frame-ancestors`; only a response header from the
  host can. The development server runs without the tags.
- **Test hooks.** The map object is exposed as `window.__dhqMap` only in the
  development server and in the browser-test build (`vite build --mode e2e`),
  never in the production build ([`lib/testHooks.ts`](../src/lib/testHooks.ts)).
- **Pure logic** (filters, search, diff, population joins, export, freshness) is
  in `lib/` with no dependence on the browser, which is what most unit tests
  cover.
- **The watchlist** is kept in `localStorage` and never leaves the browser. On a
  github.io address, other sites served from the same github.io address can read
  and change it, and the watchlist page says so.
- **Export.** [`lib/export.ts`](../src/lib/export.ts) builds the source pack from
  what is already on the page, as JSON, CSV (16 columns) and a print view.
  Population counts are exported with the Bureau's full variable labels and codes.
  An effective date derived by rule is labelled "Derived by rule from official
  data". Link rows carry their verification method and what the check covers.
  Bill rows name the official bulk archive as the checked source and give the
  `leginfo.legislature.ca.gov` page separately, as not machine-checked. A court
  document marked unavailable is never exported as a working link: its row points
  to the docket page and gives the dead address in a note. CSV cells that a
  spreadsheet would treat as a formula are neutralised.

## Tests

| Suite | Where | What it uses |
| --- | --- | --- |
| Unit | `tests/unit/` (Vitest) | Synthetic fixtures, labelled as such, on a reserved test domain (`example.test`), and the real published dataset in `public/data/`, which several tests read |
| Pipeline | `pipeline/tests/` (pytest) | Synthetic sources served by a fake HTTP session, and the real seed files in `pipeline/seeds/`. One test reads the official text of ACA 15 from the local source cache and is skipped when the cache does not have it. A few tests of the HTTP client talk to a server the test itself starts on 127.0.0.1; every other address fails the test, so no request leaves the machine |
| Browser | `tests/e2e/` (Playwright) | The browser-test build (the production build made in Vite's `e2e` mode, which adds the map hook) and the real published dataset, served under a sub-path with no rewrite rules. Every test fails on a console error, a failed request, an HTTP error or a request outside the sub-path. The deploy workflow runs the sub-path tests against the production build itself |
| Data | `scripts/validate-data.mjs` | The published dataset: schemas, references, sums and counts, and that `public/data/` holds nothing but the `.json` files the data refers to |
| Docket re-check | `pipeline/tools/verify_dockets.py` | The Court's live docket pages, read again and compared with what is published: docket number, titles, docketed date, every entry's date and text, and every document link. The adapter reads the page's structure with regular expressions and its document links with its own subclass of Python's HTML parser; the re-check reads the whole page with a separate subclass of the same parser. The two share no project code except the HTTP client. Needs the network, so it is run by hand and is not part of CI |
| Link sample | `pipeline/tools/check_links.py` | HEAD requests to an evenly spaced sample of the addresses in `public/data/` outside mirrored bill text, per host (40 by default), one request a second. It skips `leginfo.legislature.ca.gov` and the optional sources' API hosts. Run by hand, not part of CI |

Synthetic data exists only in the unit and pipeline fixtures and never reaches
`public/data/`.

## Automation (`.github/workflows/`)

- `ci.yml`: type check, unit tests, data validation, build and browser tests for
  the site; pytest for the pipeline. It runs on pull requests and on pushes to
  `main`.
- `deploy.yml`: on a push to `main`, by hand, or when the ingestion calls it:
  type check, unit tests, data validation and the build, then a browser smoke test
  of that build under a sub-path, and only then the upload to GitHub Pages.
- `ingest.yml`: runs the pipeline on a schedule in three jobs (a fourth only
  refuses a run started by hand from another branch). The `ingest` job,
  whose token can only read the repository, runs the pipeline and the schema check
  and hands the validated data on. The `commit` job alone can push: it takes only
  folders and `.json` files under `public/data/` (and the review queue), and
  commits only if `main` has not moved since the data was rebuilt from it. The
  `deploy` job calls `deploy.yml` when a change was committed. Exit code 1 counts
  as a partial failure, whose data is still committed, only when the log shows
  that the pipeline published.
- `.github/dependabot.yml`: weekly update pull requests for the actions, the npm
  packages and the pipeline's pinned Python packages.

See [DEPLOYMENT.md](DEPLOYMENT.md). The CI and deploy workflows have run on GitHub
since 2026-11-21; the scheduled ingestion workflow has not run there yet.
