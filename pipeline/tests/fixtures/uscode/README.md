# Two sections of the United States Code

These two files are **not synthetic**. They are the pages GovInfo serves for

- 28 U.S.C. § 41 (number and composition of circuits) and
- 48 U.S.C. § 1821 (District Court for the Northern Mariana Islands),

in the 2024 edition of the United States Code, copied unchanged on 2026-11-21 from

- https://www.govinfo.gov/content/pkg/USCODE-2024-title28/html/USCODE-2024-title28-partI-chap3-sec41.htm
- https://www.govinfo.gov/content/pkg/USCODE-2024-title48/html/USCODE-2024-title48-chap17-subchapII-sec1821.htm

The United States Code is a work of the U.S. Government and is not subject to copyright in the United States
(17 U.S.C. § 105).

`tests/test_circuits.py` uses them to check that the table of states for each circuit in `dhq/circuits.py`
says what the statute says. The pipeline itself never reads these copies: on every run of the boundary stage
it fetches both sections from GovInfo and compares them with the table again.
