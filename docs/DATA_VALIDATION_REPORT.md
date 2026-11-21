# Data validation report

Data release `2026-11-20T22:05:28Z` (schema version 1), produced on 2026-11-20 by
a full pipeline run (`cd pipeline && python3 -m dhq.run`, all stages) from live
official sources. The run took about three minutes and exited 0: no stage or
source failed, no record was stale and the review queue was empty. It replaced the
release of `2026-11-20T20:42:28Z` only to publish two corrected source
descriptions in `sources.json`. Apart from those two descriptions and the
timestamps and hashes, the two releases are identical (compared file by file):
every case, bill, link, event, boundary and count is the same. The hand-run checks
in section 3 were run on the earlier of the two. This report
says what the release contains, what was checked, by whom and how, what the
checks found, and what was not checked. It is written for a reader who wants to
decide how far to rely on the data.

Where the numbers come from: the counts in sections 1 and 2 were recomputed from
the files in `public/data/` for this report, and the validator in section 2 was
run for it. The result of the pipeline's own checks is from the log of the run
that produced the release. The hand-run checks in section 3 and the test results
in section 4 were run by the maintainer on this release and on the final code;
they were not repeated for this report.

**A data gap is not evidence of absence.** Nothing below makes the dataset
complete. It covers 25 Supreme Court dockets, 132 California measures and the
Census boundaries and counts named in the source register.

## 1. What the release contains

| Item | Count | Source |
|---|---|---|
| Supreme Court dockets | 25 (19 on the Court's paid docket, 6 applications) | supremecourt.gov public docket pages |
| Docket entries | 1,264, of which the published rules mark 133 as key | same |
| Document links in those entries | 2,276 (2,270 distinct addresses counted docket by docket, 2,265 across all dockets, with addresses that differ only by a `#page` fragment counted separately, as the Court's pages give them); 5 are published as unavailable (section 2) | same |
| Questions presented, mirrored as text | 16 dockets | the Court's Questions Presented documents |
| California measures | 132 of the 5,041 measures of the 2025-2026 Regular Session: 70 Assembly bills, 47 Senate bills, 7 constitutional amendments, 5 joint resolutions and 3 concurrent resolutions | Legislature's bulk archive `pubinfo_2025.zip` |
| Mirrored official text versions | 563 | same |
| Legislative history actions | 2,637, of which the published rules mark 632 as key | same |
| Curated links between records | 38: 28 case to place, 6 bill to bill, 3 case to bill, 1 bill to place | maintainers, each with a quoted passage checked against the cited document |
| Timeline events | 1,053: 911 for bills, 133 for cases, 9 for boundary files | derived from the records above |
| Geographic units | 4,173: 56 states and equivalents, 3,235 counties and equivalents, 441 districts of the 119th Congress, 441 districts for 2026 | Census 2025 cartographic boundary files, 2026 TIGER/Line |
| 2020 Census population rows | 52 states and equivalents (the 50 states, DC and Puerto Rico), 3,221 counties and equivalents, 437 districts of the 119th Congress | P.L. 94-171 files and the 119th Congressional District Summary File |

The totals for cases, bills, links, events and geographic units are also in
`public/data/manifest.json`; the breakdowns were computed from the files it
describes.

### Labels and derived values in this release

Apart from the legislative status, which is the Legislature's own field, and the
verification states, these are DemocracyHQ's own rule outputs and curated tags,
counted from the published files. They are not part of what "Checked against the
official source" covers.

**Legislative status**, as the Legislature records it: 76 Chaptered, 23 Died, 16
In Committee Process, 7 Pending Referral, 5 In Floor Process, 4 Vetoed, 1 Failed.
The 18 Assembly and Senate bills still recorded as pending get a note on the
August 31, 2026 deadline to pass bills.

**Effective-date cell:**

| Shown | Measures | For |
|---|---|---|
| A date, labelled as derived by rule from the immediate-effect flag | 16 | chaptered statutes the official data flags as taking immediate effect |
| "Not verified" | 56 | other chaptered measures, resolutions apart (ACA 8 among them) |
| "None: not enacted" | 24 | bills that died (23) or failed (1) |
| "None: not enacted as of the last check" | 18 | bills still pending |
| "None: not adopted as of the last check" | 6 | constitutional amendments still pending |
| "None: vetoed, not enacted as of the last check" | 4 | vetoed bills (for AB 699 and SB 512 the official history also records that the veto stands) |
| "Not applicable" | 8 | resolutions |

**Conditions and repeal clauses.** Rule `ca-cond-1` quotes a condition in 6
measures (AB 16, AB 604, ACA 15, SB 1164, SB 280 and SB 42). Rule `ca-sunset-1`
quotes 16 repeal clauses in 13 measures; 11 of the clauses, in 10 measures, give
a calendar date. Of the bill events on the timeline, 328 name the subject line
that was in force when the action was taken.

**Issue tags.** The 25 dockets carry 51 tags: 46 from the keyword rules and 5 added
by a maintainer (rule `tag-curated-1`). 115 of the 132 measures carry 180 tags:
`election-administration` 40, `mail-voting` 26, `campaign-finance` 25,
`registration` 22, `direct-democracy` 22, `voting-technology` 11,
`certification` 10, `redistricting` 10, `ballot-access` 7, `voting-rights-act` 3,
`voter-id` 2 and `state-voting-rights-act` 2.

**Docket entries.** Every one of the 1,264 entries carries a classification rule
(none is unclassified), and each of the 25 dockets has a latest-ruling entry.

**Verification states.** All 25 case records, all 132 bill records and all 38
links carry "Checked against the official source" (`verified_primary`). Cases and
bills carry the method `automated_primary_retrieval`; links carry
`maintainer_curated`. No record carries any other state.

## 2. Automated checks

### Schema and integrity validation (run for this report)

`node scripts/validate-data.mjs`, run on 2026-11-20 against `public/data/` as
published, exit status 0. Its output:

```text
ok    Schemas: every published file matches its runtime schema (25 cases, 132 bills, 563 text versions)
ok    Text hashes: 563 mirrored text versions hash to the value recorded on their bill
ok    Geography: 4173 units, every GEOID unique, every drawn unit indexed, state abbreviations match the Census file
ok    County and district pairs: 3854 pairs, all resolve to indexed units
ok    National total: the 50 states and DC sum to 331,449,281, the published 2020 Census resident population
ok    County sums: in 52 states the county counts sum exactly to the state count
ok    District sums: in 52 states the 119th Congress district counts sum exactly to the state count
ok    Group sums: in every state, county and district the race and origin groups sum exactly to the total
ok    Relationships: 38 links, every end exists, every link carries its passage, the document it is from and the document's link
ok    Timeline events: 1053 events, every record and place they name exists
ok    District area check: 268 unchanged districts compared, largest land-area difference 0.019%, 0 over tolerance
ok    Manifest: counts match the data (cases 25, bills 132, relationships 38, events 1053, geographicUnits 4173); no event is dated after the release
ok    Published files: the 738 files under public/data are exactly the .json files the checks above read
note  population/county.json: 8 counted unit(s) have no current boundary and are never displayed
note  source courtlistener-api: credential_missing
note  source openstates-api: credential_missing

Data release 2026-11-20T22:05:28Z is valid (13 checks).
```

The eight counted units without a boundary are Connecticut's former counties. The
two optional sources have no API key and did not run. The last check is new in this
release: it fails on any file under `public/data/` that is not a `.json` file the
data refers to, including hidden files, because the build copies that folder into
the site as it is.

### Checks the pipeline runs before it publishes (in the run that produced this release)

| Check | How | Result |
|---|---|---|
| Data model | pydantic models in `pipeline/dhq/schemas.py`, run in `stage_validate` on the staged release | Passed; nothing was held back. |
| Curated links and tags | `pipeline/dhq/evidence.py`: the quoted passage must be in the named document (ignoring white space, hyphens and dashes, letter case and quotation-mark style, and reading Unicode compatibility characters such as ligatures and superscript digits as their plain forms; parts separated by `[…]` must appear in order, each at least 25 characters), and a passage tying a record to a place must name the place | Every link and tag in the seed files was published: 38 of 38 links and 5 of 5 tags. A link or tag that fails is not published and is listed in the review queue; the queue was empty. |
| Opinion and order links inside docket entries | each address requested by the pipeline when it refreshes a docket | 5 links at 4 distinct addresses answered 404. They are published as unavailable with the date of the check; the case pages show these addresses as text, not as links, and source packs and exports give the docket page as the source with an availability note. |

## 3. Hand-run checks (run by the maintainer on the release of 2026-11-20T20:42:28Z)

Two tools need the network and are not part of the tests or the scheduled run.
The maintainer ran both on 2026-11-20, on the release of 2026-11-20T20:42:28Z,
whose records are identical to this one's (see the top of this report). The
results below are taken from those runs' output.

### Dockets against the Court's pages

`cd pipeline && python -m tools.verify_dockets` (about 27 seconds, exit 0).

The tool fetches the Court's public docket page for each published docket again
and compares it with the published record: docket number, both titles, docketed
date, every entry's date and text, and every document address. It reads the page
with its own class built on Python's HTML parser. The pipeline's adapter reads the
page structure, and the opinion and order links written inside entry text, with
regular expressions, and the filing links listed under each entry and the
Questions Presented link with a separate class built on the same standard-library
parser. The two share no project code
except the HTTP client; for filing links, both rely on that standard parser.

| Measure | Result |
|---|---|
| Dockets fetched | 25 of 25 |
| Entries matching in date and text | 1,264 of 1,264 (0 differ, 0 missing from the Court's pages, 0 new on the Court's pages) |
| Header differences (number, titles, docketed date) | 0 |
| Published document addresses found on the Court's pages | 2,270 of 2,270, counted docket by docket; 0 addresses on the Court's pages left out |

It does not check whether those addresses answer, and it does not check entry
labels, tags or the choice of the latest-ruling entry.

### Sample of outbound links

`cd pipeline && python -m tools.check_links --sample 15` (about 20 seconds, exit
0). It sends a HEAD request to an evenly spaced sample of the addresses in
`public/data/` (outside mirrored bill text) for each host, one request a second.

| Host | Distinct addresses in the data | Requested | Answered 200 |
|---|---|---|---|
| www.supremecourt.gov | 2,309 | 15 | 15 |
| www2.census.gov | 4 | 4 | 4 |
| www.census.gov | 1 | 1 | 1 |
| downloads.leginfo.legislature.ca.gov | 1 | 1 | 1 |
| leginfo.legislature.ca.gov | 695 | not requested: the site blocks automated clients | |
| v3.openstates.org, www.courtlistener.com | 1 each | not requested: APIs of optional sources that need a key | |

It is a sample and does not test every address. The five dead links (four
addresses) in section 2 come from the pipeline's own check of every opinion and
order link.

## 4. Tests on the final code

Run by the maintainer after the last code change, on this release.

| Suite | Command | Result |
|---|---|---|
| Pipeline | `cd pipeline && python -m pytest -q` | 457 passed |
| Front-end unit | `npx vitest run` | 295 passed, in 22 files |
| Type check | `npx tsc -p tsconfig.json` | no errors |
| Browser, desktop and phone, including axe WCAG 2.2 A and AA rules and keyboard paths | `npm run build:e2e`, then `npx playwright test` | 217 of 217 passed, in 15 files (175 desktop, 42 phone). |
| Production smoke test | `npm run build`, then `CI=1 E2E_DIST=dist npx playwright test tests/e2e/subpath.spec.ts` | 20 passed against the production build in `dist/`, which carries the Content-Security-Policy meta tag. The deploy workflow runs 18 of these 20 (the "Static hosting under a sub-path" group). |

The final round added four browser test files, five unit test files and two
pipeline test files (`test_rules_and_seeds.py`, `test_network_limits.py`).

## 5. Independent reviews

Every review below was carried out by reviewer agents that had not built the
project, working from the code, the data and the primary sources. None of them is
a lawyer's review.

### Review A: the data against the primary sources

Four reviewers compared the published data with the primary sources, each in one
area. Their work was on an earlier release, with 123 California measures; it was
not repeated for this release. The record-level findings were fixed and the data
regenerated. What they confirmed on that release:

**Supreme Court.** For all 25 dockets every header field, all 1,264 entries (count,
order, date, text) and all document links matched the Court's own data fetched that
day. Seven questions-presented texts matched the Court's PDFs exactly. Re-running the
published classification rules on every entry reproduced every label.

**California.** For the 123 measures then published, every identity, status, chapter
and date field, all 2,429 history actions and all 514 versions matched the live bulk
archive. All 514 mirrored texts matched the official XML apart from whitespace and
synthesized headings. The column positions the adapter uses agree with the
Legislature's own loader scripts.

**Census.** 936 of 936 state cells, 4,626 county cells (257 counties in six states and
Puerto Rico) and 324 district cells (18 districts) equal the Bureau's files. The list of
redrawn states and the Missouri note are verbatim. No page shows a 119th Congress count
on a redrawn state's 2026 district. All 3,854 county-district pairs equal the Bureau's
county-within-district file.

**Links, tags and events.** Every link pointed to the right place or measure, and every
timeline event matched its docket entry or history row in date and text.

What they found, and what is in place in this release:

| Area | Finding | In place now |
|---|---|---|
| Legal meaning | The verification label on a link meant only that a few loose words occurred in a document; 22 of 28 case-to-place "quotes" were keyword lists. | Every link quotes a real passage of a named document, checked as described in section 2, and the page names the document. The label is now "Checked against the official source", with the narrower meaning given in [Known limitations](KNOWN_LIMITATIONS.md). |
| Legal meaning | Bill status showed the state of the latest text version, so vetoed bills read "Enrolled" and dead bills "Introduced". | The Legislature's own status is the headline (Chaptered, Vetoed, Died, In Committee Process and so on); the text version's state is shown beside it. |
| Legal meaning | A vetoed bill, a dead bill and a resolution all read "Not verified" for the effective date. | Each has its own wording (section 1), and a date derived from the immediate-effect flag is labelled as derived. |
| Legal meaning | Conditions in the text (operative only if the voters approve, or only if another bill takes effect) were shown for one bill only. | Rule `ca-cond-1` quotes such sentences for every measure (6 in this release). Whether a condition was met is not recorded. |
| Text | Fractions lost their slash ("1 1/2 percent" became "112 percent") and spacing after designators was dropped. | Text regenerated. |
| Selection | 13 measures that are not about elections were selected; at least 24 election measures, mostly campaign finance, were missed. | Rule `ca-select-2`: electoral senses of "initiative" and "recall" only, campaign finance and candidacy added, the Political Reform Act's lobbying and ethics provisions and tax "elections" excluded, regular session only. 132 measures. |
| History | Same-day actions were out of order in 13 bills; an action the Legislature marks "Rescinded" counted as a passage; constitutional-amendment adoptions were not key actions. | Fixed. |
| Courts | The order granting application 25A1197 was not recognised as a ruling; several Court orders were filed as routine. | All 25 dockets show a ruling entry; no entry is left unclassified. |
| Places | A county-only case appeared as a statewide record on other Texas counties. | Fixed in the pipeline and in the app. |
| Census | The exported source pack labelled non-Hispanic race counts as plain "White alone". | The pack uses the Bureau's full variable labels and codes. |
| Census | The district deviation figure read as malapportionment in states that balance districts on an adjusted base. | Reworded as a difference from the state's average district, with that explanation. |
| Census | Boundary files were never re-downloaded after the Bureau regenerated them. | A file is downloaded again whenever the server's date or size changes. |

### Review B: the product in a browser

Two reviewers used the built site in a real browser, one at desktop sizes and one
at phone sizes, and reported 36 findings (6 major, 21 minor, 9 nit). The fixes
were checked by an independent verifier and repaired where it found gaps.

### Review C: engineering and security

Three reviewers read the pipeline, the front end and the GitHub workflows and
reported 47 findings: 15 on the pipeline, 17 on the front end and 15 on the
workflows (2 blocker, 10 major, 21 minor, 14 nit). The same fix, verify and
repair process followed.

### Final round: wording review and Review D

Both were run on the release of 2026-11-20T16:16:39Z, before the fixes described below.

- **Wording review.** One reviewer read every piece of explanatory wording as a
  practising election-law attorney who edits a nonpartisan legal reference would:
  22 findings (0 blocker, 2 major, 10 minor, 10 nit). The two major findings: the
  verification label and its stated meaning promised more than the check does and
  appeared without its caveat in exports and next to links on bill pages; and the
  five dead opinion and order links were described as "marked unavailable" while
  the site and the exports still presented them as working links. It also found
  that this report described an earlier release.
- **Review D.** Four reviewers who had not seen any earlier review, and were told
  not to rely on the project's own documents, each took one lens: legal accuracy
  (15 findings), neutrality (6), trying to break the site in a browser (14), and
  security and privacy (7). Together: 42 findings (0 blocker, 6 major, 24 minor,
  12 nit). The six major findings were: dead ruling PDFs shown as live links;
  floor votes taken before a gut-and-amend shown as votes on the bill's current
  subject; clicking a state with no linked case on the litigation map leaving all
  25 dockets listed; focused controls hidden behind the fixed tab bar at 400% zoom;
  the ingest workflow's hand-over able to publish any file under `public/data/` to
  the site; and California bill ids from the bulk table not being validated, so a
  hostile table could make the pipeline write outside its staging folder.
- **Skeptic checks.** Each of Review D's six major findings was given to a
  separate agent whose task was to refute it. Five were confirmed as real and
  major. The sixth, the ingest hand-over, was judged real but overstated and
  lowered to minor, because an attacker would first need a compromised pinned
  dependency. The wording review's two major findings were not sent to a skeptic.
- **Fixes.** All 64 findings were divided among five groups by area: security;
  pipeline rules and curated passages; bill pages and exports; verification
  wording and case pages; and navigation, layout and accessibility. Each group's
  work went to a separate verifier, which was told to reproduce every original
  problem against the current code and a build of its own, to check by reverting
  each change in a scratch copy that the tests cited for it fail without it, to
  look for regressions, and to check that new wording is accurate and neutral.
  Of the 76 group assignments (some findings were split between groups), the
  verifiers judged 70 fixed and 6 partly fixed, and they raised 37 further
  problems (11 minor, 26 nit). Each group then repaired the problems in its own
  files; the repairs were not sent back to a verifier. The maintainer closed the
  items that crossed group boundaries (the earlier-subject note on the place
  timeline, record names in case and place packs, a line-length bound when reading
  Census files), ran the pipeline to produce this release, and ran the tests in
  section 4.
- **What changed as a result**, in short: dead opinion links are shown and
  exported as unavailable, not as links; the verification label is now "Checked
  against the official source" with a narrower meaning; curated links carry their
  own method; bill pages say when a vote was taken under an earlier subject, show
  repeal clauses, give the deadline note for bills still pending after August 31,
  2026, and show the linked case's latest ruling; argumentative or one-sided
  curated passages were replaced under a written curation rule, and party labels
  are applied alike; PDF line-break hyphens are joined before tagging; tag rules
  were tightened; the session denominator counts Regular Session measures only;
  path traversal from bill ids, unbounded downloads and ZIP inflation, and API keys
  following redirects were closed; the ingest commit step accepts only `.json`
  data files and the validator rejects any file it does not read; the weekly cache
  no longer carries files over from earlier weeks; the built site ships a
  Content-Security-Policy and a no-referrer policy; version comparison no longer
  inserts spaces or interleaves rewritten passages; Back restores the reader's
  place; very short screens keep focused controls visible; every view has a
  disclaimer footer, and About is in the desktop navigation.

## 6. Known limits and open items

The full list is in [Known limitations](KNOWN_LIMITATIONS.md). Left open on
purpose in this release:

- **Tag excerpts from separate opinions.** The excerpt shown with an automatic tag
  is the first match in the document and can come from a concurring or dissenting
  opinion; it is not labelled with the part of the document it comes from (for
  example the mail-voting tag on No. 20-542).
- **A tag on a passing mention.** SB 266's `direct-democracy` tag rests on a
  passing mention of translated ballot measures. No narrower exclusion was found
  that would not also drop true matches.
- **Ballot and election results are not tracked.** The result of Proposition 50
  (ACA 8) and of the November 3, 2026 vote on SB 42 were not checked against a
  primary source, and the site does not state them. Where a court document
  mentions the Proposition 50 result, it is quoted with its source.
- **One dead address with a working copy elsewhere.** The Court's order of May 4,
  2026 is linked from No. 24-109 at an address that answers 404. The same order is
  linked at a working address from Nos. 25A1197 and 24-110; it is not substituted
  on 24-109.
- **Pipeline network limits.** The per-request deadline does not cover the DNS
  lookup, which only the system resolver bounds, and a ZIP archive's central
  directory is read whole (bounded by the archive's stated size). Cached bill
  texts and tables are trusted on size and CRC-32 within one ISO week; the first
  run of each week normally starts from an empty cache and downloads every file
  it uses again.
- **Unused verification states.** "Awaiting review", "Disputed" and "Outdated" are
  defined in the data model, but no tooling assigns them and no record carries
  them.
- **Links to leginfo.legislature.ca.gov** are built from bill identifiers and are
  not machine-checked, because that site blocks automated clients.

## 7. What was not checked

- **Not compared with the sources again for this release:** California records
  field by field against the bulk archive, and Census counts cell by cell. Review A
  did both on an earlier release. For this release the evidence is the pipeline's
  own parsing and validation, the text hashes, and the validator's sum checks.
- **Rule outputs.** Entry labels, issue tags, the latest-ruling entry, bill
  selection, conditions, repeal clauses and derived dates were not re-checked by
  hand or by a second program for this release. `tools.verify_dockets` compares
  dates, text, headers and addresses, not labels.
- **Reachability.** Only 15 of the 2,309 supremecourt.gov addresses were requested
  by the link sample. Filing links are not tested for reachability on each run.
  The 695 leginfo.legislature.ca.gov addresses were never requested.
- **Maintainer-written descriptions.** The description and scope note of each
  curated link are not checked by machine; only the presence of the quoted passage
  is.
- **Legal review.** No lawyer has reviewed the data or the wording.
- **Deployment.** The checks above were run locally on this release. The site was
  first published to GitHub Pages on 2026-11-21 by the deploy workflow, whose smoke
  test (18 tests) passed on GitHub. The first CI run on GitHub failed two phone
  layout tests: on the runner, the text versions table of a bill was 6 pixels wider
  than a 360- and a 320-pixel screen, because text renders a few pixels wider there
  than on the machine that ran the tests above. The stylesheet now leaves that table
  room to spare at those widths. The scheduled ingest workflow has not yet run on
  GitHub. Browser tests ran in headless Chromium only.

## 8. How to repeat these checks

```sh
node scripts/validate-data.mjs               # schema and integrity checks (no network)
npx tsc -p tsconfig.json                     # type check
npx vitest run                               # front-end unit tests
npm run build:e2e && npx playwright test     # browser tests, desktop and phone, against dist-e2e/
npm run build && CI=1 E2E_DIST=dist npx playwright test tests/e2e/subpath.spec.ts
                                             # sub-path tests against the production build in dist/
cd pipeline
python -m pytest -q                          # pipeline tests (no request leaves the machine)
python -m tools.verify_dockets               # dockets against the Court's pages (network; one request about every 1.1 s)
python -m tools.check_links --sample 15      # sampled reachability of outbound links (network; one request a second)
python3 -m dhq.run                           # the full pipeline run (network; writes public/data/)
```

The deploy workflow's own smoke test is the last browser command with
`--project=desktop --grep "Static hosting under a sub-path"` added.
