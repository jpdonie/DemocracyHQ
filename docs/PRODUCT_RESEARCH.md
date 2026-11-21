# Product research

Focused discovery carried out on 2026-11-20, before and during the build. This
document separates what was checked against a live source that day from what is
assumed. Where a claim is an assumption it says so.

## 1. The user problem

**Assumption, not evidence.** No user was interviewed. The problem statement below
comes from the project brief and from reading how existing tools present the same
records. It should be tested with real researchers before anything larger is built.

Someone researching an election-law question usually needs three kinds of record
at once:

1. what a court has been asked and what it has done (a docket);
2. what a legislature has passed and how the text changed (bill history and versions);
3. what area the dispute is about (a district or county boundary, and who lives there).

These records live on different official sites with different identifiers, and the
free tools that collect them tend to cover one of the three. The specific gaps
this project tries to close:

- A case page rarely links to the statute text it challenges, and a bill page
  rarely links to the case.
- Dates are easy to misread: the day a bill was chaptered is not the day it takes
  effect, and neither says whether a court has blocked it.
- Counts are often shown on boundaries they were not tabulated for, most acutely
  after a mid-decade redistricting.
- Trackers run by advocacy organisations describe outcomes in their own terms
  ("victory"), which a neutral researcher has to translate back.
- It is hard to tell how fresh a record is, or whether a missing record means
  "nothing happened" or "not collected".

## 2. Existing tools

Each row describes one page that was fetched and read on 2026-11-20. These are
observations of those pages, not full reviews of the projects, all of which do
valuable work that this prototype does not approach in breadth.

| Tool | What the page showed | What it did not show |
| --- | --- | --- |
| Democracy Docket, case page for *Tangipa v. Newsom* | Title, filed and decided dates, a category, a status of "Victory", a background section, a dated list of updates, case documents as PDFs | No court field or docket-number label, no map or district geometry, no link to the measure at issue. Reuse terms were not stated on the page. The status vocabulary reflects the publisher's position. |
| All About Redistricting (Loyola Law School) | Case numbers, a last-updated date, narrative case information, tables of filings; shapefile and GeoJSON downloads for state legislative maps | No links to bill text |
| Civil Rights Litigation Clearinghouse (University of Michigan), a case page | Docket number, filing date, status, a narrative summary, judges and attorneys, a documents table, a full docket with RECAP links | Not election-specific; no geography. Copyright University of Michigan. |
| Redistricting Data Hub | Precinct boundaries and election results, P.L. 94-171 data, legislative boundaries, CVAP and more, each with a ReadMe | A free account is required to download. Not a litigation or legislation tool. |
| Open States / Plural | An API (key required), bulk session files, monthly database dumps; data "provided under a public domain dedication" unless noted | Not a litigation or geography tool |
| CourtListener / RECAP (Free Law Project) | A REST API over federal dockets and opinions | Anonymous API requests were refused with HTTP 401, so a token is required. The RECAP Archive is not a complete mirror of PACER. |

Not examined in this pass, and therefore not characterised here: the Brennan
Center's trackers, the Voting Rights Lab, NCSL's election legislation database,
Ballotpedia, Dave's Redistricting, PlanScore and commercial services. A fuller
review should cover them.

## 3. Source feasibility

Each source was requested on 2026-11-20 from the build environment. "Verified"
means the request succeeded and the response was read.

| Source | Result | Consequence |
| --- | --- | --- |
| supremecourt.gov JSON docket files (`/RSS/Cases/JSON/{docket}.json`) | Verified. Returns the case title, docketed date, lower-court information, a link to the questions presented and every proceeding with its document links. However, the Court's `robots.txt` disallows `/rss/`, and the server does not distinguish letter case in paths. | Read by the pipeline until 2026-11-20, then no longer requested. |
| supremecourt.gov public docket pages (`/search.aspx?filename=/docket/docketfiles/html/public/{docket}.html`) | Verified. Not excluded by `robots.txt`, which sets `Crawl-delay: 1`. They give the same docket information and list filing links for older dockets that the JSON files omit. | The litigation module reads these pages, at least 1.1 seconds apart. |
| California bulk data (`downloads.leginfo.legislature.ca.gov`) | Verified. `pubinfo_2025.zip` is about 1.29 GB with more than 205,000 members and supports HTTP range requests. | The legislation module reads only the members it needs, by range request. |
| California public site (`leginfo.legislature.ca.gov`) | Blocked for automated clients (an interactive browser challenge, HTTP 403). | Not scraped and not worked around. Links to it are built from official identifiers and are followed by people, not by the pipeline. |
| Census cartographic boundary files, 2025 | Verified (published April 2026). No 2026 edition existed yet. | States, counties and 119th Congress districts come from here. |
| Census TIGER/Line 2026, 120th Congress districts | Verified (published November 2026). The Bureau's page says its Missouri files were regenerated as of November 10, 2026. | Used for the 2026 districts, clipped to the cartographic shoreline. Archives are downloaded again when the server's Last-Modified date or size changes, and by the first scheduled run of each week, which normally starts from an empty cache. |
| Census page on the 120th Congress districts | Verified. It names the nine states with new boundaries for 2026, says that all other states, the District of Columbia and Puerto Rico had no changes, and carries a note about Missouri. | The list of redrawn states is parsed from this page, and both sentences are required. |
| 2020 Census P.L. 94-171 files and the 119th Congressional District Summary File | Verified. | Population counts for states, counties and 119th Congress districts. |
| 2020 Census counts for 120th Congress districts | Not yet published; the Bureau's page announces a later release. | Redrawn districts show "Unavailable". Nothing is estimated. |
| Census Data API (`api.census.gov`) | Redirects to a "missing key" page without a key. | Not used. The bulk files need no key. |
| CourtListener API v4 | HTTP 401 without a token. | An optional adapter exists but has never run against the live API. |
| Open States API v3 | A key is required. | Same: optional, untested against the live API. |
| PACER | Paid. | Out of scope. Never accessed. |

### Terms and restrictions noted

- Census Bureau products and Supreme Court docket information are U.S. Government
  works. Documents filed by parties belong to their authors, so the site links to
  them and does not mirror them.
- California publishes legislative information for public access under Government
  Code § 10248. The bulk files carry a Legislative Counsel Bureau copyright notice,
  so the pipeline republishes extracted bill text with attribution and does not
  redistribute the source files. **This reading of the terms is the author's and
  has not been reviewed by a lawyer.**
- CourtListener describes its API access as intended for personal, educational,
  research, journalistic and exploratory use, with rate limits. Any production use
  should be checked against its current terms.

## 4. Differentiation

What this prototype does that the pages examined did not:

- **Joins the three record types through evidence.** A case is linked to a bill or
  a place, and a bill to a bill or a place, only by quoting a passage of a named
  primary document. Dockets are shown as related when the Court's docket lists
  them, or when they come from the same case below (published rule
  `same-lower-court-2`). The pipeline checks the passage again on every run that
  rebuilds the links with the document at hand (for a case's link to a place,
  every run that refreshes the docket), and does not publish a link whose passage
  is not found. If the document was not fetched, a link already published keeps
  its last check and a new link is not published. The check covers the words, not
  the maintainer's description of the link.
- **Separates the four answers about a law**: legislative status, enactment,
  effective date and judicial activity, each with its own source and caveat.
- **Refuses to show counts on the wrong lines.** A district redrawn for 2026 shows
  "Unavailable" until the Census Bureau publishes counts for it.
- **Uses the source's own words for outcomes.** Docket entries are quoted. There
  is no "win" or "loss" and no overall case status.
- **States freshness and method on every record**, and publishes every
  classification rule.
- **Is static and open**, so anyone can host a copy, inspect the data files and
  rerun the pipeline.

What it does **not** do better than the tools above: breadth. They cover hundreds
or thousands of cases, many states and many years. This covers 25 dockets in one
court and one state's current session.

## 5. Risks

| Risk | Why it matters | What is done about it |
| --- | --- | --- |
| A wrong legal characterisation | A researcher may rely on it | Entries are quoted, labels come from published rules, the matched text is shown, and nothing derives an overall status. Still unreviewed by a lawyer. |
| Narrow coverage read as completeness | "No case listed" could be read as "no litigation" | Every view except the overview ends with a footer saying that a data gap is not evidence of absence; the overview says so in a notice of its own. The same notice appears in lists, empty states and exports. |
| Curation bias | The case list and the passages behind links are hand-picked | The seed list and its evidence are in the repository; the Sources page says the list is curated. Passages are chosen under a written rule in the seed files: descriptive text or the Court's own text, no sentence in which a Justice or party characterises another's position, and party labels applied alike. |
| Upstream formats change | Parsers break | Each stage fails safely and keeps the data of its last successful run; staleness is shown. |
| Stale data presented as current | Dockets move daily | Every source has a staleness limit, calculated in the reader's browser. |
| Keyword rules mislabel | Tags and bill selection are rule-based | The rule and the matched text are shown beside each tag. |
| A contingent, delayed or expiring operative date | "Effective" can mislead | Sentences in which a measure makes itself or part of itself conditional are found by a published rule (`ca-cond-1`) and quoted beside the date, and so are sentences in which it, or a named part of it, remains in effect until a date or an event and is then repealed (`ca-sunset-1`). Whether a condition was met is not recorded, ballot results are not tracked, and a sentence worded differently is missed. Delayed operative dates are not extracted. |
| Scheduled automation unproven | The scheduled ingestion has not yet run on GitHub | Stated in the deployment guide; treat the first runs as a test. |
| Single maintainer | Curated links need review | Every curated link and tag quotes its evidence so that others can check it, and the pipeline checks that the passage is in the cited document on every run that rebuilds the links with that document at hand; a link whose document was not fetched keeps its last check. The maintainer's description is not checked by machine. |

## 6. Evidence and assumptions

**Checked on 2026-11-20:** every row in section 3; the observations in section 2;
the figures and record details in the published dataset, to the extent described
in the [data validation report](DATA_VALIDATION_REPORT.md).

**Assumed, not verified:**

- that the audiences named in the brief have the problem described in section 1;
- that a map is the right primary way into these records for them;
- that the selection of 25 dockets is representative of what a researcher wants first;
- that the reading of each source's terms in section 3 is correct;
- that the site performs acceptably on real networks and devices (it was measured
  only on the build machine).

## 7. Scope of this release

Built and working on the build machine: the three modules as described in the
README, the place workspace, the timeline, links with quoted evidence, search, the
watchlist, the export, the methodology page and the pipeline with tests. The
workflows are written but have not yet run on GitHub, and the site has not been
deployed.

Deliberately deferred:

- lower federal courts and state courts (needs CourtListener or PACER and a
  reviewed approach to docket completeness);
- more states' legislation (needs per-state official sources or a reviewed
  secondary source);
- state legislative districts, precincts, and ballot and election results;
- population for 2026 districts (waiting on the Census Bureau);
- citizen voting-age population and ACS estimates (different vintages and margins
  of error need careful presentation);
- alerts, accounts, saved searches, comments;
- any analysis of plans (compactness, partisan measures), which would move the
  tool from reporting records to drawing conclusions.

## 8. Adoption

No testimonial, user count, logo or endorsement exists, and none is shown. Ideas
that could be tried later, none of which has been tried:

- ask two or three election-law clinics or newsroom data desks to attempt a real
  research task with it and record where they get stuck;
- publish the dataset schema so other projects can consume the JSON;
- add a second state chosen for the contrast in its bulk-data offering;
- measure whether the source pack export is used, without adding tracking, by
  asking testers.
