"""Deterministic helpers: stable JSON, hashing, clocks, state lookups."""

from __future__ import annotations

import hashlib
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

REPO_ROOT = Path(__file__).resolve().parents[2]
PIPELINE_DIR = REPO_ROOT / "pipeline"
CACHE_DIR = PIPELINE_DIR / ".cache"
STAGING_DIR = PIPELINE_DIR / "staging"
PUBLIC_DATA = REPO_ROOT / "public" / "data"
SEEDS_DIR = PIPELINE_DIR / "seeds"


def now_iso() -> str:
    """UTC timestamp, ``YYYY-MM-DDTHH:MM:SSZ``.

    ``DHQ_NOW`` pins the clock so that test runs are reproducible. It is honoured only under
    pytest or when ``DHQ_ALLOW_NOW=1`` is also set, so that a value left in a ``.env`` file
    cannot back-date a real run; a pinned value that is not a full UTC timestamp is refused.
    """
    pinned = os.environ.get("DHQ_NOW", "").strip()
    if pinned and (os.environ.get("DHQ_ALLOW_NOW") == "1" or "PYTEST_CURRENT_TEST" in os.environ):
        try:
            datetime.strptime(pinned, "%Y-%m-%dT%H:%M:%SZ")
        except ValueError:
            raise ValueError(f"DHQ_NOW must be a UTC timestamp such as 2026-01-01T00:00:00Z, not {pinned!r}") from None
        return pinned
    if pinned:
        logging.getLogger("dhq.util").warning("DHQ_NOW is set but ignored; set DHQ_ALLOW_NOW=1 to pin the clock")
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_text(text: str) -> str:
    return sha256_bytes(text.encode("utf-8"))


def stable_json(obj: Any, *, indent: Optional[int] = None) -> str:
    """Serialise with sorted keys so identical data yields identical bytes."""
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, indent=indent, separators=None if indent else (",", ":"))


def content_hash(obj: Any) -> str:
    return sha256_text(stable_json(obj))


class UnsafePathError(ValueError):
    """Raised instead of writing a file whose path leaves the folder it was meant for."""


def safe_path(path: Path, root: Optional[Path] = None) -> Path:
    """``path``, once it is known to stay where it was meant to go.

    File names are often built from what a source sent (a bill id, a version id), so a
    path that names a parent folder (``..``) is refused whatever the root. With ``root``,
    the path must also resolve, symbolic links followed, to ``root`` or a place inside it;
    folders that do not exist yet are taken as written. Nothing is created or written here.

    Without ``root`` only ``..`` is caught. A name that is itself an absolute path replaces
    everything before it when it is joined (``Path("out") / "/tmp/x.json"`` is
    ``/tmp/x.json``), and only ``root`` refuses that, so every write whose file name comes
    even in part from a source must pass ``root``.
    """
    path = Path(path)
    if ".." in path.parts:
        raise UnsafePathError(f"refusing to write {path}: the path names a parent folder ('..')")
    if root is not None:
        base = Path(root).resolve()
        resolved = path.resolve()
        if resolved != base and base not in resolved.parents:
            raise UnsafePathError(f"refusing to write {path}: it resolves to {resolved}, outside {base}")
    return path


def write_json(path: Path, obj: Any, *, indent: Optional[int] = None, root: Optional[Path] = None) -> bool:
    """Atomically write JSON; return ``True`` when bytes on disk changed.

    ``root`` is the folder the file must stay in (see :func:`safe_path`); a path that
    leaves it, or that names a parent folder, raises :class:`UnsafePathError` before any
    folder is created.
    """
    path = safe_path(path, root)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = stable_json(obj, indent=indent) + "\n"
    if path.exists() and path.read_text(encoding="utf-8") == data:
        return False
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(data, encoding="utf-8")
    tmp.replace(path)
    return True


def write_bytes_atomic(path: Path, data: bytes, *, root: Optional[Path] = None) -> None:
    """Write ``data`` so that ``path`` holds either its old content or all of the new, never a part.

    ``root`` works as in :func:`write_json`.
    """
    path = safe_path(path, root)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(path)


def read_json(path: Path, default: Any = None) -> Any:
    path = Path(path)
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def iso_to_http_date(value: Optional[str]) -> Optional[str]:
    """``2026-07-10T15:07:38Z`` as an HTTP date (``Fri, 10 Jul 2026 15:07:38 GMT``), for a conditional request."""
    if not value:
        return None
    from email.utils import format_datetime

    try:
        return format_datetime(datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc), usegmt=True)
    except (TypeError, ValueError):
        return None


def http_date_to_iso(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    from email.utils import parsedate_to_datetime

    try:
        return parsedate_to_datetime(value).astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    except (TypeError, ValueError):
        return None


# FIPS state code -> (USPS abbreviation, name, directory name used by census.gov)
STATES: dict[str, tuple[str, str]] = {
    "01": ("AL", "Alabama"), "02": ("AK", "Alaska"), "04": ("AZ", "Arizona"), "05": ("AR", "Arkansas"),
    "06": ("CA", "California"), "08": ("CO", "Colorado"), "09": ("CT", "Connecticut"), "10": ("DE", "Delaware"),
    "11": ("DC", "District of Columbia"), "12": ("FL", "Florida"), "13": ("GA", "Georgia"), "15": ("HI", "Hawaii"),
    "16": ("ID", "Idaho"), "17": ("IL", "Illinois"), "18": ("IN", "Indiana"), "19": ("IA", "Iowa"),
    "20": ("KS", "Kansas"), "21": ("KY", "Kentucky"), "22": ("LA", "Louisiana"), "23": ("ME", "Maine"),
    "24": ("MD", "Maryland"), "25": ("MA", "Massachusetts"), "26": ("MI", "Michigan"), "27": ("MN", "Minnesota"),
    "28": ("MS", "Mississippi"), "29": ("MO", "Missouri"), "30": ("MT", "Montana"), "31": ("NE", "Nebraska"),
    "32": ("NV", "Nevada"), "33": ("NH", "New Hampshire"), "34": ("NJ", "New Jersey"), "35": ("NM", "New Mexico"),
    "36": ("NY", "New York"), "37": ("NC", "North Carolina"), "38": ("ND", "North Dakota"), "39": ("OH", "Ohio"),
    "40": ("OK", "Oklahoma"), "41": ("OR", "Oregon"), "42": ("PA", "Pennsylvania"), "44": ("RI", "Rhode Island"),
    "45": ("SC", "South Carolina"), "46": ("SD", "South Dakota"), "47": ("TN", "Tennessee"), "48": ("TX", "Texas"),
    "49": ("UT", "Utah"), "50": ("VT", "Vermont"), "51": ("VA", "Virginia"), "53": ("WA", "Washington"),
    "54": ("WV", "West Virginia"), "55": ("WI", "Wisconsin"), "56": ("WY", "Wyoming"),
    "60": ("AS", "American Samoa"), "66": ("GU", "Guam"), "69": ("MP", "Commonwealth of the Northern Mariana Islands"),
    "72": ("PR", "Puerto Rico"), "78": ("VI", "United States Virgin Islands"),
}

STATE_BY_NAME = {name.lower(): fips for fips, (_, name) in STATES.items()}
STATE_BY_ABBR = {abbr: fips for fips, (abbr, _) in STATES.items()}

# The 50 states, DC and Puerto Rico have decennial P.L. 94-171 files.
PL_STATES = [f for f in STATES if f not in {"60", "66", "69", "78"}]


def census_dir_name(fips: str) -> str:
    return STATES[fips][1].replace(" ", "_")


def load_dotenv(path: Path) -> list[str]:
    """Read ``KEY=value`` lines from a local ``.env`` file into the environment.

    Values already present in the environment win, so CI secrets are never overridden.
    Returns the names that were set (never the values, so nothing secret is logged).
    """
    if not path.is_file():
        return []
    loaded: list[str] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if not key.isidentifier() or not value or key in os.environ:
            continue
        os.environ[key] = value
        loaded.append(key)
    return loaded
