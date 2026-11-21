"""The guarded start of ``python -m dhq.run``.

Under ``python -m dhq.run``, ``dhq/run.py`` hands over to :func:`main` before it imports anything else. :func:`main`
imports the pipeline and runs it, so that every way the command can stop without running its stages, including an
import that fails, exits with :data:`EXIT_UNEXPECTED` instead of Python's default exit code 1, which the scheduled
workflow reads as "a source failed and the rest was published".

This module imports nothing from the pipeline at module level, so it loads even when the pipeline cannot.
"""

from __future__ import annotations

import logging
from typing import List, Optional

#: Exit code of a run that stopped outside its stages: the arguments were not accepted, the pipeline could not be
#: loaded, or an unexpected error escaped before or between the stages. Nothing new was published.
EXIT_UNEXPECTED = 4

#: Format of the pipeline's log lines. The scheduled workflow looks for the closing line of a run that published,
#: "<time> dhq.run INFO published to ...", before it reads exit code 1 as "a source failed, the rest was published".
LOG_FORMAT = "%(asctime)s %(name)s %(levelname)s %(message)s"


def main(argv: Optional[List[str]] = None) -> int:
    try:
        from . import run
    except Exception:  # noqa: BLE001 - a missing dependency, or a module that raises while it loads
        logging.basicConfig(format=LOG_FORMAT)
        logging.getLogger("dhq.run").exception("the pipeline could not be loaded; nothing was published")
        return EXIT_UNEXPECTED
    return run.main(argv)
