# Design plan

This is the working record of the interface design. It follows the process in the
`frontend-design` skill: write a compact plan, review it against the look that an
AI model produces by default, build, then critique from screenshots. The tokens
live in [`src/styles/tokens.css`](../src/styles/tokens.css) and the rules in
[`src/styles/app.css`](../src/styles/app.css).

## Subject, audience, job

- **Subject.** Primary-source legal records about American elections, placed on
  official boundary maps.
- **Audience.** People who read dockets and bill text for work: election-law
  attorneys, reporters, academics, legislative staff, election officials, students.
- **Job.** Let a reader get from a place to the records that concern it, and from
  a record to the primary source, without ever being told more than the record says.

The brief asks for "contemporary civic cartography meets a serious legal research
institution".

## Concept: the survey sheet

The most characteristic object in this subject's world is the printed survey sheet,
the USGS quadrangle: a map inside a ruled neatline with ticks in the margin, printed
from separate plates in a small number of inks that each mean one thing. A legal
reporter has the same temperament. Both are documents that state their date and
their source in the margin.

So the workspace is one sheet. The map sits inside a neatline with live longitude
and latitude ticks that follow the map as it moves. The record panel is the
sheet's margin, where the legend, the vintage and the source notes go.

## Tokens

**Color**

| Name | Hex | Role |
| --- | --- | --- |
| Sheet | `#f2f4f8` | Page background of the light side, a cool grey |
| Ink navy | `#17233b` | Text on the light side |
| Night | `#0a1222` to `#16223f` | The night side: the top bar, the map stage, the title block of a page |
| Contour brown | `#85551b` | Geography records and the population ramp |
| Statute green | `#0c6557` | Legislation records |
| Revision purple | `#6a2c6e` | Litigation records |
| Slate | `#46546f` | Sources and provenance |

The three record inks come from the print separations of a topographic sheet:
brown for the land itself, green for what is planted on it, purple for revisions
overprinted later. They mark what kind of record something is and are never used
as decoration. Map fills avoid red and blue so nothing reads as a party colour.
The one exception is the view of who governs (`shade=party` and the block "Who
governs"): there red and blue mean the Republican and the Democratic party and
nothing else, lilac means a government divided between them, and every part also
names its party in words.
Hatching means "no data" everywhere it appears, on the map and in the panel.

**The night side**

The site has two sides. The reading panel is the light side: dark ink on white,
for dockets and bill text that are read at length. The top bar, the map stage
and the title block of every page are the night side: a dark ground on which the
map is lit. A state with records, a county with many people, a state held by a
party stands out as light against the dark; a place without data stays dark under
its hatching. This is the look of a results map on election night, and it is used
for the same reason: the map is the first thing a reader sees, and what it shows
should be seen at once.

The night side uses the same token names with other values, set once at the foot
of `tokens.css` for the stage, the title block and the bar of the phone's sheet.
A control placed there takes the right ink without a rule of its own, and the map
reads its colours from the stage (`token()` in `MapView.tsx`). The rules that
hold on the light side hold there too: text keeps 4.5:1, control borders 3:1, a
boundary line that would fade into a fill is drawn over a casing, and a name on
a pale fill is written in the dark ink. The ramp runs from dim to bright: the
more there is, the more light. Print keeps the light side, and so does the
printable source pack.

Motion is used twice and each time once: a new colouring of the map fades in,
and a seat bar grows to its figure when it first appears, each party's seats
from its own end. Both are off when the reader asks for reduced motion.

**Type**

- *Archivo* (variable, with its width axis) for the interface: navigation, labels,
  tables, controls. Slightly widened for the wordmark and headings.
- *Newsreader* (variable) for the things a reader actually reads: ledes, docket
  entries, bill text, quotations. Case names are set in Newsreader italic, which
  is the legal convention and not an accent.
- Scale 12 / 13 / 14 / 16 / 18 / 21 / 26 / 34 px. Measure capped at 66 characters,
  serif text at 1.58 line height.
- Both families are self-hosted. No request leaves the site for a font.

**Layout**

```
Desktop (1366 x 768 and up)
+--------------------------------------------------------------------+
| mark Name | Litigation  Voting laws  Redistricting | search | meta |
+---------------------------------------------+----------------------+
|  120W      110W      100W      90W          |  type mark           |
|  +---------------+                 [+]      |  Title               |
|50N| Boundaries   |                 [-]      |  lede in serif       |
|  +---------------+                          |                      |
|            the map, edge to edge            |  sections, each      |
|40N                                          |  separated by a rule |
|                                             |                      |
|  [Contig.][AK][HI][PR][Jump]   [ Legend  ]  |  source line         |
+---------------------------------------------+----------------------+

Phone
+----------------------+
| mark | search        |
+----------------------+
| [States|Counties|..] |
|        the map       |
| [Jump][+][-] [Legend]|
+----------------------+
| Show more map / detail
| record panel         |
+----------------------+
| Map Lit. Laws Dist. Sources |
+----------------------+
```

Everything is left aligned. Nothing is centred except the map itself. Long
documents (methodology, text comparison, source packs) leave the split view and
take the full width as a single column on the sheet colour.

**Principles**

1. The map is the one bold element. Everything around it is quiet.
2. A record never says more than its source. Statuses are quoted, not summarised.
3. Absence is drawn. A gap is hatched and explained, never left blank or pale.
4. Dates and sources sit next to the thing they describe, in plain words.
5. Colour means record type and nothing else.

## Review against the defaults

The skill lists five looks that generated pages cluster around and asks that the
plan be checked against each before any code is written. The table records where
the plan stands on each one and why. It describes the decisions as they are in
the code; the scratch notes behind them were not kept.

| Default look | Where this design stands |
| --- | --- |
| Cream paper, serif display, terracotta accent | The sheet is a cool grey (`#f2f4f8`), not cream. Display type is the sans. The one warm ink, contour brown, is tied to geography records and the population ramp; it is not an accent. Selection and focus use ink navy and a blue focus ring. |
| Near-black with one acid accent | The night side is a dark navy, not black, and it has no accent of its own: what is bright on it is data (a fill, a figure, a name), in the inks that mean a kind of record or, on the party view, a party. The reading panel stays light. |
| Broadsheet with hairlines and zero radius | Hairline rules are used, because a record panel is a list of dated entries. Columns are not: every panel is one column with a 66-character measure. Controls have a 2 to 4 px radius; the map frame has none because a neatline is square. |
| SaaS card kit | No statistic cards, no gradient washes, no uniform card shadow. Counts are stated in sentences inside the coverage notes. Lists are rows separated by rules. Shadows are reserved for things that float above the map. The four-part status block on a bill is a ruled grid because the four answers are parallel questions. |
| Template chrome | No tracked uppercase eyebrows: labels are sentence case. No dot-separated meta strings: meta lines are sentences ("No. 24-109, Supreme Court of the United States"). No monospace data labels: identifiers use the interface sans. No arrows appended to links. Text ink is navy, chosen to match the state lines, not a tinted black. |

Three further decisions came out of the same review:

- **No count-graded shading of lawsuits or bills.** The litigation set is a curated
  sample, so intensity would describe the curation and not the country. Shading is
  either a published count (population) or a plain "has a linked record / not in
  this dataset" pair, with the second class hatched.
- **Italic serif for case names only.** It is the citation convention, so it
  carries information, and nothing else in the interface is italicised for emphasis.
- **Motion only in answer to an action.** The map eases to a selection and that
  is all. It is disabled under `prefers-reduced-motion`.

## Critique from screenshots

Screenshots were taken with Playwright from the production build at 1366 x 768,
820 x 1180 and 390 x 844, and each finding below was fixed and re-shot.

| Finding | Fix |
| --- | --- |
| The map did not render: MapLibre's own class reset the container to `position: relative`, collapsing it to zero height. | A more specific selector pins the canvas to the stage. |
| At 1366 x 768 the open legend covered Florida. | The legend now shows classes and freshness, and keeps the boundary vintage and notes behind a disclosure; fit padding increased. |
| The "Jump to" selector ran under the legend. | Width capped. |
| Place tabs overflowed: "Sources and export" was cut off. | Label shortened to "Sources"; the tab row scrolls. |
| Second pass: with counts in the labels, California's "Sources" tab was still cut off at 1366 px, and a scrolling tab row gives no sign that a tab is hidden. | Tab padding tightened so the five tabs fit one row at desktop width, and the row wraps instead of scrolling, so no tab is ever hidden. A browser test fails if a tab falls outside the row. |
| The export controls could only be found by opening the Sources tab. | An "Export source pack" button sits beside "Add to watchlist" and "Copy link" in the place header. |
| In the bill versions table the word count ran straight into the next column ("34First version"), dates broke over three lines and "Official version" broke over two. | A text column after a number gets its own gutter; dates and the official link stay on one line. A browser test measures the gap. |
| A condition in the bill text (AB 604 on ACA 8) was squeezed into a half-width status cell about 25 characters wide. | When a bill carries a condition, the "Effective date" and "In the courts" cells each take the full width. |
| Returning to the home view left the map zoomed on the last place. | The map re-fits to the national view when the route is home. |
| The "Enactment" cell of a bill's status grid wrapped a two-column fact list badly. | Facts stack inside status cells. |
| The redistricting "Show" control wrapped to two rows. | Labels shortened. |
| On a phone the map was hidden behind the bottom sheet, and controls overlapped each other. | The phone layout was rebuilt: the map takes exactly the area above the sheet, the map re-fits when the sheet moves, and the zoom, jump and legend controls share one row at the bottom of the map. |
| A county's timeline listed every statewide legislative action (about 800). | A control limits the timeline to records that name the place. |
| The title of a view and its tabs sat on the same white as the text below, so the panel had no head. | The title block and the tabs sit on a band of the sheet colour that runs to the panel's edges, closed by a rule. |
| Section headings (16px) read as bold body text; sections ran together. | Section headings are 18px and each section opens with a short ink tick on its rule. |
| A place opened with a population table before the records the reader came for. | The overview lists the records tied to the place first, then related geography, then population. The boundary file is named under related geography, not in the header. |
| Case names that a court's record writes in capitals shouted among the others. | Such a name keeps its letters and is set a size smaller. |
| The coverage note was a tinted box competing with the records. | It is a quiet sentence in the secondary ink. |
| Court of appeals documents were labelled "Court Court document". | The label is "Other document". |
| The table of what was read for each court had eight columns and scrolled sideways on a phone. | Two tables of five and four columns, with smaller figures on a phone. |
| With the federal level there were two kinds of thing to choose on the map. | Two labelled groups share one control: Level (Federal, States, Counties, Districts) and Courts (Supreme Court, Circuits, with a menu of the thirteen courts). |

## Identity

The mark, the social card and the decorative drawing on the About page are frames
of one generative study, "Isoline Assembly", made with the `algorithmic-art` skill.
See [`README.md`](README.md) in this folder.
