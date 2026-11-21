# Isoline Assembly

*An algorithmic philosophy. It was written before any code, following the two-step
workflow of the `algorithmic-art` skill, and is expressed by
[`isoline-assembly.html`](isoline-assembly.html).*

A chamber is a contour drawing that nobody admits to. Rows of benches curve around a
single point the way lines of equal height curve around a summit, and both drawings
obey one law: the lines may crowd, lean and bend, but they may never cross. Isoline
Assembly treats that law as its whole subject. It does not draw a place and it does
not draw a parliament. It grows a set of concentric lines that begin in disorder and
are made to agree with one another, and the image is whatever agreement they reach.

Every line starts as noise. Each bench is a string of samples scattered around the
radius it is supposed to hold, seeded so that the same number always scatters the
same way. The first frame is a tangle. Then the system is released: each sample is
pulled toward a slowly varying displacement field built from layered value noise,
smoothed by tension along its own line, damped so that motion dies away, and held
apart from its inner neighbour by a hard minimum spacing. Order is not drawn; it is
what remains when those four pressures have finished arguing. The work is the
settling, and the still image is only its last frame. This calibration, the ratio of
pull to tension to damping, has to be tuned with the patience of an instrument
maker, because a meticulously crafted relaxation reads as deliberation and a
careless one reads as jitter.

The displacement field is the terrain the assembly sits on. Low frequencies lean
whole blocks of benches together; higher octaves put a tremor in a single row. The
field is tapered to nothing at the two ends of the arc so that the open side closes
on clean aisles. Grain, amplitude and tension are exposed as parameters, and the
algorithm must stay beautiful across their whole range, which is the difference
between a parameter and a liability. Getting there is painstaking work: the product
of deep computational craft, refined run after run until no seed in a hundred
produces a frame that looks accidental.

Some of every line is missing, and the missing parts are the conscience of the
piece. A second, slower field decides where a bench is simply not recorded, and
there the line stops and is replaced by short radial hachures: a visible mark that
says "nothing was measured here" instead of a smooth guess across the gap. The
share of absence is exact, set by quantile and not by chance, so that asking for a
seventh of the drawing to be unknown yields exactly a seventh. A master-level
implementation never interpolates across what it does not know.

Three inks carry the strata, borrowed from the separate plates of a printed survey
sheet: brown for ground, green for what has been planted on it, purple for what was
revised afterwards. Every fifth line is an index line and prints heavier, as
contours do. A sparse scatter of dots takes seats along some benches at equal arc
length and leaves the hachured stretches empty. Around everything runs a neatline
with ticks and no numbers, because this sheet has no coordinates to claim. The
restraint is deliberate, and it is where most of the hours go: line weights,
spacings and the three inks were adjusted against one another until the page held
together at any seed, the way a plate is proofed by someone at the very top of the
craft.

The algorithm is deterministic end to end. A seed fixes the scatter, the terrain,
the absences and the seating, and the relaxation runs a fixed schedule, so one seed
is one drawing forever. That is what lets a single frame of the same process, at
three benches instead of thirty, be lifted out and used as a mark.
