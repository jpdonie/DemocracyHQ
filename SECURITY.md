# Security policy

## Reporting a vulnerability

Please report security problems privately, through GitHub's private vulnerability
reporting: open this repository's **Security** tab and choose **Report a
vulnerability**. Do not open a public issue, pull request or discussion for a
security problem. If the button is missing, private reporting has not been
switched on for this copy of the repository; open an issue that asks for a
private contact and leave the details out.

Include what is affected (the site, the data pipeline or a workflow), how to
reproduce it, and what an attacker could do with it.

## What counts

- Anything that runs script in a visitor's browser that the site did not ship,
  for example through a data file, an address or a pasted link.
- The site sending a request to another host, or sending anything about a visitor
  anywhere. The site is meant to make no third-party requests at all.
- A way to get anything other than a `.json` data file published under
  `public/data/`, which the site serves from its own address.
- A way for an upstream source's response to make the pipeline write outside its
  own folders, run a program, publish data that did not pass validation, or run
  past its request deadline or memory bounds.
- A way to make the pipeline send an API key to a host other than the one it is
  meant for, or over plain http.
- A way to read the repository's secrets or the workflow token, or to make a
  workflow run code that was not reviewed with write access to the repository or
  to GitHub Pages.
- A compromised or malicious dependency or GitHub Action used by this repository.

## What is in place

These describe the code in this repository. Telling us where one of them falls
short is a useful report.

- **The site.** Built pages carry a Content-Security-Policy as a meta tag: scripts,
  styles, fonts, data, the map's worker and the web manifest may come only from
  the site's own origin, and images also from `data:` addresses. On a github.io
  address that origin is shared with the account's other GitHub Pages sites.
  Nothing may be used as a base address, receive a form or load as a plugin, and
  eval is not allowed. A second meta tag sets a no-referrer policy. The
  development server has neither. The browser tests fail on any request outside
  the site's own address and sub-path.
- **Published data.** The scheduled ingestion workflow runs the pipeline in a job
  whose token can only read the repository. It hands the validated data to a
  separate commit job, which takes from it only folders and regular `.json` files
  with plain names under `public/data/`, plus `pipeline/staging/review.json`, and
  stops before unpacking anything else. `scripts/validate-data.mjs`, which runs
  before every scheduled commit, in CI and before every deployment, fails if
  `public/data/` holds any file that is not a `.json` file the data refers to,
  hidden files included.
- **Requests.** Every request the pipeline makes has an overall deadline (15
  minutes, retries and waits included) that holds however slowly a server sends,
  and reads at most 256 MB of a response. Redirects are followed by the pipeline
  itself, at most five, never from https to plain http. A request that carries a credential
  (an `Authorization`, `Proxy-Authorization`, `X-API-KEY` or `Cookie` header)
  follows a redirect only to the same host and port over https.
- **Archives.** A ZIP member that is read whole is refused before it is read if
  its stated size is above a limit (256 MB for one member, 64 MB for a bill text,
  and 1 GB for all the members of a Census boundary archive). Such members are
  inflated in bounded steps, and one that does not come out at exactly its stated
  size is refused. A Census count table that is read line by line instead is not
  checked against a size limit; each of its lines may be at most 1 MB long.
- **File writes.** The pipeline's file-writing helpers refuse a path that names a
  parent folder (`..`), and, when given the folder a file must stay in, any path
  that resolves outside it. A California bill id must have the form
  `ca-<session years>-<type><number>` before any file is named after it; a row
  that does not is reported and skipped. The members of a Census boundary archive
  are unpacked under their bare file names.
- **Workflows.** Every action from another repository is pinned to a full commit
  SHA. Only the commit job of the ingestion workflow can push to the repository,
  and it runs no npm or PyPI package. npm packages are installed with
  `npm ci --ignore-scripts`, and the pipeline's Python packages from hash-locked
  files with `pip install --require-hashes --only-binary=:all:`.

## Known limits

- A step of the ingestion job, including any npm or PyPI package it runs, can read
  the API keys from the runner's memory and can change the `.json` data it hands
  over and the Actions cache entries that later runs restore. It cannot push, and
  it cannot hand over any other kind of file.
- Downloaded source files are reused from the Actions cache only during the ISO
  week in the cache entry's name. On reuse, a California file must match the size
  and CRC-32 the archive's directory gives, and a Census boundary archive the
  server's Last-Modified date and Content-Length. Neither is a check against
  tampering.
- The request deadline is enforced by shutting down the request's connections,
  so it cannot cut short a DNS lookup, which only the system resolver bounds. A
  ZIP archive's central directory is read whole, bounded only by the size of the
  archive.
- A meta tag cannot set `frame-ancestors`, and GitHub Pages cannot send response
  headers, so another site can show these pages in a frame.
- On a github.io address, other sites served from the same github.io address can
  read and change the watchlist, which is kept in the browser's local storage.
  The watchlist page says so.

## What does not count

- A record that is wrong, out of date or missing. Please use the **Data
  correction** issue form instead.
- Problems in GitHub, GitHub Pages or an upstream source themselves. Please report
  those to their owners.
- The known limits above, unless a report shows a way past what they describe.
- Scanner output that does not show how this project is affected.

## Supported versions

Only the default branch, and the site deployed from it, are maintained.
