import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type {
  BillIndex, CaseLink, CircuitIndex, DecisionIndex, EntityRelationship, FederalBillIndex, LegalCaseSummary, LegislativeInstrumentSummary, Manifest, RedistrictingFile,
  SourceRecord, StateLegislationIndex, TimelineEvent,
} from '../types/schemas';
import {
  loadBillIndex, loadCaseIndex, loadCircuitIndex, loadCircuits, loadCourts, loadDecisionIndex, loadEvents, loadFederalBillIndex, loadGeoIndex, loadGovernment, loadManifest,
  loadRedistricting, loadRelationships, loadSources, loadStateLegislationIndex,
} from './data';
import { CourtDirectory } from './courts';
import { GeoIndex } from './geo';
import { GovernmentIndex } from './government';
import { useLoad, type Loadable } from './useLoad';

/**
 * Every measure published in full, with the rule each legislature's measures were selected by. The two indexes are
 * loaded together: a list of "all measures" with one legislature silently missing would read as a finding.
 */
export interface BillCatalog {
  /** The measures of Congress, then California's bills, each in the order of its index. */
  bills: LegislativeInstrumentSummary[];
  /** How California's measures were selected, and how many bills the session holds. */
  california: BillIndex['selection'];
  /** How the measures of Congress were selected, and how many were read. */
  federal: FederalBillIndex['selection'];
}

/** What was read for the courts of appeals and why each case is in or out: everything in circuits/index.json but the cases. */
export type AppealsCoverage = Pick<CircuitIndex, 'coverage' | 'exclusions' | 'scannedAt' | 'selection'>;

/** What was read for the federal district courts and the state courts: everything in decisions/index.json but the cases. */
export type DecisionsCoverage = Pick<DecisionIndex, 'coverage' | 'scannedAt' | 'selection'>;

export interface Core {
  /** Time the page was opened, used for freshness. */
  now: string;
  manifest: Loadable<Manifest>;
  sources: Loadable<SourceRecord[]>;
  geo: Loadable<GeoIndex>;
  /** Every published case: the Supreme Court dockets, the court of appeals cases, then the cases of district and state courts. */
  cases: Loadable<LegalCaseSummary[]>;
  appeals: Loadable<AppealsCoverage>;
  decisions: Loadable<DecisionsCoverage>;
  courts: Loadable<CourtDirectory>;
  bills: Loadable<BillCatalog>;
  relationships: Loadable<EntityRelationship[]>;
  /** Supreme Court dockets paired with the court of appeals case they come from (rule case-below-1). Same file as the relationships. */
  caseLinks: Loadable<CaseLink[]>;
  redistricting: Loadable<RedistrictingFile>;
}

const CoreContext = createContext<Core | null>(null);

const startedAt = new Date().toISOString();

/** The three indexes are loaded together: a list of "all cases" with one set of courts silently missing would read as a finding. */
async function loadAllCases(): Promise<LegalCaseSummary[]> {
  const [supreme, appeals, decisions] = await Promise.all([loadCaseIndex(), loadCircuitIndex(), loadDecisionIndex()]);
  return [...supreme.cases, ...appeals.cases, ...decisions.cases];
}

async function loadDecisionsCoverage(): Promise<DecisionsCoverage> {
  const { coverage, scannedAt, selection } = await loadDecisionIndex();
  return { coverage, scannedAt, selection };
}

async function loadAppealsCoverage(): Promise<AppealsCoverage> {
  const { coverage, exclusions, scannedAt, selection } = await loadCircuitIndex();
  return { coverage, exclusions, scannedAt, selection };
}

async function loadBillCatalog(): Promise<BillCatalog> {
  const [state, federal] = await Promise.all([loadBillIndex(), loadFederalBillIndex()]);
  return { bills: [...federal.bills, ...state.bills], california: state.selection, federal: federal.selection };
}

async function loadCourtDirectory(): Promise<CourtDirectory> {
  const [courts, circuits] = await Promise.all([loadCourts(), loadCircuits()]);
  return new CourtDirectory(courts.courts, circuits);
}

export function CoreProvider({ children }: { children: ReactNode }) {
  const manifest = useLoad('manifest', loadManifest);
  const sources = useLoad('sources', async () => (await loadSources()).sources);
  const geo = useLoad('geo', async () => new GeoIndex(await loadGeoIndex()));
  const cases = useLoad('cases', loadAllCases);
  const appeals = useLoad('appeals', loadAppealsCoverage);
  const decisions = useLoad('decisions', loadDecisionsCoverage);
  const courts = useLoad('courts', loadCourtDirectory);
  const bills = useLoad('bills', loadBillCatalog);
  const relationships = useLoad('relationships', async () => (await loadRelationships()).relationships);
  const caseLinks = useLoad('case-links', async () => (await loadRelationships()).caseLinks);
  const redistricting = useLoad('redistricting', loadRedistricting);
  const value = useMemo<Core>(
    () => ({ now: startedAt, manifest, sources, geo, cases, appeals, decisions, courts, bills, relationships, caseLinks, redistricting }),
    [manifest, sources, geo, cases, appeals, decisions, courts, bills, relationships, caseLinks, redistricting],
  );
  return <CoreContext.Provider value={value}>{children}</CoreContext.Provider>;
}

export function useCore(): Core {
  const core = useContext(CoreContext);
  if (!core) throw new Error('useCore must be used inside CoreProvider');
  return core;
}

const loadEventList = async () => (await loadEvents()).events;

/**
 * The dated events (events.json, most of a megabyte) are requested only by the views that show them, the home
 * page, a place and a court, not on every first paint.
 */
export function useEvents(): Loadable<TimelineEvent[]> {
  return useLoad('events', loadEventList);
}

const loadGovernmentIndex = async () => new GovernmentIndex(await loadGovernment());

/**
 * Who holds office (government.json). Requested by the views that show it: the overview, the page of a state or of
 * the country, and the map while it is shaded by party. `wanted` false leaves the file alone.
 */
export function useGovernment(wanted = true): Loadable<GovernmentIndex> {
  return useLoad(wanted ? 'government' : null, loadGovernmentIndex);
}

/**
 * The election measures of the state legislatures read from Open States (state-legislation/index.json, close to a
 * megabyte compressed). Requested by the views that list or count them: the list of legislation, the page of a state,
 * and the map while it shows legislation. `wanted` false leaves the file alone.
 */
export function useStateLegislation(wanted = true): Loadable<StateLegislationIndex> {
  return useLoad(wanted ? 'state-legislation' : null, loadStateLegislationIndex);
}
