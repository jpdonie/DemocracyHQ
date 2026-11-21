# Known limitations

This page lists what DemocracyHQ does not cover, does not check, or has not
proved. It is meant to be read before the tool is relied on for anything.

Status as of the data release of 2026-11-21. The limits of the federal level
(Congress, the courts of appeals, the circuits) are set out in
[FEDERAL_LEVEL.md](FEDERAL_LEVEL.md#limits).

## Coverage

- **Courts.** The U.S. Supreme Court (25 dockets chosen by hand) and the thirteen
  federal courts of appeals (128 cases selected by a word-counting rule from what
  the courts send GovInfo, since 2025 only, as opinions without dockets). No
  federal district court, no state court. Most election litigation starts in the
  courts that are missing. The Eighth Circuit's cases are more likely to be
  missing than those of other courts, because GovInfo holds its cover letters in
  place of its opinions.
- **Two legislatures.** Congress (273 of the 20,191 measures of the 119th
  Congress, selected by their titles and policy area) and California's 2025-2026
  Regular Session (132 of its 5,041 measures). No other state, no extraordinary
  sessions, no earlier sessions or Congresses, no ballot measures as such, no
  regulations, no local ordinances.
- **The stage of a measure of Congress is derived.** Congress's record has no
  status field; the stage is the furthest step among the recorded actions (rule
  `us-status-1`). A stage that names both chambers does not say that both passed
  the same text.
- **Bill selection is by subject line.** A measure is included only if its latest
  official subject matches the published rule (`ca-select-2`) after the phrases of
  its published exclusion pattern are removed. Election-related bills with other
  subject lines are missed, and the rule can admit a bill that is only loosely
  about elections.
- **No ballot or election results.** The site does not track the outcome of any
  vote of the people. Where a measure or a condition in it turns on such a vote,
  the page says so and points to the Secretary of State's Statement of Vote.
- **Geography.** States and equivalents, counties and congressional districts
  only. No state legislative districts, precincts or municipalities.
- **Population.** 2020 Census counts only: total, 18 and over, and race by
  Hispanic origin. No citizen voting-age population, no ACS estimates, no
  registration or turnout.
- **Districts for 2026 in nine states have no counts.** Alabama, California,
  Florida, Louisiana, North Carolina, Ohio, Tennessee, Texas and Utah drew new
  congressional districts for 2026, and the Census Bureau has not yet published
  2020 counts for them. Those districts show "Unavailable".
- **Island areas have no counts.** American Samoa, Guam, the Northern Mariana
  Islands and the U.S. Virgin Islands are drawn on the map, but their 2020 Census
  is published separately and is not loaded.
- **Connecticut.** The current county equivalents are planning regions, which did
  not exist in 2020, so they have no counts. The eight former counties have counts
  and no current boundary, and are not shown.

**A data gap is not evidence of absence.** A place with no listed case may have a
great deal of litigation.

## Accuracy

- **No lawyer has reviewed the data or the wording.** The site was reviewed by
  reviewer agents, including one asked to read it as an election-law attorney
  would. That is not legal review.
- **"Checked against the official source" has a narrow meaning.** On a record it
  means the record was retrieved from the official publisher by a program, parsed
  without error, links to that source, and matched what the source published at
  the last check. DemocracyHQ's own rule outputs shown with it (entry labels,
  issue tags, the latest-ruling entry, derived dates) and the link descriptions
  written by maintainers are not part of that check. On a link between records it
  means that the quoted passage was found in the cited document when that document
  was last fetched, and that a passage tying a record to a place names the place.
  The comparison ignores white space, hyphens and dashes, letter case and the
  style of quotation marks, and reads Unicode compatibility characters (such as
  ligatures and superscript digits) as their plain forms. It does not mean anyone
  judged that the record is complete or that the passage supports the
  maintainer's description or a conclusion a reader might draw. A passage from a
  party's filing is that party's account.
- **Curated links and tags are a hand-picked subset.** A link or tag whose passage
  is not found is not published at all, so a missing link does not mean two
  records are unrelated. A published link is checked again only when a run has its
  document at hand (for a case's link to a place, when the docket is refreshed);
  until then it keeps the date of its last check. Passages are chosen under a
  written rule (descriptive text or the Court's own text; no sentence in which a
  Justice or party characterises another's position; party labels applied alike),
  but the choice is still a maintainer's.
- **Labels are keyword rules.** Issue tags and the labels on docket entries and
  legislative actions come from regular expressions. They will mislabel some
  entries, and a tag count in a filter counts rule matches, not subjects. The rule
  and the matched text are shown so that a reader can judge. Known weak spots:
  - The excerpt shown with an automatic tag is the first match in the document,
    which can come from a concurring or dissenting opinion, and it is not labelled
    with the part of the document it comes from. Example: the mail-voting tag on
    No. 20-542 quotes a dissent from the denial of review.
  - SB 266's "Initiatives, referenda and recalls" tag rests on a passing mention
    of translated ballot measures.
  - Words broken by a hyphen at a line end in a court PDF are joined before the
    rules run. A genuine compound broken at a line end is joined too, unless the
    document also writes it with a hyphen on one line or its first part is one of
    the words the methodology page lists.
  - Five tags were added by a maintainer where the rules miss a case's central
    subject (rule `tag-curated-1`); each is shown with its quoted passage.
- **Related dockets are derived.** Dockets shown as coming from the same case
  below share a lower court and a lower-court case number that names the same
  case, read by the published rule `same-lower-court-2`. The Court does not state
  the relation.
- **Some links on the Court's dockets are dead.** Each time it refreshes a
  docket, the pipeline asks for each opinion or order linked inside its entries.
  Five links, at four distinct addresses, answered "not found" in this release.
  They are published as unavailable with the date of the check; the case pages
  show their addresses as text, not as links, and the source packs give the
  docket page as the source. Two of them link the Court's order of May 4, 2026 on
  No. 24-109 (one to its page 4); a working copy of the same order is linked from
  Nos. 25A1197 and 24-110, but it is not put in place of the dead address. Filing links are not
  tested on each run.
- **No overall case status.** The site shows the latest entry its rules recognise
  as a ruling on the case itself (an opinion, summary disposition, denial or
  dismissal) or, if there is none, the latest ruling on an application. An order
  granting review, noting probable jurisdiction or postponing the question of
  jurisdiction is never shown there. The site does not say whether a case is
  pending, decided or closed, and that entry may not be the last word (a
  rehearing petition, a remand, a related docket).
- **Effective dates are mostly not known.** California's bulk data has no
  effective-date field. A date is shown only when the data flags a statute as
  taking immediate effect (16 measures in this release), and it is the chaptering
  date, derived by rule and labelled as derived. Otherwise a chaptered measure
  other than a resolution shows "Not verified" (56 measures). Operative dates
  written into a bill's text and delayed operation are **not** extracted, so "Not
  verified" does not mean the text states no date. A vetoed bill shows "None:
  vetoed, not enacted as of the last check", because the Legislature can override
  a veto.
- **Conditions and repeal clauses are found by patterns.** Rule `ca-cond-1`
  quotes sentences in which a measure makes itself, or part of itself,
  conditional ("shall become operative only if ..."): 6 measures in this release.
  Rule `ca-sunset-1` quotes sentences saying that a measure, or a named part of
  it, remains in effect until a date or an event and is then repealed: 13
  measures, with the date where the sentence gives one. A repeal clause applies
  to the provision it names, which may be only part of the measure. A sentence
  worded differently is missed, and whether a condition was met is not recorded.
- **Legislative history follows the official record.** An action the legislature
  marks Rescinded or Reconsidered is shown as such and is not treated as a key
  event. The status shown is the one the Legislature records: for Assembly and
  Senate bills still recorded as pending after the last day to pass bills
  (August 31, 2026; 18 bills in this release), the page adds that deadline but
  does not change the status.
- **Votes taken under an earlier subject.** When a measure's subject changed by
  amendment (gut-and-amend), an action taken while the official subject line named
  a different subject says so. This is judged from the latest text version dated
  before the action and by a word-overlap comparison of subject lines, so a small
  rewording is not flagged. An action on the day a new version is dated, or one
  that adopted the amendments that changed the subject, carries no note, because
  the record does not show which subject it concerned.
- **Court action on a law is shown only when a maintainer has linked the case.**
  The "In the courts" cell on a bill shows each linked case and the latest ruling
  entry on its docket. It never says that no litigation exists, and it does not
  say whether a court has blocked, narrowed or upheld any provision.
- **Bill text is extracted, not official.** Table rows are flattened to cells
  separated by "|", and other special formatting is lost. Fractions and the
  legislature's spacing are kept. The comparison of two versions aligns
  paragraphs and then words inside edited paragraphs of that extracted text; if it
  runs out of time on a very large edit, the remaining paragraphs are shown whole
  as removed and added. The official version controls.
- **Boundaries are for display.** They are generalised by the Census Bureau and
  simplified again. The 2026 district lines are a derivative clipped to a
  generalised shoreline. Do not use them to decide which side of a line an address
  falls on.
- **"Unchanged" districts.** For states the Census Bureau does not list as
  redrawn, the 2026 district is treated as the same area as the 119th Congress
  district and shows its count. This rests on the Bureau's sentence that all other
  states had no changes, and on a check that the two districts' official land
  areas agree within 0.1% (largest difference 0.019% across 268 districts). A
  district that fails the check shows no count. It is an inference from the
  Bureau's statement, not a published tabulation for the 120th Congress.
- **District population differences use a plain base.** The district figure
  "Difference from the state's average district (2020 Census counts)" is computed
  from the published counts. Some states balance districts on an adjusted
  population base, so it is not a plan's legal deviation.
- **Small county parts.** A county part within a district that has no land, or
  less than 1 km² of land by the Bureau's figures, is marked as such in the list of
  overlapping units.
- **2020 Census counts include statistical noise** from the Bureau's disclosure
  avoidance system. Small counts are less reliable.
- **Links to California's public bill pages are not machine-checked**, because
  that site blocks automated requests. They are built from the bill identifiers.

## Freshness

- The data is as fresh as the last pipeline run. Dockets and bills can change the
  same day.
- Staleness is computed in the reader's browser from each source's last successful
  check. A source that keeps failing stays visible with its last good data and a
  stale mark; it does not disappear.
- The review queue in the manifest holds the items of the stages that ran in the
  latest run, and carries over the earlier items of stages that did not run or
  that failed. It starts empty when the earlier queue cannot be found (for example
  when the Actions cache entry that holds it has expired). When one docket cannot
  be fetched in a run whose Supreme Court stage otherwise succeeds, its last record
  stays published and a fetch-failure item is added, but that docket's earlier
  items are not carried over.

## Not proved

- **Scheduled ingestion not yet run.** The site is published on GitHub Pages, and
  the CI and deploy workflows have run on GitHub, but the scheduled ingestion
  workflow has not run there yet. Treat its first runs as a test and watch their
  exit codes and review queue.
- **Optional sources never run live.** The CourtListener and Open States adapters
  were exercised only with synthetic test responses. Their output would be
  published as separate data files (`litigation_secondary.json` and
  `legislation_secondary.json`), which the site does not display.
- **One machine, one browser engine.** Browser tests ran in headless Chromium
  only, at a desktop size and with a phone profile. Firefox, Safari, real phones
  and real assistive technology were not tested.
- **Performance on a real network was not measured.** Figures below are page
  weights from a local server.
- **No usability testing.** Nobody from the intended audiences has used it.

## Accessibility

The site aims at WCAG 2.2 AA and does not claim to conform. Automated axe checks
with the WCAG 2.0 to 2.2 A and AA rule sets report no violations on sixteen
desktop views (and with the search results open, with spelling suggestions shown
and on a pressed watchlist button) and on six phone views (and with the
related-geography lists opened on two of them). Keyboard paths are tested.
Automated tests also check that no control that takes focus is fully hidden
behind the bars at 342 x 164, 342 x 192 and 320 x 256 CSS pixels, sizes like a
laptop screen at 400% zoom; on such screens the page scrolls as one document.
Automated checks find only a share of real barriers. Not done: testing at real
browser zoom by hand, with a screen reader, with voice control, or by disabled
users.

The map is a canvas. It can be panned and zoomed from the keyboard, but individual
places on it cannot be focused. Every place is reachable through the search box,
the lists and direct links instead.

## Performance

Measured on the build machine against the production build of 2026-11-20 served
from a local server, each view opened directly in a fresh 1366 x 768 browser
context. Sizes are the bytes received (the local server does not compress), and
the gzip figures are computed from those files:

| View | Requests | Uncompressed | Gzip estimate |
| --- | --- | --- | --- |
| Home (state map) | 21 | 4.2 MB | 1.2 MB |
| A court case (No. 24-109) | 23 | 5.2 MB | 1.6 MB |
| Version comparison of a large bill (AB 604), opened directly | 16 | 2.9 MB | 0.6 MB |
| County layer | 21 | 5.4 MB | 1.6 MB |
| Redistricting (2026 districts) | 19 | 4.3 MB | 1.3 MB |

The JavaScript of that build is about 2.2 MB uncompressed and 610 kB gzipped,
including MapLibre's worker module of about 0.55 MB; the map library is about
three quarters of it. That is heavy for a slow connection. The county layer is
1.3 MB of TopoJSON. Comparing two versions of a very large bill runs on the main
thread, under a time limit of about four seconds, and can pause the page while it
runs.

## Privacy and security

- No accounts, cookies, analytics or third-party requests. Built pages carry a
  Content-Security-Policy meta tag that allows scripts, styles, fonts, images,
  workers and data from the site's own origin only (images may also be inline
  `data:` addresses), and a no-referrer policy.
  Protection against framing needs a response header from the host, which a meta
  tag cannot set.
- The watchlist is in the browser's local storage. Anyone with access to that
  browser profile can read it, and when the site is served from a github.io
  address, other sites served from the same github.io address can read and change
  it (the page says so there).
- The generative study in `design/identity/` is separate from the site and loads
  p5.js and two fonts from public CDNs when opened.
- The scheduled workflow commits data fetched from upstream sources without human
  review. Validation rejects malformed data, not data that is well formed and
  wrong. The commit step takes only folders and `.json` files under
  `public/data/` (and the review queue file), and the data check fails on any file
  there that the data does not refer to.
- Downloaded source files are reused from the Actions cache within one ISO week.
  A cached California table or bill text is reused when its size and CRC-32 match
  the current archive's directory, and a boundary archive when the server reports
  the same date and size. Neither is a check against tampering: a run whose steps
  were compromised could save altered files that pass both, under its own week's
  name or a later week's. An entry is restored only during the week in its name,
  and GitHub deletes an entry that no run has read for 7 days, which limits a
  planted entry to about the following week. Otherwise the first run of each week
  starts from an empty cache and downloads every source file it uses again.
- The pipeline's per-request deadline does not cover the DNS lookup, which only
  the system resolver's own timeouts bound, and a ZIP archive's central directory
  is read whole (bounded by the archive's stated size).

## Process

- The case list and the links between records are curated by one maintainer.
- The states "Awaiting review", "Disputed" and "Outdated" exist in the data
  model, but nothing in DemocracyHQ assigns them and no record carries them. The
  methodology page marks them as defined but not yet used. Reporting a correction
  does not change a record's badge.
- Reading of source licences in the documentation is the author's, not a lawyer's.
