"""DemocracyHQ data pipeline.

Static-first ingestion: every stage is deterministic and re-runnable, every
published record carries a SourceRecord, and a failed upstream never overwrites
previously verified data (see ``dhq.publish``).
"""

__version__ = "0.1.0"
