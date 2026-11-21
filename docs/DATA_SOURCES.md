# Data sources

Every case, bill, boundary and count in DemocracyHQ comes from one of the sources
below. The links between records, and the tags that the keyword rules miss, are
written by maintainers, each with a passage quoted from one of these sources. The
other labels and tags come from DemocracyHQ's own rules, published in
`public/data/classification.json`. The same information about each source, with
the date of the last successful check, is published in `public/data/sources.json`
and shown on the site's **Data and methodology** page. The registry is
[`pipeline/dhq/sources.py`](../pipeline/dhq/sources.py).

The reading of each source's terms below is the author's and has not been reviewed
by a lawyer. If you redistribute the data, check the terms yourself.

## Active sources

### Supreme Court of the United States, public docket pages

| | |
| --- | --- |
| Publisher | Supreme Court of the United States |
| Address | Each docket's page, `https://www.supremecourt.gov/search.aspx?filename=/docket/docketfiles/html/public/{docket}.html`, which each case record links; the questions presented, and the opinions and filings that curated links and tags quote, as PDF files on www.supremecourt.gov at the addresses the docket gives. The registry (source id `scotus-docket`) gives the Court's docket search, `https://www.supremecourt.gov/docket/docket.aspx`, as the source's address. |
| Access | Public, no key. The Court's `robots.txt` sets `Crawl-delay: 1`. The pipeline and `tools.verify_dockets` space their requests at least 1.1 seconds apart; `tools.check_links` sends at most one request a second. |
| What is taken | Case title, docketed date, lower-court information, related dockets as the docket lists them, every proceeding with its date and text, links to filed documents, and the questions presented where the docket links them |
| What is not taken | The filed documents themselves. They are linked, never mirrored. Counsel's addresses, telephone numbers and e-mail addresses, which the docket page shows. |
| Coverage | 25 dockets listed by hand in `pipeline/seeds/cases.json`, all numbered 16- or later. Earlier dockets have not been tried. |
| Checked | Each docket on every pipeline run (scheduled daily). Marked stale after 7 days without a successful check. |
| Terms | The Court's docket pages, orders and opinions are U.S. Government works, not subject to copyright in the United States (17 U.S.C. § 105). The questions presented, shown in full, usually reproduce the words of the party that sought review, and the short passages quoted from filings are the filers' own words. Words written by a State or a private party are not U.S. Government works; they are shown for reference. Filings are linked, not mirrored. |

Limits: the list is curated, not complete, and the absence of a case says nothing
about whether litigation exists. Entry labels come from keyword rules. The
pipeline never derives an overall case status. Lower federal courts and state
courts are not covered. The record is read from the page's layout, so a change to
that layout stops the import until the reader is updated; the last published copy
stays published.

Each time it refreshes a docket, the pipeline asks the Court for each opinion or
order linked inside its entries. An address that answers 404 or 410 is published
as unavailable, with the date of the check, and the count is given in the
source's status detail in `sources.json` (5 in the release of 2026-11-20). The
case pages show such an address as text, not as a link, and the source packs
point the entry to the docket page and give the address in a note. A document
linked from a docket entry that a curated link or tag cites is marked the same way
when it answers 404 or 410. The questions presented are not one of the docket's
document records, so nothing is marked when their document answers 404 or 410.
Any other failure proves nothing about the address and leaves it as it was. Every
document fetched for its text that could not be retrieved or read is listed in the
review queue. Filing links are published as the docket gives them and are not
tested on each run. `tools.check_links`, run by hand, requests a sample of the
addresses on www.supremecourt.gov.

Dockets that come from the same lower-court case are shown as related when the
Court's docket pages give both the same lower court and a lower-court case number
for the same case (rule `same-lower-court-2`). A district court number is compared
without its letter case and leading zeros. Two different division numbers, or two
different sets of office letters, are two cases. Where one number has a division
number and the other office letters, or only one has a prefix, the judges'
initials after the number must be given on both and agree. Other numbers must
agree exactly, apart from letter case and spacing. The Court does not state this
relation; the rule derives it.

Issue tags come from the keyword rules published in `classification.json`,
applied to the case caption and the questions presented or, where a docket has
none, to the full text of the document its seed names, where a rule must match
often to count. Before the rules read text taken from a PDF, a word that the
document breaks across two lines with a hyphen is joined again, unless the
document also writes the pair with a hyphen on one line or the first part is one
of the words, listed in the classification note, that begin compounds. Quoted
passages are still checked against the text as extracted. An excerpt shown with
a tag can come from a separate opinion (a concurrence or a dissent) and is not
labelled with the part of the document it comes from.

### GovInfo (Government Publishing Office): Bill Status, Bills, United States Courts Opinions, United States Code

Four collections of GovInfo are read for the federal level: the Bill Status bulk
data and the Bills XML for measures of Congress, the United States Courts Opinions
collection for the courts of appeals, and the United States Code for the
composition of the circuits. [FEDERAL_LEVEL.md](FEDERAL_LEVEL.md) describes what is
read from each, the selection rules and their limits. GovInfo's content is the
work of the federal government and carries no copyright restriction of its own.
GovInfo can fail requests for hours at a time; the pipeline then asks again in
rounds and keeps the last verified record of anything it could not read.

### California Legislative Information, bulk data

| | |
| --- | --- |
| Publisher | Legislative Counsel of California |
| Address | `https://downloads.leginfo.legislature.ca.gov/` (`pubinfo_2025.zip`) |
| Access | Public, no key. Read by HTTP range request. |
| What is taken | Bill identity, subject, authors, the legislature's current status (`CURRENT_STATUS`, for example Chaptered, Vetoed, Died or In Committee Process) and, shown separately, the state of the latest text version (`MEASURE_STATE`), chapter, the full action history, every text version with its date and its own subject line, the text, the Legislative Counsel's digest and the official indicators such as the immediate-effect flag |
| Coverage | 2025-2026 Regular Session only (`SESSION_NUM` 0). Measures whose latest official subject line matches selection rule `ca-select-2` once the phrases of its exclusion pattern are removed. In the release of 2026-11-20, 132 of the 5,041 Regular Session measures in the bill table. |
| Checked | Daily. The source rebuilds the archive weekly and offers daily increments. Marked stale after 10 days. |
| Terms | Published for public access under Cal. Gov. Code § 10248. Bill text is a government edict. DemocracyHQ republishes extracted bill text with attribution and does not redistribute the CAML XML files, which carry a Legislative Counsel Bureau copyright notice. |

Selection rule `ca-select-2` matches election terms in the subject line. It counts
"initiative" and "recall" only in an electoral sense, and it includes campaign
finance, the Political Reform Act and candidacy. Its exclusion pattern leaves out
tax "water's-edge" elections and the Political Reform Act's lobbying and ethics
provisions. Both patterns are published in `legislation/index.json`
(`selection.pattern` and `selection.exclusionPattern`); `classification.json`
describes the rule in words. The number of measures the rule was applied to
(`selection.totalBillsInSession`) counts Regular Session measures only: the bill
table also lists 24 measures of the First Extraordinary Session, which the rule
does not select and which are not counted.

The history is ordered by date, sequence number and `BILL_HISTORY_ID`. An action
the legislature marks Rescinded or Reconsidered (`ACTION_STATUS`) is shown as such
and does not count as a key event. Each action shows the bill's location after
it. The Assembly records a bill's death under Cal. Const. art. IV, § 10(c) in its
own entry, and its later filing of the bill with the Chief Clerk under Joint Rule
56 is labelled a committee action, not a second death. The Senate records no
separate entry, so its return of a bill under Joint Rule 56 is labelled as the
death. Each version's subject line is published, so the site can say when an
action was taken while the bill had an earlier subject.

Effective dates: the source has no effective-date field. Each measure records the
basis for what is shown:

| Basis | Meaning |
| --- | --- |
| `not_verified` | Enacted, or for a constitutional amendment adopted by both houses, but no effective date is recorded in the official data. None is shown. |
| `immediate_effect_flag` | The official data flags the statute as taking immediate effect. The date shown is the chaptering date, derived by rule and labelled as derived. |
| `not_enacted` | Not enacted or not adopted, so there is no effective date. For a vetoed bill the note says whether the official history records that the veto stands; without such an entry it says that the bill is not enacted unless the Legislature overrides the veto, and that no override is recorded. |
| `not_applicable` | A resolution, which is not a statute. |

Rule `ca-cond-1` quotes sentences of the latest mirrored text in which a measure
makes itself, or a part of itself, conditional. Whether a condition was met is
not recorded, and a condition worded differently is not found.

Rule `ca-sunset-1` quotes sentences of the latest mirrored text in which a
measure says that it, or a named part of it ("This section", "This chapter"),
shall remain in effect until, or only until, a date or an event and as of that
date is repealed. Where the sentence gives a calendar date, the date is recorded;
where it names an event, none is. A clause applies to the provision the sentence
names, not necessarily to the whole measure, and only if the measure is enacted.
A sunset worded differently ("is repealed on", "becomes inoperative on") is not
found, and a later statute may have changed the date. In the release of
2026-11-20, 13 measures carry such clauses.

Issue tags come from the keyword rules published in `classification.json`,
applied to the subject line, the title and the Legislative Counsel's digest. The
digest's sentences about state-mandated local costs are not read. For the federal
Voting Rights Act rule, only the digest's sentences that say what the bill would
do are read. A match for the initiatives, referenda and recalls rule does not
count inside the rule's published exclusion pattern: campaign-finance phrases in
which a committee or a payment supports or opposes a candidate or a ballot
measure, and the words with which a digest says that an act the bill amends was
itself adopted by initiative. A tag can still rest on a passing mention; the text
it matched is shown with it.

Limits: a bill about elections whose subject line does not match the rule is
missed. Ballot and election results are not in the source; DemocracyHQ does not
track them and does not assert them. Operative dates written into a bill's text
are not extracted. Extraordinary sessions and earlier sessions are not ingested.
In bill text, table rows are flattened to cells separated by "|"; fractions (such
as "1 1/2") and the legislature's spacing elements are kept.

The public site `leginfo.legislature.ca.gov` blocks automated requests. It is not
scraped and the block is not worked around. Links to it are built from official
identifiers for people to follow and are not machine-checked.

### U.S. Census Bureau, 2025 Cartographic Boundary Files

| | |
| --- | --- |
| Address | `https://www2.census.gov/geo/tiger/GENZ2025/shp/` |
| What is taken | States and equivalents, counties and equivalents, congressional districts of the 119th Congress, at 1:5,000,000; the county-within-district file at 1:500,000 for overlaps, with the Bureau's land and water area of each part; the state file at 1:500,000, used as the shoreline for the 2026 districts |
| Vintage | Boundaries as of January 1, 2025. The server dates all five files in use April 23, 2026. |
| Checked | Annual release; checked weekly. Marked stale after 400 days. An archive is downloaded again when the server's Last-Modified date or size changes. |
| Terms | U.S. Government work (17 U.S.C. § 105) |

Limits: generalised by the Bureau for small-scale mapping and simplified again
for the web; each layer's vintage string says so. Not suitable for deciding where
a boundary legally lies. Connecticut appears as planning regions, which have no
2020 Census county counts. In the list of counties and districts that overlap, a
part with no land area or less than 1 km² of land is marked as such.

### U.S. Census Bureau, 2026 TIGER/Line Shapefiles, 120th Congressional Districts

| | |
| --- | --- |
| Address | `https://www2.census.gov/geo/tiger/TIGER2026/CD/` |
| What is taken | District boundaries for the 2026 election cycle, as collected by the Bureau from the states, with each district's official land area |
| Vintage | 2026 TIGER/Line release. The server dates every state file in use 2026-11-09 (UTC). The Bureau's page says it had first built some products, its TIGER/Line files among them, from a new Missouri plan, that those files were regenerated as of November 10, 2026, and that the Missouri plan remains unchanged from the one used in 2022 and 2024. Files downloaded before the regeneration are wrong for Missouri. The files in the release of 2026-11-20 were downloaded that day, and their Missouri districts pass the land-area check described below. |
| Checked | Annual release with corrections; checked weekly. Marked stale after 120 days. Each state's archive is downloaded again when the server's Last-Modified date or size changes. |
| Terms | U.S. Government work |

Limits: TIGER/Line polygons extend over water, so DemocracyHQ clips them to the
2025 cartographic shoreline and simplifies them. The result is a derivative for
display. Use the official files for analysis.

### U.S. Census Bureau, page on the 120th Congressional Districts

| | |
| --- | --- |
| Address | `https://www.census.gov/programs-surveys/decennial-census/about/rdo/congressional-districts.120th_Congress.html` |
| What is taken | The sentence naming the states that delineated new boundaries for 2026, the sentence saying that all other states had no changes, and the Bureau's note about Missouri, all quoted |
| Checked | Irregular; checked weekly. Marked stale after 30 days. |
| Terms | U.S. Government work |

Limits: the list is parsed from a sentence, and both sentences must be found. If
either is missing, the last published list is kept and the source is marked
failed. If new 120th Congress boundary files arrived in the same run, the whole
geography stage fails instead, and the previous boundaries and list stay
published together.

2020 Census counts for a 119th Congress district are shown on the 2026 district
with the same number only in a state the Bureau does not list as redrawn, and only
where the two districts' official land areas agree within 0.1%. In the release of
2026-11-20, 268 districts were compared and the largest difference was 0.019%.

### U.S. Census Bureau, 2020 Census Redistricting Data (P.L. 94-171)

| | |
| --- | --- |
| Address | `https://www2.census.gov/programs-surveys/decennial/2020/data/01-Redistricting_File--PL_94-171/` |
| What is taken | Total population, population 18 and over, and race by Hispanic or Latino origin (tables P1 to P4) for states and counties |
| Vintage | Census Day, April 1, 2020 |
| Checked | Static (decennial); checked weekly. Marked stale after 3,650 days. |
| Terms | U.S. Government work |

Limits: counts are for 2020 geography and are joined to 2025 boundaries by GEOID.
Where a county equivalent changed after 2020 (all of Connecticut), no count is
shown. 2020 Census statistics include noise from the Bureau's disclosure avoidance
system, so small counts are less reliable.

### U.S. Census Bureau, 2020 Census 119th Congressional District Summary File

| | |
| --- | --- |
| Address | `https://www2.census.gov/programs-surveys/decennial/2020/data/119th-congressional-district-summary-file/` |
| What is taken | The same counts, retabulated by the Bureau for the districts of the 119th Congress (tables P1, P9 and P11) |
| Vintage | Version of 2024-12-05 |
| Checked | Static; checked weekly. Marked stale after 3,650 days. |
| Terms | U.S. Government work |

Limits: these counts describe 119th Congress districts only, and the file has none
for the Island Area delegate districts. For the states that drew new districts for
2026 (nine in the release of 2026-11-20) they do not describe the new districts,
and the site does not show them there. The Bureau has not released the 2020
Census 120th Congressional District Summary File, so it has not yet tabulated
counts for redrawn districts.

The district page shows each district's difference from the state's average
district, computed from these 2020 Census counts. Some states balance districts on
an adjusted population base, so this figure is not a plan's legal deviation.

## Optional sources, off by default

Both need a key, both are secondary sources, and **neither has ever been run
against the live service**. Their adapters were exercised only with synthetic test
responses shaped like the documented APIs. What they import is published as a
separate file (`public/data/litigation_secondary.json` or
`public/data/legislation_secondary.json`), committed and deployed with the rest of
the data. The site does not display it; it is meant for maintainer review.

| Source | Publisher | Key | Notes |
| --- | --- | --- | --- |
| CourtListener / RECAP Archive API v4 | Free Law Project | `COURTLISTENER_API_TOKEN` | Anonymous requests were refused (HTTP 401) on 2026-11-20. The RECAP Archive is not a complete mirror of PACER. Check Free Law Project's current terms before production use. Checked daily when a token is configured. |
| Open States API v3 | Plural Policy | `OPENSTATES_API_KEY` | Data offered under a public-domain dedication unless noted; attribution appreciated. Checked daily when a key is configured. |

## Verification states

Every case, bill and link carries a verification state and the method that
produced it. The states and methods are defined in
[ARCHITECTURE.md](ARCHITECTURE.md#the-data-model), and the site's Data and
methodology page shows the same definitions. In the release of 2026-11-20 every
case, bill and link carries `verified_primary`, shown as "Checked against the
official source": for a record, it was retrieved from the official publisher and
parsed without error; for a link, its quoted passage was found in the cited
document. DemocracyHQ's own labels, tags and derived dates, and the descriptions
maintainers wrote, are not part of that check.

## Sources considered and not used

| Source | Why not |
| --- | --- |
| supremecourt.gov JSON docket files (`/RSS/Cases/JSON/{docket}.json`) | Used until 2026-11-20. The Court's `robots.txt` disallows `/rss/`, and the server does not distinguish letter case in paths, so these files are no longer requested. The docket pages replace them. |
| PACER | Paid access. Never accessed. |
| `leginfo.legislature.ca.gov` pages | Blocks automated clients. Not worked around. |
| Census Data API | A request without a key was redirected to a "missing key" page when it was tried; the bulk files need no key. |
| Advocacy organisations' litigation trackers | Outcome framing is the publisher's own, and reuse terms were not stated on the pages examined. |
| News reports | Not a primary source. |

## Personal data

DemocracyHQ collects none. It holds no voter records, no party affiliation of any
individual and no information about private individuals beyond the names of
parties, counsel and officials that appear in public court dockets and legislative
records. The site sets no cookies, runs no analytics and makes no request to any
third party. The watchlist is stored in the reader's own browser.

## Attribution

If you reuse the data, credit the original publishers named above. A suggested
line for the dataset as a whole:

> Compiled by DemocracyHQ from the U.S. Census Bureau, the Supreme Court of the
> United States and California Legislative Information. DemocracyHQ is not an
> official source.
