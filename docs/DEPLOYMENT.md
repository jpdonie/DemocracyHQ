# Deployment

DemocracyHQ is a folder of static files. It is designed for GitHub Pages and works
on any static host, at a domain root or under a sub-path, with no rewrite rules.

> **First runs on GitHub.** The site is published at <https://democracy-hq.org/>
> (GitHub Pages; the github.io address redirects there). The CI and deploy workflows have run on
> GitHub since 2026-11-21; the scheduled ingestion workflow has not run there yet.
> Every action the workflows use is pinned to a full commit SHA with its version in
> a comment. Treat the first ingestion runs as a test and read their logs.

## What was tested locally

The production build was served by `scripts/serve-subpath.mjs` under
`/democracyhq-preview/`, with every address outside that path answering 404 and
no fallback to `index.html`. That is how a GitHub Pages project site behaves. The
browser tests run against that server and fail if any request leaves the sub-path.
The smoke test that the deploy workflow runs before it publishes was also run
locally against a production build, with the Content-Security-Policy in place.

## Publishing to GitHub Pages

1. Create a repository on GitHub and push this project to its `main` branch. The
   push starts the deploy workflow, which fails at its first Pages step until
   step 2 is done; step 7 runs it again.
2. In the repository, open **Settings > Pages** and set **Source** to
   **GitHub Actions**.
3. Create the label `data-correction` (**Issues > Labels > New label**). The
   **Data correction** issue form adds it to each report; GitHub leaves out a label
   that does not exist, so the form works without it, but the reports are then
   unlabelled.
4. Turn on **private vulnerability reporting** in the repository's security
   settings. [SECURITY.md](../SECURITY.md) asks people to report security problems
   that way, through the **Security** tab.
5. If `main` is protected by a rule that requires pull requests or status checks,
   let the GitHub Actions bot bypass it, or the scheduled ingestion cannot push
   (see Branch protection below).
6. Optionally, add the keys and settings described under
   [Secrets and variables](#secrets-and-variables).
7. Push to `main`, or run the **Deploy to GitHub Pages** workflow by hand from the
   **Actions** tab.

The deploy workflow checks out the commit without keeping the token, installs the
npm packages without running their install scripts, type-checks, runs the unit
tests and validates the published data. The data check fails on invalid data and
on any file under `public/data/` other than the `.json` files the data refers to,
because Vite copies that folder into the site as it is. The workflow then builds,
installs Chromium and runs a browser smoke test of that build served under a
sub-path (`tests/e2e/subpath.spec.ts`, the "Static hosting under a sub-path"
tests, on the desktop project). Only if all of that passes is `dist/` uploaded to
Pages. If the smoke test fails, its report is kept as a workflow artifact for 7
days. The workflow sets two build-time values for you:

| Variable | Set to | Effect |
| --- | --- | --- |
| `VITE_REPO_URL` | the repository's address | Turns on the "Report a correction" links, which open a pre-filled GitHub issue |
| `VITE_SITE_URL` | the Pages address | Makes the link-preview image address absolute |

Both are public. Neither is a secret.

The built `index.html` carries a Content-Security-Policy meta tag (scripts,
styles, fonts, data and the map's worker from the site's own address only) and a
no-referrer policy. GitHub Pages cannot send response headers, so framing the
site by other pages cannot be forbidden there: `frame-ancestors` works only as a
header.

### A custom domain

No code change is needed, because the build uses relative paths. The steps, in this
order (the public site uses `democracy-hq.org`):

1. At the domain's DNS host, add four `A` records for the domain itself
   (`185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`),
   optionally four `AAAA` records (`2606:50c0:8000::153` to `2606:50c0:8003::153`),
   and a `CNAME` record from `www` to `<owner>.github.io`. On Cloudflare, set every
   one of them to "DNS only": through Cloudflare's proxy, GitHub cannot issue the
   certificate, and features that add scripts to the pages would be blocked by the
   Content-Security-Policy and would add requests to a third party.
2. Verify the domain for the GitHub account (account **Settings > Pages > Add a
   domain**) with the `TXT` record GitHub shows, and keep that record. A verified
   domain cannot be attached to another account's repository.
3. Enter the domain in the repository's **Settings > Pages**, wait for "DNS check
   successful" and the certificate, then tick **Enforce HTTPS**.

Do not enter a domain in **Settings > Pages** before its DNS records exist: GitHub
then redirects the github.io address to a domain that does not answer.

A custom domain also gives the site an origin of its own, so the watchlist kept in
the browser is no longer shared with the account's other github.io sites.

If the domain sends no mail, `TXT` records `v=spf1 -all` (on the domain) and
`v=DMARC1; p=reject` (on `_dmarc`) stop others from sending mail in its name.

## Scheduled ingestion

`.github/workflows/ingest.yml` runs the pipeline on a schedule:

| When (UTC) | Stages |
| --- | --- |
| Every day, 10:23 | Supreme Court dockets, California legislation, and the two optional sources |
| Mondays, 09:41 | Everything, including boundaries and Census counts |

It can also be started by hand from the **Actions** tab with a list of stage
names separated by spaces: blank runs the daily set, `all` runs every stage, and
any name the pipeline does not know stops the run before the pipeline starts. A
run started by hand works only from the default branch; from any other branch it
fails at once with an error and does nothing. Runs never overlap: a run that
starts while another is under way waits for it (GitHub keeps only the newest
waiting run).

### What a run does

A run has three jobs.

**`ingest`** has a token that can only read the repository. It is the job that
installs and runs packages.

1. It checks out the tip of the default branch, not the commit the run was created
   for, without keeping the token, and records which commit that is.
2. It installs the npm packages without their install scripts, the pipeline's
   Python packages from the hash-locked `pipeline/requirements-lock.txt`
   (`pip install --require-hashes --only-binary=:all:`), and poppler-utils
   (`pdftotext` for the text of court documents, `pdftohtml` for the layout of
   an opinion's first pages).
3. It restores this week's cache of downloaded source files and the review queue
   of the last committed run (see below), and prints a warning if no earlier
   review queue was found.
4. It runs the pipeline (`python -m dhq.run <stages> -v`) and keeps its log.
5. It saves the source cache if this week has no entry yet for this version of
   the pipeline code, even when the pipeline failed.
6. It validates the data again with the site's schemas (`npm run data:validate`).
7. It hands the validated `public/data/` and the review queue to the next job as
   an artifact kept for 1 day.
8. Whatever happened before, it uploads the run log and the review queue as the
   artifact `ingestion-<run id>-<attempt>`, kept 30 days.
9. If the pipeline exited with code 1, it marks the job as failed, after the
   hand-over, so the data is still committed.

**`commit`** is the only job whose token can push, and it runs no npm or PyPI
package: only GitHub's own checkout, artifact and cache actions, tar and git. It
runs when the data passed validation and the run was not cancelled.

1. It checks out the commit the data was rebuilt from and fetches the artifact.
2. It accepts only folders under `public/data/` whose names use `a-z`, `0-9`, `_`
   and `-`, regular `.json` files in them, and `pipeline/staging/review.json`.
   Any other entry (an HTML page, a script, a link, a path elsewhere) stops the
   job before anything is unpacked.
3. It replaces `public/data/` with the validated copy and stages it. If nothing
   changed, it stops there.
4. If `main` has moved since the data was rebuilt from it, it stops with an
   error and commits nothing, so data rebuilt from an older commit never replaces
   newer data or a correction. Otherwise it commits and pushes.
5. Once that step has succeeded, whether or not there was a change, it saves the
   review queue to the Actions cache for the next run.

**`deploy`** calls the deploy workflow for the default branch when the commit job
pushed a change and the run was not cancelled. Commits made with the workflow
token do not start other workflows, so without this job the site would not be
rebuilt. It runs even when the ingest job was marked failed for exit code 1, so
the failure and its date become visible on the site's Sources page.

### What each outcome does

| Pipeline result | Ingest job | Commit and deploy |
| --- | --- | --- |
| Exit code 0 | Passes | Commits if the data changed; deploys if it committed |
| Exit code 1, and the log shows that the pipeline published | Warns, validates and hands over the data, then fails at the end | Commits and deploys as for 0 |
| Exit code 1 without that log line (Python stopped before the pipeline ran, for example because the `dhq` package was not found) | Fails with an error | Skipped |
| Exit code 2: the pipeline's own validation failed | Fails; nothing was published | Skipped |
| Exit code 3: publishing failed | Fails; the published data was left as it was | Skipped |
| Exit code 4: arguments refused, the pipeline could not be loaded, or an error outside its stages | Fails; nothing new was published | Skipped |
| Any other code (for example a killed process) | Fails | Skipped |
| The pipeline passed but `npm run data:validate` failed | Fails; nothing is handed over | Skipped |

Exit code 1 means that a stage or a source failed, or that a case or bill has not
been refreshed for longer than its source allows. Failed sources keep their last
published data and are marked as failed on the Sources page; everything else was
rebuilt and is committed. A source marked `credential_missing` does not fail the
run. [ARCHITECTURE.md](ARCHITECTURE.md#failure-safety) lists the causes of each
code.

**A cancelled run** commits nothing if it is cancelled before the commit job, and
does not deploy if it is cancelled after the commit. The committed data then goes
live with the next deploy: the next push to `main` or the next ingestion that
commits. Run **Deploy to GitHub Pages** by hand to publish it sooner.

**Re-running.** The ingest job always starts from the tip of the default branch,
so after a partial failure, **Re-run failed jobs** runs the whole ingestion again
from the latest data. If the commit job stopped because `main` moved, use
**Re-run all jobs** or start a new run: re-running only the commit job repeats the
check against the same older commit.

### The source cache

Downloaded source files are kept in `pipeline/.cache/` and carried between runs
with `actions/cache`, in one entry per ISO week and version of the pipeline code.
An entry is restored only during the week in its name; there is no fallback to an
earlier week. So the first run of each week, normally the Monday full run, which
comes before that day's daily run, starts from an empty cache and downloads every
source file again: about 65 MB of Census boundary archives, the California tables,
and each bill text (563 in this release) by range request. It saves the week's
entry. Later runs that week reuse it and save nothing; a run with changed pipeline
code starts from the week's entry and saves one for the new code.

A cached California table or bill text is reused only if it has the size and
CRC-32 that the current archive's directory gives for it, and a boundary archive
only while the Census server reports the same Last-Modified date and size. These
checks catch a stale or truncated copy, not a deliberately altered one. What
limits an altered entry is its week: GitHub also deletes an entry that no run has
read for 7 days.

### The review queue

Anything the pipeline could not confirm is listed in
`pipeline/staging/review.json`, which is in each run's artifact. That includes
every curated link or tag whose quoted passage was not found, which is not
published. A run carries over the earlier items of the stages it did not run, or
that failed in it, such as the weekly Census stages on a daily run. That is why
the queue of the last committed run is restored at the start of each run and
saved once its data is committed. The site shows only the number of items in the
queue of the latest release and the count of each kind; the items themselves are
in the run's artifact.

If the cache entry is missing (on the first run, or after 7 days without a run),
the run prints a warning and the queue starts with only that run's items until
the other stages run again.

### Things to know before relying on it

- **Branch protection.** The commit job pushes to the default branch with the
  workflow token. If `main` requires pull requests or status checks, the push is
  refused with an error and the data stops updating. Either allow the GitHub
  Actions bot to bypass the rule or change the job to open a pull request.
- **Pushing during a run.** A push to `main` while the pipeline runs makes that
  run's commit job stop without committing. The next run starts from the new tip.
- **Inactive repositories.** In a public repository, GitHub disables scheduled
  workflows after 60 days without activity. The ingestion commits count as
  activity only while the data keeps changing.
- **Commit volume.** A run that finds changes commits them. Records carry a
  "last checked" time, so most daily runs will produce a commit that touches many
  files. If the history becomes unwieldy, publish the data from a separate branch
  or as a release asset instead.
- **Run time.** The California archive is about 1.3 GB at the source and is read
  by range request, not downloaded. The pipeline spaces its requests to
  supremecourt.gov at least 1.1 seconds apart, a little more than the one-second
  crawl delay the Court's `robots.txt` sets, so the Supreme Court stage takes at
  least a second for each request it makes. The ingest job has a limit of 120
  minutes; a single request is cut off after 15 minutes.
- **Upstream changes.** If a source changes its format, the stage for that source
  fails, its last published data stays published, and the Sources page shows the
  date of the last successful check. Nothing is overwritten with a response that
  failed to parse.
- **What a compromised package could do.** The ingest job holds the API keys for
  the pipeline step, and any step of that job, including an installed package,
  could read them from the runner's memory and could change the data it hands
  over or the cache entries later runs restore. It cannot push, and it cannot hand
  over anything but `.json` files under `public/data/` and the review queue. The
  hash-locked Python install, the npm lock file, skipped install scripts and
  actions pinned to commit SHAs narrow that risk; they do not remove it.

## Hand-run checks

Two tools check a release against the live sources. They need the network, are
run by hand from the `pipeline/` folder with the pipeline's Python packages
installed, and are not part of any workflow.

```sh
cd pipeline
python -m tools.verify_dockets            # every docket; --limit N for the first N
python -m tools.check_links --sample 15   # per host (default 40, 0 = all); --host HOST
```

`tools.verify_dockets` fetches the Court's docket page for each published docket,
1.1 seconds apart, and compares the docket number, both titles, the docketed date,
every entry's date and text, and every document link with what is published. An
entry the Court added after the last pipeline run is reported, and its document
links on www.supremecourt.gov count as differences; run the pipeline first.
`tools.check_links` sends a HEAD request to an evenly spaced sample of the
addresses in `public/data/` (outside mirrored bill text) on each host, one request
a second. It never requests `leginfo.legislature.ca.gov`, which blocks automated
clients, or the optional sources' API hosts.

`tools.verify_dockets` exits with code 1 on any difference, including a document
link on the Court's page that is not in the published data, or on a page it could
not fetch; a new entry without a document link does not count by itself.
`tools.check_links` exits with code 1 when any sampled address does not answer
200. Otherwise both exit with 0. A reachable address does not show that the page
says what the record says. The [README](../README.md#data-pipeline) describes both
tools.

## Secrets and variables

None is required. The base dataset builds without any key or setting. Add them
under **Settings > Secrets and variables > Actions**: the two keys on the
**Secrets** tab, the two settings on the **Variables** tab.

| Name | Kind | Purpose |
| --- | --- | --- |
| `COURTLISTENER_API_TOKEN` | Secret | Optional. Lets the CourtListener adapter run. |
| `OPENSTATES_API_KEY` | Secret | Optional. Lets the Open States adapter run. |
| `DHQ_USER_AGENT` | Variable | Optional. The client name the pipeline sends (see Operator identity). |
| `OPENSTATES_JURISDICTIONS` | Variable | Optional. Comma-separated Open States jurisdictions; blank means `tx,fl,nc,oh`. |

The workflow reads `DHQ_USER_AGENT` and `OPENSTATES_JURISDICTIONS` only as
repository variables: a secret with either name is ignored. The keys and settings
are given only to the pipeline step and are never written to a file or built into
the site; see above for what another step of the same job could still read. For
local use, copy `.env.example` to `.env`, which is git-ignored. The workflow does
not pass `DHQ_NOW`, and the pipeline ignores it outside its tests unless
`DHQ_ALLOW_NOW=1` is also set.

Both optional adapters have been exercised only with synthetic test responses.
They have never run against the live services. What they import is published as
a separate file (`public/data/litigation_secondary.json` or
`legislation_secondary.json`), committed and deployed with the rest of the data;
the site does not display it. Turning them on is the start of that work, not the
end of it.

Do not put any key in a variable whose name starts with `VITE_`: Vite builds those
into the public site.

## Operator identity

The pipeline identifies itself to sources with a generic client name. If you run a
public deployment, set the `DHQ_USER_AGENT` repository variable to a name with a
contact address so a publisher can reach you. The pipeline never imitates a
browser and never works around a block.

## Dependencies in the workflows

- Every action is pinned to a full commit SHA, with its version in a comment.
- npm packages are installed with `npm ci --ignore-scripts` from
  `package-lock.json`.
- The pipeline's packages are installed from `pipeline/requirements-lock.txt`
  (runtime) or `pipeline/requirements-dev-lock.txt` (adds pytest, for CI) with
  `pip install --require-hashes --only-binary=:all:`, so pip installs exactly the
  pinned versions and refuses any file whose SHA-256 is not listed.
  `requirements.txt` and `requirements-dev.txt` keep the version ranges for local
  work.
- Dependabot (`.github/dependabot.yml`) opens weekly pull requests for the
  actions, the npm packages and the pipeline's packages, and CI runs on each.

To change a pinned Python package by hand, change its version in the lock file
together with all its hashes (those PyPI lists for that version: its source
archive and every wheel CPython 3.13 can install), keep it inside the range in
`requirements.txt`, and keep `pydantic-core` at the version `pydantic` requires.
Then install the lock file with the same `pip` command in a fresh environment and
run the pipeline tests.

## Other static hosts

```sh
npm ci
npm run data:validate
npm run build
```

Upload `dist/`. To get the correction links, set `VITE_REPO_URL` when building. A
host that can send response headers can add `Content-Security-Policy:
frame-ancestors 'none'`, which a meta tag cannot set. The pipeline can be run from
any scheduler that can commit or upload the contents of `public/data/`.

## Rolling back

The published data is in git. To return to an earlier release, revert the
ingestion commit and let the deploy workflow run. The next scheduled ingestion
rebuilds the data from the sources again.
