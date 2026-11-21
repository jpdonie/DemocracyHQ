# Design

| File | What it is |
| --- | --- |
| [`DESIGN_PLAN.md`](DESIGN_PLAN.md) | The interface design plan: concept, tokens, layout, the review against default looks, and the critique from screenshots. |
| [`identity/isoline-assembly.md`](identity/isoline-assembly.md) | The algorithmic philosophy behind the identity. |
| [`identity/isoline-assembly.html`](identity/isoline-assembly.html) | The interactive generative study. Open it in a browser. |
| [`identity/renders/`](identity/renders/) | Stills of the study at three seeds, and the mark at 256 px. |
| [`export-motif.mjs`](export-motif.mjs) | Runs the study's own code in Node and writes the brand assets. |

## The identity is one algorithm

"Isoline Assembly" was made with the `algorithmic-art` skill, in the order the
skill prescribes: the philosophy was written first, then the piece was built from
the skill's `templates/viewer.html`. The template's layout, sidebar structure, seed
controls, fonts and interface colours are unchanged. The algorithm, its parameters
and their controls are this project's.

The study draws concentric lines that start as noise and relax until none of them
cross. Stretches that are "not recorded" are hatched instead of being smoothed
over, which is the same rule the application follows for data gaps.

It draws nothing geographic. It is not a map, it contains no boundary, district or
data, and none of its output is presented as either.

The brand assets are frames of that process:

| Asset | Frame |
| --- | --- |
| `src/components/brandPaths.ts`, the mark in the navigation bar | Seed 1848, three benches |
| `public/brand/mark.svg`, the favicon | The same three paths on ink navy |
| `public/brand/motif.svg`, the drawing on the About page | Seed 1848, twenty-four benches |
| `public/brand/social-card.png`, the link preview | The same drawing with the name and positioning line |

## Regenerating the assets

```sh
node design/export-motif.mjs          # SVG assets and brandPaths.ts
node design/export-motif.mjs --png    # also the PNG files (needs Playwright)
```

The script reads the code between the `<motif-core>` markers in
`identity/isoline-assembly.html` and runs it unchanged, so there is one source for
the algorithm. To change the mark, change the seed or the parameters in
`markPaths()` and run the script again. Do not edit `brandPaths.ts` by hand.

## Viewing the study

`identity/isoline-assembly.html` is a single self-contained file. It loads p5.js
1.7.0 from cdnjs and the template's two fonts from Google Fonts, exactly as the
skill's template does, so it needs a network connection the first time. The
application itself loads nothing from either host.
