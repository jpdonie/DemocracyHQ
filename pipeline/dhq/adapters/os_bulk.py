"""The election measures of the state legislatures since 2025, read from Open States' bulk data (rule ``state-select-1``).

Open States (Plural Policy) collects the measures of every state legislature from the legislatures' own sites and
offers each session as a set of CSV tables in one ZIP archive. It is a secondary source: every record is labelled as
imported from it and links to the legislature's own page for the measure, which Open States names as its source.

The sessions are listed by Open States' API (two requests, with the key): every session of a state legislature that
began or ended on or after 1 January 2025, with the address of its archive. The archives need no key. Each is read by
HTTP range requests, table by table: the measures first, and for those the rule selects their actions, sources,
sponsors, abstracts and text versions. An archive whose address is unchanged since the last run is not read again.

California is read from the Legislature's own data (``ca_leginfo``) and is left out here. Puerto Rico is left out too:
its measures are titled in Spanish, which the rule does not read, and a near-empty list would read as a fact.

The selection rule reads what the legislature says about a measure, never its text:

* ``subject``: a subject the legislature (as Open States records it) files the measure under names elections, voting,
  campaign finance, redistricting or the like (``SUBJECT_PATTERN``), and is not one of the subjects that name
  something else (``SUBJECT_EXCLUSIONS``). Where a measure is filed under more than ``MAX_SUBJECTS`` subjects, the
  election subject may be one of many, and its title must also name an election matter;
* ``named``: its title names an election matter in a phrase that says so by itself ("voter registration", "absentee
  ballots", "campaign finance", "board of elections", ...), after the phrases that name something else are taken out
  (``EXCLUSION_PATTERN``: the election of a chamber's officers, the votes of shareholders or of a board, the clause that
  puts a measure to the voters, the "voter-approval tax rate", the elections of a homeowners' association, ...);
* ``general``: its title, read the same way, holds one of the words "election(s)", "electoral", "voter(s)",
  "voting" or "ballot(s)".
"""
from __future__ import annotations

import ast
import csv
import hashlib
import io
import os
import re
from dataclasses import dataclass, field
from typing import Callable, Dict, Iterable, Iterator, List, Optional, Tuple

from .. import about, classify
from ..http import CredentialMissing, FetchError, Fetcher
from ..remotezip import RemoteZip
from ..util import STATES

SOURCE_ID = "openstates-api"
ENV = "OPENSTATES_API_KEY"
SELECTION_RULE_ID = "state-select-1"
STATUS_RULE_ID = "state-status-1"
LINK_RULE_ID = "secure-link-1"
#: Raised by hand when the reading of an archive changes in a way the rule's patterns do not show; with the patterns it
#: names the version of the rule a kept session was read with (``RULE_VERSION``).
READER_VERSION = 1
JURISDICTIONS_URL = "https://v3.openstates.org/jurisdictions"
ARCHIVE_PREFIX = "https://data.openstates.org/csv/"
OPENSTATES_PAGE = "https://openstates.org/"
#: The first day a session must reach to be read: one that began or ended on or after it.
SINCE = "2025-01-01"
#: States whose measures are read from another source, or not read (see the module's docstring).
LEFT_OUT = {"06": "California is read from the Legislature's own data", "72": "Puerto Rico titles its measures in Spanish, which the rule does not read"}

#: The tables of an archive that are read, by the end of their member's name.
TABLES = ("bills", "bill_abstracts", "bill_sources", "bill_actions", "bill_sponsorships", "bill_versions", "bill_version_links")
#: A table larger than this is refused, so that a broken archive cannot exhaust the runner.
MAX_TABLE_BYTES = 600 * 1024 * 1024

# --- the selection rule --------------------------------------------------------------------------------------

#: Subjects that name elections. A subject is the legislature's own index term, as Open States records it.
SUBJECT_PATTERN = re.compile(
    r"\b(?:elections?|electors|electoral|voting|voters?|ballots?|campaign financ\w*|campaigns?(?: and| &)? (?:campaign )?financ\w*"
    r"|redistricting|reapportionment|initiative(?: and|, | &) ?referend\w*|referend\w* (?:and|&) initiative\w*"
    r"|citizen initiatives?|ballot (?:measures?|issues?|questions?)|recall (?:elections?|of (?:public )?officials?|petitions?))\b", re.I)
#: Subjects that hold such a word and name something else: the voting of a private body, of a board or of a chamber.
SUBJECT_EXCLUSIONS = re.compile(
    r"\b(?:proxy|cumulative|shareholders?|stockholders?|condominiums?|homeowners?|cooperatives?|unit owners?|corporat\w+|members' meetings?"
    r"|without a meeting|legislative voting|roll call|voting (?:members?|rights of shares|trusts?|stock)|electors? of (?:the )?(?:board|church))\b", re.I)
#: A measure filed under more subjects than this needs an election matter in its title as well.
MAX_SUBJECTS = 3
#: Phrases of a title that name an election matter by themselves.
NAMED_PATTERN = re.compile(
    r"\bHelp America Vote Act\b|\bNational Voter Registration Act\b|\bVoting Rights Act\b|\bElectoral Count\b|\bElectoral College\b"
    r"|\belections? (?:code|laws?|administration|officials?|officers?|workers?|judges?|inspectors?|clerks?|boards?|commissions?|commissioners?"
    r"|infrastructure|security|integrity|day|results?|returns?|observers?|systems?|interference|fraud|crimes?|offenses?|records?|equipment"
    r"|technology|offices?|procedures?|dates?|audits?|contests?|recounts?|precincts?|districts?|materials?|deadlines?|calendars?|cycles?"
    r"|reform|expenses|costs|funding|notices?)\b"
    r"|\b(?:board|boards|commission|commissions|commissioner|commissioners|supervisor|supervisors|division|department|office|director"
    r"|administrator|judge|judges|inspector|inspectors) of elections?\b"
    r"|\b(?:state|county|city|town|municipal|local|school|general|primary|special|runoff|run-off|recall|judicial|presidential|congressional"
    r"|legislative|partisan|nonpartisan|non-partisan|off-year|odd-year|even-year|consolidated|statewide|regular) elections?\b"
    r"|\bvoter (?:registration|identification|ID|rolls?|lists?|intimidation|suppression|purges?|eligibility|fraud|verification|education"
    r"|outreach|turnout|data|information|files?|records?|guides?|pamphlets?|assistance|access|challenges?|qualifications?)\b"
    r"|\b(?:register(?:ing|ed)?|registration) to vote\b|\bregist(?:ered|ration of) (?:voters|electors)\b"
    r"|\b(?:right|eligible|eligibility|entitled|qualified|qualifications?) to vote\b|\bvoting rights\b"
    r"|\bvoting (?:systems?|machines?|equipment|age|by mail|centers?|locations?|places?|precincts?|districts?|procedures?|devices?"
    r"|tabulators?|technology|methods?)\b"
    r"|\bnon-?citizens? (?:from )?voting\b|\bvot(?:e|ing) (?:by|at|from) (?:mail|home)\b|\bcitizens[- ]only voting\b"
    r"|\b(?:mail-?in|absentee|provisional|mail|early|military|overseas|electronic|paper) (?:ballots?|voting|voters?)\b|\babsentee\b"
    r"|\bballot (?:boxes|box|drop boxes|drop box|measures?|access|harvesting|collection|initiatives?|integrity|tracking|processing|counting"
    r"|curing|secrecy|questions?|propositions?|language|design|order|position|draw|images?|printing|drop-?off|return|security|tabulat\w+)\b"
    r"|\bcast(?:ing)? (?:a |their |his or her )?ballots?\b|\bballots? (?:cast|received|counted)\b|\bsample ballots?\b|\bofficial ballots?\b"
    r"|\bpolling (?:places?|locations?|stations?|sites?|hours)\b|\bpoll (?:workers?|watchers?|books?|closing|hours|officials?|challengers?)\b"
    r"|\bpollbooks?\b|\bearly voting\b|\branked[- ]choice\b|\binstant[- ]runoff\b|\bsame[- ]day (?:voter )?registration\b"
    r"|\bautomatic voter registration\b|\bredistricting\b|\bgerrymander\w*|\bcontested elections?\b|\breapportionment\b"
    r"|\bpresidential electors?\b|\bpresidential primar(?:y|ies)\b"
    r"|\b(?:legislative|congressional|senatorial|representative|election) districts? (?:plan|boundar\w+|lines|map)s?\b|\bdistricting (?:plan|commission)s?\b"
    r"|\bcampaign (?:finance|financing|contributions?|expenditures?|committees?|funds?|advertis\w+|communications?|materials?|signs?|reports?"
    r"|disclosures?|treasurers?|practices)\b"
    r"|\bpolitical (?:committees?|action committees?|advertis\w+|contributions?|parties|party|campaigns?|signs?)\b|\bsuper ?PACs?\b"
    r"|\bindependent expenditures?\b|\belectioneering\b|\bcontributions? (?:and|or) expenditures\b"
    r"|\bcandidates? for (?:public|elective|state|local|county|municipal|judicial|legislative|federal|election|nomination|governor|office|the office)\b"
    r"|\b(?:candidate|candidacy) (?:filing|qualifying|qualification|nomination|petitions?|eligibility|withdrawal|statements?|names?)\b"
    r"|\bdeclarations? of candidacy\b|\bnominating petitions?\b|\b(?:initiative|referendum|recall) petitions?\b|\binitiative (?:and|or) referendum\b"
    r"|\b(?:initiated|referred) measures?\b|\bpart(?:y|isan) primar(?:y|ies)\b|\b(?:open|closed|top-two|jungle) primar(?:y|ies)\b"
    r"|\bprimar(?:y|ies) (?:elections?|ballots?|dates?|runoffs?)\b|\bwrite-?in (?:candidates?|votes?|voting)\b|\bcanvass(?:ing|ers|es)?\b"
    r"|\brecounts?\b|\bprecinct (?:boundar\w+|officials?|officers?|workers?|committee\w*)\b|\bregistrars? of voters\b|\bvoter registrars?\b",
    re.I)
#: The words of the general test.
GENERAL_PATTERN = re.compile(r"\b(?:elections?|electoral|voters?|voting|ballots?)\b", re.I)
#: Phrases taken out of a title before it is read: they hold an election word and name something else.
EXCLUSION_PATTERN = re.compile(
    r"\belection of (?:the |a )?(?:speaker|clerk|president pro tempore|president of the senate|secretary of the senate|sergeant at arms"
    r"|chief clerk|majority leader|minority leader)[^.;]*"
    r"|\bproxy voting\b|\bvoting by proxy\b|\bcumulative voting\b|\b(?:non-?voting|voting|ex[- ]officio) (?:member|members|membership|shares?|stock|trusts?|power|privileges|delegates?)\b"
    r"|\bvot(?:e|es|ing) (?:of|by) (?:the )?(?:members|shareholders?|stockholders?|board|directors|council|commission|committee|trustees|owners"
    r"|unit owners|legislature|house|senate)[^.;]*"
    r"|\b(?:shareholders?|stockholders?|members?|unit owners?|homeowners?|association|cooperative|corporate|board|directors?|trustees?"
    r"|condominium|irrigation district|drainage district|water district|union|employees?) (?:voting|elections?|ballots?)\b"
    r"|\b(?:submit\w*|submission|referr\w+|presented|proposed|put|approv\w+|ratif\w+|reject\w+)[^.;]{0,60}?\b(?:to|by|of) (?:the )?"
    r"(?:qualified |registered |legal )?(?:voters|electors|electorate|people)[^.;]{0,80}"
    r"|\b(?:vote|approval|consent|majority|ratification) of (?:the )?(?:qualified |registered |legal )?(?:voters|electors|electorate|people)\b[^.;]{0,40}"
    r"|\bat (?:the|a|an|any|each|every)(?: next| ensuing| following)?(?: regular| statewide| biennial)? (?:general|special|primary|municipal|regular) election[^.;]{0,60}"
    r"|\b(?:voter|voters'?|elector) approval\b|\bvoter[- ]approval (?:tax )?rate\b|\bvoter[- ]approved\b|\bapproved by (?:the )?voters\b"
    r"|\bballot title(?:;| and| to be)?\s*(?:directing )?(?:filing|filed)\b|\blocal option elections?\b"
    r"|\belection of (?:the )?officers of (?:the )?(?:house|senate|assembly)\b"
    r"|\belection of (?:an? )?(?:member'?s'? )?(?:certain )?(?:retirement|annuit\w+|pension|benefits?|payout|payment|options?|coverage|alternative payment|health)\b[^.;]{0,60}"
    r"|\b(?:application and |retirement |benefit |option |pension )election forms?\b|\bfil(?:e|ing) an election with\b[^.;,]{0,60}"
    r"|\bvoting on (?:legislation|bills?|measures? before)\b|\b(?:will|approval) of the (?:voters|electorate|people)\b"
    r"|\bapprov\w* (?:at|in) an? (?:special |general |local )?election\b"
    r"|\blabor (?:organizations?|unions?)[;,]? (?:elections?|voting|ballots?)\b|\bhomeowners'? associations?[;,]?(?: (?:voting|elections?|ballots?)[;,]?)+"
    r"|\b(?:irrevocable |one-time |taxpayer |employee |member |written )election (?:to|of|under|by|not to|out)\b[^.;]{0,60}"
    r"|\belect(?:ion|s|ing)? (?:to|into) (?:participate|be covered|receive|transfer|opt|coverage|pay|file|defer|treat)[^.;]{0,60}",
    re.I)
TESTS = ("subject", "named", "general")
#: The tests in words, as the data publishes them.
TEST_DESCRIPTIONS = {
    "subject": "A subject the legislature files the measure under names elections, voting, campaign finance, redistricting, "
               "ballot measures or the like (subjectPattern), and is not one of the subjects that name the voting of another "
               f"body (subjectExclusions). A measure filed under more than {MAX_SUBJECTS} subjects needs an election matter in its "
               "title as well.",
    "named": "The title names an election matter in a phrase that says so by itself (namedPattern), once the phrases that use "
             "an election word in another sense are taken out (exclusionPattern).",
    "general": "The title, read the same way, holds one of the words election(s), electoral, voter(s), voting or ballot(s) "
               "(generalPattern).",
}
#: Kinds of measure that are not legislation and are never selected: an appointment or a nomination the legislature
#: confirms, a proclamation, a commemoration.
NOT_LEGISLATION = frozenset({"appointment", "nomination", "proclamation", "commemoration"})
#: A resolution that honours or congratulates someone, mourns a death or marks a day ("Commends John Horhn on his
#: election as the mayor of Jackson", "Celebrating national voter registration day"). Its title begins with the verb
#: that says so, after the words that name the kind of measure ("A resolution", Louisiana's "COMMENDATIONS:").
_RESOLUTION_HEAD = (r"^(?:(?:a|an|house|senate|assembly|joint|concurrent|legislative)\s+)*(?:resolution\s+)?(?:(?:to|that)\s+)?"
                    r"(?:[a-z/ ]{3,30}:\s*)?(?:(?:the\s+)?(?:house|senate|legislature)\s+)?")
#: Verbs that make a measure ceremonial whatever Open States classifies it as: some legislatures' resolutions are
#: recorded as bills ("Commending the Virginia Electoral Board Association", classified "bill").
CEREMONIAL_PATTERN = re.compile(
    _RESOLUTION_HEAD + r"(?:commend(?!ation)|congratulat|honou?r(?:s|ing|ed)?\b|celebrat|mourn|memorializ\w* the (?:life|death|service)"
    r"|express\w* (?:the )?(?:condolences|sympathy|gratitude|appreciation))", re.I)
#: Words that make a resolution ceremonial, and only a resolution: a bill may begin "Recognizing a medical bill as proof
#: of residence". Georgia and Mississippi put the verb after the name ("League of Women Voters of Georgia; recognize").
RESOLUTION_CEREMONIAL_PATTERN = re.compile(
    _RESOLUTION_HEAD + r"(?:recogniz|welcom|thank|declar\w* .{0,60}\b(?:day|week|month)\b|designat\w* .{0,60}\b(?:day|week|month)\b)"
    r"|;\s*(?:commend|recognize|congratulate|honou?r|celebrate|condolences)\b", re.I)
_RESOLUTION_TITLE = re.compile(r"^(?:(?:a|an|house|senate|assembly|joint|concurrent|legislative)\s+)*resolution\b", re.I)


#: What a session read under another version of the rule or the reader is read again for: the patterns and the reader.
RULE_VERSION = hashlib.sha256("\n".join([
    str(READER_VERSION), SUBJECT_PATTERN.pattern, SUBJECT_EXCLUSIONS.pattern, str(MAX_SUBJECTS), NAMED_PATTERN.pattern,
    GENERAL_PATTERN.pattern, EXCLUSION_PATTERN.pattern, CEREMONIAL_PATTERN.pattern, RESOLUTION_CEREMONIAL_PATTERN.pattern,
    ",".join(sorted(NOT_LEGISLATION)),
]).encode("utf-8")).hexdigest()[:16]


def ceremonial(title: str, classification: List[str]) -> bool:
    """Whether a measure honours, congratulates, mourns or marks a day (``CEREMONIAL_PATTERN``), or is a resolution
    that recognizes or welcomes (``RESOLUTION_CEREMONIAL_PATTERN``). A proposed constitutional amendment never is."""
    if "constitutional amendment" in classification:
        return False
    if CEREMONIAL_PATTERN.search(title):
        return True
    resolution = any("resolution" in kind or "memorial" in kind for kind in classification) or bool(_RESOLUTION_TITLE.search(title))
    return resolution and bool(RESOLUTION_CEREMONIAL_PATTERN.search(title))


def api_key() -> str:
    value = os.environ.get(ENV, "").strip()
    if not value:
        raise CredentialMissing(f"{ENV} is not set")
    return value


def subjects_of(value: str) -> List[str]:
    """The subjects of a measure, from the table's column: a list written as Python writes one, whose items a few
    legislatures join with semicolons ("Elections; Voting")."""
    try:
        parsed = ast.literal_eval(value) if value else []
    except (ValueError, SyntaxError):
        parsed = [value]
    items = [str(item) for item in parsed] if isinstance(parsed, (list, tuple)) else [str(parsed)]
    out: List[str] = []
    for item in items:
        out += [part.strip() for part in item.split(";") if part.strip()]
    return out


def selection_match(title: str, subjects: List[str]) -> Optional[dict]:
    """Why a measure is selected: ``{"test", "matchedText", "matchedField"}``, or ``None``."""
    read = EXCLUSION_PATTERN.sub(" ", title or "")
    by_title = None
    for test, pattern in (("named", NAMED_PATTERN), ("general", GENERAL_PATTERN)):
        match = pattern.search(read)
        if match:
            by_title = {"test": test, "matchedText": match.group(0), "matchedField": "Title"}
            break
    election_subjects = [s for s in subjects if SUBJECT_PATTERN.search(s) and not SUBJECT_EXCLUSIONS.search(s)]
    if election_subjects and (len(subjects) <= MAX_SUBJECTS or by_title):
        return {"test": "subject", "matchedText": election_subjects[0], "matchedField": "Subject"}
    return by_title


# --- the status of a measure ---------------------------------------------------------------------------------

#: The stages of a measure, furthest last, by the classifications Open States gives its actions (rule ``state-status-1``).
STAGES = ("Introduced", "Passed one chamber", "Passed the legislature", "Sent to the governor", "Vetoed", "Signed by the governor", "Became law")
UNICAMERAL = {"31", "11"}  # Nebraska; the Council of the District of Columbia


def stage_of(actions: List[dict], state: str) -> str:
    """The furthest stage the actions of a measure record.

    Open States classifies each action: "passage" by a chamber, "executive-receipt", "executive-veto",
    "executive-signature", "became-law". A measure passed by two chambers (two different bodies record its passage) has
    passed the legislature; in a legislature of one chamber one passage suffices. A veto that a later passage
    overrides, or a signature after it, counts as the later stage. Which bodies are chambers is not checked: a body
    that records a passage is taken as one.
    """
    reached = 0
    passed_by = set()
    for action in sorted(actions, key=lambda a: (a["date"], a["order"])):
        kinds = set(action["classification"])
        if "passage" in kinds or "veto-override-passage" in kinds:
            passed_by.add(action["organization"])
            reached = max(reached, 2 if (len(passed_by) >= 2 or state in UNICAMERAL) else 1)
        if "executive-receipt" in kinds:
            reached = max(reached, 3)
        if "executive-veto" in kinds:
            reached = max(reached, 4)
        if "executive-signature" in kinds:
            reached = max(reached, 5)
        if "became-law" in kinds:
            reached = 6
    return STAGES[reached]


# --- reading an archive --------------------------------------------------------------------------------------

@dataclass
class Session:
    state: str  # FIPS code
    abbr: str
    identifier: str
    name: str
    classification: str
    start: Optional[str]
    end: Optional[str]
    url: str


def sessions_of(jurisdictions: Iterable[dict]) -> Tuple[List[Session], Dict[str, int]]:
    """The sessions to read from Open States' list of jurisdictions, and how many were passed over by reason."""
    by_abbr = {abbr.lower(): fips for fips, (abbr, _name) in STATES.items()}
    sessions: List[Session] = []
    skipped: Dict[str, int] = {}

    def skip(reason: str) -> None:
        skipped[reason] = skipped.get(reason, 0) + 1

    for jurisdiction in jurisdictions:
        match = re.search(r"/(?:state|district|territory):([a-z]{2})/", str(jurisdiction.get("id") or ""))
        fips = by_abbr.get(match.group(1)) if match else None
        if not fips:
            skip("unknownJurisdiction")
            continue
        if fips in LEFT_OUT:
            skip(f"leftOut:{STATES[fips][0]}")
            continue
        for session in jurisdiction.get("legislative_sessions") or []:
            start, end = str(session.get("start_date") or "")[:10], str(session.get("end_date") or "")[:10]
            if not (start >= SINCE or end >= SINCE):
                continue
            archives = [d for d in session.get("downloads") or [] if d.get("data_type") == "csv" and str(d.get("url") or "").startswith(ARCHIVE_PREFIX)]
            if not archives:
                skip("noArchive")
                continue
            sessions.append(Session(state=fips, abbr=STATES[fips][0], identifier=str(session.get("identifier") or ""),
                                    name=str(session.get("name") or session.get("identifier") or ""),
                                    classification=str(session.get("classification") or ""), start=start or None, end=end or None,
                                    url=str(archives[-1]["url"])))
    return sessions, skipped


def table_rows(data: bytes) -> Iterator[dict]:
    """The rows of a CSV table of an archive."""
    csv.field_size_limit(MAX_TABLE_BYTES)
    yield from csv.DictReader(io.StringIO(data.decode("utf-8", errors="replace"), newline=""))


def _list(value: str) -> List[str]:
    try:
        parsed = ast.literal_eval(value) if value else []
    except (ValueError, SyntaxError):
        return []
    return [str(item) for item in parsed] if isinstance(parsed, (list, tuple)) else []


_DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}")


def _day(value: str) -> Optional[str]:
    return value[:10] if _DAY_RE.match(value or "") else None


_SAFE_URL_RE = re.compile(r"https://[A-Za-z0-9.-]+(?::\d+)?(?:/[^\s<>\"'`]*)?")


def host_of(url: str) -> str:
    match = re.match(r"https?://([^/:?#]+)", (url or "").strip(), re.I)
    return match.group(1).lower() if match else ""


def https_hosts(urls: Iterable[str]) -> set:
    """The hosts that ``urls`` give over https."""
    return {host_of(url) for url in urls if (url or "").strip().lower().startswith("https://")} - {""}


def secure_url(url: str, secure_hosts: Iterable[str] = ()) -> Optional[str]:
    """An address a reader may be sent to (rule ``secure-link-1``), or ``None``.

    Spaces and quotation marks inside an address (Iowa's "billName=HF 91", Utah's file names) are written as "%20",
    "%22" and "%27"; nothing else is changed. An http address is given over https only when its host is one of
    ``secure_hosts``: a host Open States itself records with https addresses for the same state, or one whose https
    form of an address answered the pipeline (``confirm_https``). Any other http address is not shown, because the
    site sends readers to secure pages only."""
    url = (url or "").strip().replace(" ", "%20").replace('"', "%22").replace("'", "%27")
    if url.lower().startswith("http://"):
        if host_of(url) not in set(secure_hosts):
            return None
        url = "https://" + url[len("http://"):]
    return url if _SAFE_URL_RE.fullmatch(url) else None


#: How long a host's answer over https counts before it is asked again.
CONFIRM_DAYS = 7


def http_only_hosts(docs: Iterable[dict], secure: Dict[str, set]) -> Dict[str, str]:
    """The hosts of the legislatures' pages that the selected measures are given at over http only, each with one
    such address to ask: hosts no record of Open States for that state gives over https."""
    found: Dict[str, str] = {}
    for doc in docs:
        for raw in doc["selected"]:
            for url in raw["sources"]:
                host = host_of(url)
                if url.lower().startswith("http://") and host and host not in secure.get(doc["state"], set()):
                    found.setdefault(host, url)
    return found


def confirm_https(fetcher: Fetcher, url: str) -> bool:
    """Whether the https form of an http address answers with the page (status 200, no redirect back to http)."""
    try:
        fetcher.get("https://" + url.strip()[len("http://"):], max_bytes=4 * 1024 * 1024, attempts=1)
    except FetchError:
        return False
    return True


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", text.lower())


def measure_id(session: Session, identifier: str) -> str:
    """The id of a measure: ``os-<state>-<session>-<identifier>``, all in lower-case letters and digits."""
    return f"os-{session.abbr.lower()}-{slug(session.identifier) or 'session'}-{slug(identifier)}"


@dataclass
class SessionRead:
    session: Session
    measures: int = 0
    #: The selected measures, by Open States' id: the row of the measure and what the rule found.
    selected: Dict[str, dict] = field(default_factory=dict)
    skipped: Dict[str, int] = field(default_factory=dict)


def select(session: Session, rows: Iterable[dict]) -> SessionRead:
    """Apply the selection rule to the measures of one session."""
    read = SessionRead(session=session)
    seen_ids: Dict[str, str] = {}
    for row in rows:
        read.measures += 1
        identifier = (row.get("identifier") or "").strip()
        title = re.sub(r"\s+", " ", row.get("title") or "").strip()
        if not identifier or not title:
            read.skipped["noIdentifierOrTitle"] = read.skipped.get("noIdentifierOrTitle", 0) + 1
            continue
        subjects = subjects_of(row.get("subject") or "")
        classification = _list(row.get("classification") or "")
        match = selection_match(title, subjects)
        if not match:
            continue
        if NOT_LEGISLATION.intersection(classification) or ceremonial(title, classification):
            read.skipped["notLegislation"] = read.skipped.get("notLegislation", 0) + 1
            continue
        mid = measure_id(session, identifier)
        if mid in seen_ids:
            read.skipped["sameIdentifier"] = read.skipped.get("sameIdentifier", 0) + 1
            continue
        seen_ids[mid] = row["id"]
        read.selected[row["id"]] = {"id": mid, "identifier": identifier, "title": title, "subjects": subjects,
                                    "classification": classification, "match": match,
                                    "chamber": row.get("organization_classification") or ""}
    return read


def details(selected: Dict[str, dict], tables: Callable[[str], Optional[bytes]]) -> set:
    """Add to each selected measure its abstracts, sources, actions, sponsors and versions, from the archive's tables.
    ``tables(name)`` gives the bytes of a table, or ``None`` where the archive has none of that name. Returns the hosts
    that the archive gives over https, for any measure (see ``secure_url``)."""
    hosts: set = set()
    for record in selected.values():
        record.update(abstracts=[], sources=[], actions=[], sponsors=[], versions=[])

    def rows(name: str) -> Iterator[dict]:
        data = tables(name)
        return table_rows(data) if data else iter(())

    for row in rows("bill_abstracts"):
        record = selected.get(row.get("bill_id") or "")
        text = re.sub(r"\s+", " ", row.get("abstract") or "").strip()
        if record is not None and text:
            record["abstracts"].append({"text": text, "note": (row.get("note") or "").strip()})
    for row in rows("bill_sources"):
        record = selected.get(row.get("bill_id") or "")
        url = (row.get("url") or "").strip()
        hosts |= https_hosts([url])
        if record is not None and url and url not in record["sources"]:
            record["sources"].append(url)
    for row in rows("bill_actions"):
        record = selected.get(row.get("bill_id") or "")
        day = _day(row.get("date") or "")
        text = re.sub(r"\s+", " ", row.get("description") or "").strip()
        if record is not None and day and text:
            try:
                order = int(row.get("order") or 0)
            except ValueError:
                order = 0
            record["actions"].append({"date": day, "text": text, "classification": _list(row.get("classification") or ""),
                                      "organization": row.get("organization_id") or "", "order": order})
    for row in rows("bill_sponsorships"):
        record = selected.get(row.get("bill_id") or "")
        name = re.sub(r"\s+", " ", row.get("name") or "").strip()
        if record is not None and name:
            record["sponsors"].append({"name": name, "primary": (row.get("primary") or "").lower() == "true",
                                       "classification": (row.get("classification") or "").strip()})
    versions: Dict[str, dict] = {}
    for row in rows("bill_versions"):
        record = selected.get(row.get("bill_id") or "")
        if record is not None:
            version = {"note": re.sub(r"\s+", " ", row.get("note") or "").strip(), "date": _day(row.get("date") or ""), "links": []}
            record["versions"].append(version)
            versions[row.get("id") or ""] = version
    for row in rows("bill_version_links"):
        version = versions.get(row.get("version_id") or "")
        url = (row.get("url") or "").strip()
        hosts |= https_hosts([url])
        if version is not None and url:
            version["links"].append({"url": url, "mediaType": (row.get("media_type") or "").strip()})
    for record in selected.values():
        record["actions"].sort(key=lambda a: (a["date"], a["order"]))
        record["versions"] = [v for v in record["versions"] if v["links"]]
    return hosts


def drop_ceremonial_abstracts(read: SessionRead) -> None:
    """Leave out a selected measure whose abstract shows it to be ceremonial (Georgia's "A RESOLUTION recognizing and
    commending ..."), as ``ceremonial`` does for a title."""
    for key, record in list(read.selected.items()):
        if any(ceremonial(entry["text"], record["classification"]) for entry in record.get("abstracts") or []):
            del read.selected[key]
            read.skipped["notLegislation"] = read.skipped.get("notLegislation", 0) + 1


def table_members(names: Iterable[str]) -> Dict[str, str]:
    """The members of an archive that hold the tables read, by table: "AL/2025rs/AL_2025rs_bill_actions.csv" holds
    "bill_actions". A member whose name is not of that form is not read."""
    members: Dict[str, str] = {}
    for name in names:
        base = name.rsplit("/", 1)[-1]
        for table in TABLES:
            if base.endswith(f"_{table}.csv") and table not in members:
                members[table] = name
    return members


def read_session(session: Session, tables: Callable[[str], Optional[bytes]]) -> dict:
    """What the rule selects from one session, with the details of each selected measure, as a document the stage
    keeps until the session's archive changes. ``tables(name)`` gives a table's bytes (``None`` if there is none)."""
    data = tables("bills")
    if not data:
        raise ValueError(f"the archive of {session.abbr} {session.identifier} has no bills table")
    read = select(session, table_rows(data))
    hosts = details(read.selected, tables)
    drop_ceremonial_abstracts(read)
    return {"url": session.url, "state": session.state, "abbr": session.abbr, "identifier": session.identifier,
            "name": session.name, "classification": session.classification, "start": session.start, "end": session.end,
            "measuresRead": read.measures, "skipped": read.skipped, "httpsHosts": sorted(hosts),
            "selected": [{"openStatesId": key, **record} for key, record in read.selected.items()]}


def read_archive(session: Session, fetcher: Fetcher) -> dict:
    """``read_session`` over the session's archive, read by HTTP range requests."""
    archive = RemoteZip(session.url, fetcher)
    members = table_members(archive.names())
    if "bills" not in members:
        raise FetchError(session.url, None, "the archive holds no bills table")
    return read_session(session, lambda table: archive.read(members[table], max_bytes=MAX_TABLE_BYTES) if table in members else None)


def jurisdictions(fetcher: Fetcher, key: str) -> List[dict]:
    """The state jurisdictions with their sessions and archives: two requests to Open States' API."""
    found: List[dict] = []
    for page in (1, 2):
        payload = fetcher.get(JURISDICTIONS_URL, headers={"X-API-KEY": key},
                              params={"classification": "state", "per_page": 52, "page": page, "include": "legislative_sessions"}).json()
        found += payload.get("results") or []
        if page >= int((payload.get("pagination") or {}).get("max_page") or 1):
            break
    return found


# --- the published record ------------------------------------------------------------------------------------

#: How the kinds of measure Open States records are named.
KIND_LABELS = {"bill": "Bill", "resolution": "Resolution", "joint resolution": "Joint resolution",
               "concurrent resolution": "Concurrent resolution", "constitutional amendment": "Constitutional amendment",
               "memorial": "Memorial", "joint memorial": "Joint memorial", "concurrent memorial": "Concurrent memorial",
               "proposed bill": "Proposed bill", "study request": "Study request", "concurrent study request": "Concurrent study request"}
#: The pattern of a measure's id; it names nothing on disk, but the site matches it.
MEASURE_ID_PATTERN = r"os-[a-z]{2}-[a-z0-9]{1,40}-[a-z0-9]{1,40}"
VERIFICATION_NOTE = ("Imported from Open States, which collects it from the legislature's site; compare it with the "
                     "legislature's own page for the measure.")


def measure_type(classification: List[str]) -> str:
    """"Bill", "Joint resolution", "Bill (appropriation)": the first kind Open States records, then any others."""
    kinds = [kind for kind in classification if kind] or ["bill"]
    head = KIND_LABELS.get(kinds[0], kinds[0][:1].upper() + kinds[0][1:])
    return head + (f" ({', '.join(kinds[1:])})" if kinds[1:] else "")


def lead_authors(sponsors: List[dict]) -> Optional[str]:
    """The primary sponsors as the record names them, at most three, and how many more there are."""
    names = [sponsor["name"] for sponsor in sponsors if sponsor["primary"]]
    if not names:
        return None
    shown = ", ".join(names[:3])
    return shown if len(names) <= 3 else f"{shown} and {len(names) - 3} more"


def build(raw: dict, session: dict, secure_hosts: Iterable[str], *, checked_at: str, first_observed: Optional[str]) -> Optional[dict]:
    """The published record of a selected measure, or ``None`` when Open States names no page of the legislature for
    it that can be shown (rule ``secure-link-1``)."""
    hosts = set(secure_hosts)
    sources = list(dict.fromkeys(url for url in (secure_url(source, hosts) for source in raw["sources"]) if url))
    if not sources:
        return None
    versions = []
    for version in raw["versions"]:
        links = [{"url": url, "mediaType": link["mediaType"] or None} for link in version["links"]
                 for url in [secure_url(link["url"], hosts)] if url]
        if links:
            versions.append({"note": version["note"] or "Text", "date": version["date"], "links": links})
    actions = [{"date": a["date"], "text": a["text"], "classification": a["classification"]} for a in raw["actions"]]
    abstract = about.state_abstract(raw.get("abstracts") or [])
    subjects = raw["subjects"]
    tags = classify.classify([("Title", raw["title"]), ("Subject", "; ".join(subjects)),
                              ("Summary recorded by Open States", abstract["text"] if abstract else "")])
    last = raw["actions"][-1] if raw["actions"] else None
    record = {
        "id": raw["id"], "state": session["state"], "stateAbbr": session["abbr"], "session": session["name"],
        "identifier": raw["identifier"], "measureType": measure_type(raw["classification"]), "title": raw["title"],
        "subject": None, "leadAuthors": lead_authors(raw["sponsors"]),
        "legislativeStatus": {"currentStatus": stage_of(raw["actions"], session["state"])}, "chapter": None,
        "introducedDate": raw["actions"][0]["date"] if raw["actions"] else None,
        "lastActionDate": last["date"] if last else None, "lastActionText": last["text"] if last else None,
        "versionCount": len(versions), "issueTags": [tag.model_dump(mode="json") for tag in tags], "about": abstract,
        "selection": {"ruleId": SELECTION_RULE_ID, "test": raw["match"]["test"], "matchedText": raw["match"]["matchedText"],
                      "matchedField": raw["match"]["matchedField"]},
        "officialUrl": sources[0], "sourceId": SOURCE_ID, "firstObservedAt": first_observed or checked_at, "lastCheckedAt": checked_at,
        "verification": {"status": "imported_secondary", "method": "automated_secondary_import", "checkedAt": checked_at,
                         "note": VERIFICATION_NOTE},
        "subjects": subjects, "actions": actions, "versions": versions,
        "sponsors": [{"name": s["name"], "primary": s["primary"], "classification": s["classification"] or None} for s in raw["sponsors"]],
        "sources": sources, "openStatesId": raw["openStatesId"],
    }
    return record


def fingerprint(record: dict) -> str:
    """What changes when the measure's record changes."""
    basis = repr((record["title"], record["subjects"], record["actions"], record["sources"], record["versions"], record["sponsors"], record["abstracts"]))
    return hashlib.sha256(basis.encode("utf-8")).hexdigest()[:16]
