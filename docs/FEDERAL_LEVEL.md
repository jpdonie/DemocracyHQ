# The federal level: Congress and the courts of appeals

This page describes the parts added with the data release of 2026-11-21: the election
measures of Congress, election cases of the thirteen federal courts of appeals, the
judicial circuits on the map, and how each is retrieved, selected and checked. The
figures are those of that release; `public/data/manifest.json` and the site's
**Data and methodology** page hold the current ones.

## What was added

| Part | What it holds | Source |
| --- | --- | --- |
| Measures of Congress | 273 of the 20,191 measures of the 119th Congress, selected by rule `us-select-1`, each with its actions, sponsors, committees, the Congressional Research Service summary, related measures and every published text version (mirrored and comparable) | GovInfo bulk data: Bill Status (`govinfo-billstatus`) and Bills (`govinfo-bills`), Government Publishing Office |
| Court of appeals cases | 128 cases from 11 of the 13 courts, selected by rule `circuit-select-1` from the 27,813 cases (28,576 documents) that GovInfo lists with a document issued since 2025-01-01 | GovInfo, United States Courts Opinions collection (`govinfo-uscourts`) |
| Judicial circuits | Which states and territories each regional circuit is made of, with the words of the statute | United States Code, 2024 Edition, 28 U.S.C. § 41 and 48 U.S.C. § 1821(a), on GovInfo (`govinfo-uscode`) |

On the site these appear as a page for the United States (`#/place/nation:US`), a
courts overview (`#/courts`), a page for each court (`#/court/<id>`), and two
selectors on the map: **Level** (Federal, States, Counties, Districts) and **Courts**
(Supreme Court, Circuits). A state's page names its court of appeals and lists the
appeals that began in a federal district court there.

## Measures of Congress

- **Retrieval.** The status record of every measure is read from the Bill Status
  archives (one zip for each kind of measure). Each text version is the XML that
  the Government Publishing Office publishes for it.
- **Selection (`us-select-1`).** A measure is selected by its titles and by the
  policy area the Congressional Research Service gave it. The patterns, the policy
  areas and the number selected by each test are published in
  `public/data/congress/index.json`. A measure whose titles do not say that it
  concerns elections is missed.
- **Stage (`us-status-1`).** Congress's record has no status field. The stage shown
  is the furthest step among the recorded actions. It is a derived value and the
  page says so; the record's own latest action is shown beside it. The stage
  "Passed House and Senate, not sent to the President" means a vote of passage in
  each chamber and nothing more: the two votes can be on different texts (as with
  S. 1383, which the House passed with an amendment). The order of the stages is
  published with the rule in `classification.json`, and `npm run data:validate`
  fails when the site's own list differs from it.
- **Issue tags** come from the same keyword rules as for California, applied to the
  titles and the CRS summary.
- **Order of text versions.** Versions are ordered by their date, and those of one
  day by the step their code stands for (introduced, reported, engrossed, ...). A
  version whose code that order does not hold is placed last among those of its
  day, and when it shares the day with another version the run flags it for a
  maintainer, because the latest version names the stage of the text and is the one
  earlier texts are compared with. No published version has such a code today.

## Court of appeals cases

- **What GovInfo holds.** The courts send GovInfo opinions and some orders, not
  dockets. A case here is therefore one or more documents with the court's short
  record for it, not a docket with every entry.
- **Selection (`circuit-select-1`).** Every case with a document issued since
  2025-01-01 is read. A case is selected when the court's record gives it the nature
  of suit 441 (Civil Rights: Voting), or when the text of one of its documents meets
  one of the published text tests. The thresholds are published in
  `public/data/circuits/index.json`, with what was read for each court.
- **Exclusions (`circuit-exclusion-1`).** A case the rule picks that is not an
  election case can be removed by a maintainer in
  `pipeline/seeds/circuit_exclusions.json`, with a reason and a quoted passage of
  the opinion. Six are listed, and each is shown on its court's page.
- **Where the appeal began (`origin-court-1`).** The district court is taken from
  the opinion's own words. A state's page lists these appeals and says that the
  state is where the case began, not necessarily what it concerns.
- **Appeals decided together (`same-opinion-1`)** share a row in the lists.
- **Federal Circuit.** 1,479 cases (1,538 documents) were read. The rule picked one,
  which is not an election case and is on the list of exclusions. The court is
  listed with no case and with these counts.
- **Eighth Circuit.** Almost every document it sends GovInfo is the clerk's cover
  letter and not the opinion (rule `cover-letter-1`), so its cases can be found only
  through the nature of suit. Its election cases are more likely to be missing than
  those of the other courts.

## Issue tags and their correction

Every tag of the 128 court of appeals cases and of the 272 measures of Congress
then published (244 tags) was read against the text it was matched in. (The measure
selected since, S. 5815, has no published text yet and carries no tag.) Twelve of the
tags were wrong:

- Rule `tag-redist-2` no longer counts a seat's name ("the Representative from the
  first congressional district"), which had tagged five election-contest resolutions.
- Rule `tag-direct-4` no longer reads the name of a federal project ("Unlawful
  Voter Initiative") as a voter initiative, and in a long document a line that starts
  with a rule's word is not taken for a subject line.
- Rule `tag-vra-5` no longer takes the "Youth Voting Rights Act", the "Native
  American Voting Rights Act" or a state's act named after the state ("Washington
  Voting Rights Act", "Voting Rights Act of New York") for the Voting Rights Act of
  1965.
- Four tags that a rule assigns from doctrine an opinion only cites were removed by
  a maintainer (rule `tag-removal-1`, `pipeline/seeds/tag_removals.json`). Each
  removal carries a reason and a passage of the case's own document; the pipeline
  checks on every run that the passage is still there, and the case page shows the
  removed tag with both. A removal that no longer applies is reported in the review
  queue and has no effect.

## Retrieval when GovInfo fails requests

On 2026-11-21 GovInfo answered a large share of requests with HTTP 502 for several
hours, each with a request to come back 60 seconds later. Two changes keep a run
short and complete in that state:

- A bill text already held is asked for with `If-Modified-Since`. The server answers
  304 where it fails a request for the file itself.
- Files are asked for once each, and the ones the server failed are asked for again
  together after one pause for all of them, for up to twelve rounds
  (`in_rounds` in `pipeline/dhq/http.py`). No file is asked for sooner than the
  server said. A round in which not one of twenty or more requests is answered ends
  the rounds: the source is down, and the last verified records are kept.

## Limits

- Federal district courts and state courts are not covered. Most election
  litigation starts there.
- Only cases with a document issued since 2025-01-01 are read, and only what the
  courts send GovInfo.
- Both selection rules count words. They can miss an election record and can
  include one that only mentions elections.
- The circuits are drawn from the Census Bureau's state boundaries. American Samoa
  is in no circuit; the statute's "District of the Canal Zone" is not on the map.
- No population figure is shown for the country or for a circuit.
- The sites of the courts themselves, congress.gov and the Federal Election
  Commission are not read.
