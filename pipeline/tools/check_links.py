"""Sampled reachability check of the outbound links in the published dataset.

    cd pipeline && python -m tools.check_links [--sample N] [--host HOST]

Every address in public/data/ is collected and grouped by host, except those
inside mirrored bill text (public/data/legislation/text/), where an address is
part of the legislature's wording and not a link DemocracyHQ offers. For each
host that allows automated requests, an evenly spaced sample of its addresses
is requested with HEAD, one request a second, and the status is reported. The
sample is deterministic: the same dataset gives the same sample.

Hosts that are never requested:

* leginfo.legislature.ca.gov blocks automated clients. Its links are built from
  official identifiers for people to follow, and this tool does not test them.
* The API hosts of the optional sources need a key.

A reachable address is not proof that the page says what the record says. That
is what the quote checks in the pipeline and tools.verify_dockets are for.
It needs the network and is not part of the test suite.

Exit status 0 means every sampled address answered 200.
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import defaultdict
from pathlib import Path

from dhq.http import FetchError, Fetcher

REPO = Path(__file__).resolve().parents[2]
DATA = REPO / "public" / "data"
URL = re.compile(r'https?://[^"\\\s<>]+')
NEVER_REQUESTED = {
    "leginfo.legislature.ca.gov": "blocks automated clients; links are for people to follow",
    "www.courtlistener.com": "API of an optional source; needs a key",
    "v3.openstates.org": "API of an optional source; needs a key",
}


def collect(data: Path = DATA) -> dict[str, list[str]]:
    by_host: dict[str, set[str]] = defaultdict(set)
    text = data / "legislation" / "text"
    for path in sorted(data.rglob("*.json")):
        if text in path.parents:
            continue
        for url in URL.findall(path.read_text(encoding="utf-8")):
            host = url.split("/")[2]
            by_host[host].add(url)
    return {host: sorted(urls) for host, urls in sorted(by_host.items())}


def spaced(items: list[str], count: int) -> list[str]:
    """An evenly spaced sample that always includes the first and the last item."""
    if count <= 0 or count >= len(items):
        return list(items)
    if count == 1:
        return [items[0]]
    step = (len(items) - 1) / (count - 1)
    return [items[round(i * step)] for i in range(count)]


def main() -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n")[0])
    parser.add_argument("--sample", type=int, default=40, help="addresses to request per host (0 for all)")
    parser.add_argument("--host", action="append", default=[], help="check only this host (may be repeated)")
    args = parser.parse_args()

    by_host = collect()
    fetcher = Fetcher(min_interval=1.0, timeout=60.0)
    failures = 0
    for host, urls in by_host.items():
        if args.host and host not in args.host:
            continue
        if host in NEVER_REQUESTED:
            print(f"{host}: {len(urls)} distinct addresses, not requested ({NEVER_REQUESTED[host]})")
            continue
        sample = spaced(urls, args.sample)
        bad: list[str] = []
        for url in sample:
            try:
                fetcher.head(url)
            except FetchError as exc:
                bad.append(f"{exc.status} {url}")
            except Exception as exc:  # network-level failure, including a proxy that refuses the host
                bad.append(f"no answer ({exc.__class__.__name__}) {url}")
        failures += len(bad)
        print(f"{host}: {len(urls)} distinct addresses, {len(sample)} requested, {len(sample) - len(bad)} answered 200")
        for line in bad:
            print(f"  - {line}")
    print(f"\n{'All sampled addresses answered 200.' if failures == 0 else f'{failures} sampled address(es) did not answer 200.'}")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
