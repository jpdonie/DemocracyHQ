# Skill audit

The brief asked for three agent skills to be verified and actually used:
`algorithmic-art`, `frontend-design` and `webapp-testing`. This page records what
was really available in the build session of 2026-11-20, how each was loaded, what
it changed in the result, and where the use fell short of the skill's own
instructions. It separates what was executed from what was only read.

## Summary

| Skill | In the session's skill registry | How it was loaded | Used |
| --- | --- | --- | --- |
| `algorithmic-art` | **Yes** | Invoked with the Skill tool | Yes, following its two steps in order |
| `frontend-design` | **No** | Its official instruction file was downloaded and read | Its process was followed by hand. Not a skill invocation. |
| `webapp-testing` | **No** | Its official instruction file and helper script were downloaded | The helper script was executed and its method used for exploration. Not a skill invocation. |

"In the registry" was checked twice in that session: against the skills listed to
the Skill tool at its start, and with a later listing of the account's enabled
skills, which returned `algorithmic-art` and no entry named `frontend-design` or
`webapp-testing`.

## algorithmic-art

- **Requested as** `/anthropic-skills:algorithmic-art`.
- **Available as** the registered skill `anthropic-skills:algorithmic-art`.
- **Loaded** by one Skill tool call near the start of the build session, which
  returned the skill's instructions.
- **What the skill prescribes, and what was done**

  | Instruction | Done |
  | --- | --- |
  | Write an algorithmic philosophy first, as a Markdown file | [`design/identity/isoline-assembly.md`](../design/identity/isoline-assembly.md), written before any code |
  | Read `templates/viewer.html` and use it as the literal starting point; keep its layout, sidebar structure, seed controls, fonts and interface colours | [`design/identity/isoline-assembly.html`](../design/identity/isoline-assembly.html) is built from that template. The algorithm, its parameters and their controls were replaced. Later, the template's seven colour variables were renamed to neutral role names (their values are unchanged), and the header comment was rewritten to say that the file is a modified version of the template and that the template is under the Apache License 2.0. The layout, sidebar structure, seed controls, fonts and colour values are the template's. |
  | Seeded randomness, parameter controls, seed navigation, a single self-contained HTML file loading p5.js from a CDN | Present |
  | Original work, not a copy of an existing artist | The algorithm is the project's own: concentric lines that begin as noise and relax until none cross, with unrecorded stretches hatched |

- **What it contributed to the product.** The mark in the navigation bar, the
  favicon, the drawing on the About page and the link-preview card are frames of
  that one study, exported by [`design/export-motif.mjs`](../design/export-motif.mjs),
  which runs the study's own code unchanged. Files:
  `src/components/brandPaths.ts`, `public/brand/mark.svg`,
  `public/brand/motif.svg`, `public/brand/social-card.png`, and the stills in
  `design/identity/renders/`.
- **Verification.** The study was opened in headless Chromium and rendered at
  several seeds. To check that a seed reproduces, seeds 1848 and 42 were each
  rendered in two separate browser runs and the canvas images were
  byte-identical (same SHA-256). The stills in `design/identity/renders/` (seeds
  1848, 42 and 311, and the mark at 256 px) were written by
  `node design/export-motif.mjs --png`, which runs the study's own drawing code
  in Node and photographs the result in headless Chromium.
- **Shortfalls and caveats**
  - The build environment blocked `cdnjs.cloudflare.com`. For rendering, the page's
    request for p5.js was answered from a local copy of the same version (1.7.0).
    The committed HTML file still points at the CDN, as the template does, and was
    **not** tested loading from the CDN.
  - The study loads two fonts from Google Fonts, as the template does. So the study
    file makes third-party requests when opened. The application does not.
  - The template is used under the Apache License 2.0. [NOTICE](../NOTICE) records
    that the study is a modified version of it and what was changed.
  - The skill is written for art that stands on its own. Here its output is also
    used as an identity mark. The study draws nothing geographic and none of its
    output is presented as a map or as data.

## frontend-design

- **Requested as** `frontend-design`.
- **Available as** nothing in this session's registry. It could not be invoked.
- **What was done instead.** The official `SKILL.md` was downloaded from the public
  `anthropics/skills` repository on GitHub (`skills/frontend-design/SKILL.md`,
  repository head `e4bb5d960d87126ff3b3a8af1a104b7db67560ba` at the time) and read
  in full. Its process was then followed by hand: state the subject, audience and
  job; write a compact plan with tokens; review the plan against the looks that
  generated pages cluster around; build; critique from screenshots.
- **This is not the same as invoking the skill.** No skill runtime, bundled asset
  or tool was involved. The claim is only that the instruction file was read and
  its process followed.
- **What it contributed.** [`design/DESIGN_PLAN.md`](../design/DESIGN_PLAN.md)
  records the concept (the printed survey sheet), the colour, type and layout
  tokens, the review against the five default looks the skill lists, and the
  critique from screenshots with the fix made for each finding. The tokens are in
  `src/styles/tokens.css`.
- **Verification.** Screenshots of the production build at 1366 x 768, 820 x 1180
  and 390 x 844 were taken with Playwright and looked at; the findings table in
  the design plan lists what was wrong and what changed.
- **Shortfalls**
  - The skill asks that the plan be reviewed against the defaults *before* any code
    is written. The review happened, but the notes from that moment were not kept.
    The table in the design plan was written afterwards from the decisions as they
    stand in the code, and says so.
  - The skill suggests confirming the subject, audience and job with the client.
    They were taken from the written brief and not confirmed in conversation.
  - The licence terms referenced by the skill file (`LICENSE.txt`) were not
    downloaded or read. Nothing from the skill is redistributed in this repository.

## webapp-testing

- **Requested as** `webapp-testing`.
- **Available as** nothing in this session's registry. It could not be invoked.
- **What was done instead.** The official `SKILL.md` and its helper
  `scripts/with_server.py` were downloaded from the same repository and commit.
  The skill's method is: write native Python Playwright scripts, manage the server
  with the helper, and work reconnaissance first (load, wait for the network to be
  idle, look at a screenshot or the rendered DOM, then act).
- **What was actually executed.** As the skill instructs, the helper was first run
  with `--help` and then used to start the preview server around Python Playwright
  scripts. Those scripts loaded each view of the production build, waited for
  network idle, saved screenshots, and reported console errors and failed
  requests. This is how the first rendering bugs were found, including a map that
  drew at zero height and a phone layout that hid the map behind the sheet.
- **What it contributed to the repository.** The method, not the files. The
  exploratory Python scripts and their screenshots lived in a scratch folder and
  are not in the repository. The committed browser tests in `tests/e2e/` are
  written with `@playwright/test` in TypeScript, which is the better fit for a
  Node project's CI. They follow the same reconnaissance-first approach (selectors
  were taken from accessibility snapshots of the rendered pages) but they are not
  the skill's Python scripts, and the skill did not generate them.
- **Verification.** The committed browser suite has 217 tests in 15 files (175
  run at desktop size and 42 with a phone profile); see the
  [data validation report](DATA_VALIDATION_REPORT.md) for the latest results.
- **Shortfalls**
  - Not a skill invocation, for the same reason as above.
  - The skill's helper is not used by the committed tests, which start their own
    server (`scripts/serve-subpath.mjs`) through the Playwright configuration.

## Other skills and agents

- `workflow-authoring` was loaded when the independent reviews, the fix,
  verification and repair rounds that followed them, and the final documentation
  pass were run as multi-agent workflows. It shaped how that work was orchestrated
  and did not itself produce product content or document text.
- The independent reviews described in the validation report were carried out by
  separate reviewer agents that were told not to change the repository. Their
  findings are reported there as theirs. The fixes that followed were made by
  other agents and checked by a separate verifier agent; the repairs made after
  each verifier's report were not checked again.
- No other skill was used. In particular no skill was used to write the
  pipeline, the data model or the documents.

## Missing capability

Two of the three requested skills were not installed in the environment. If they
are installed later, the honest next step is to invoke them and compare what they
produce with what is here, not to relabel this work as theirs.
