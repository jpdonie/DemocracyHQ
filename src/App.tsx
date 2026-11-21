import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Layer } from './types/schemas';
import { APP_NAME, REPO_URL } from './config';
import { billLabel, isFederalBill } from './lib/bills';
import { CoreProvider, useCore, useGovernment } from './lib/core';
import {
  SCOTUS_ID, casesByCourt, circuitCourtId, circuitViewBbox, courtFullName, courtGeoKey, courtHash, courtIdOfCase, isCourtId,
} from './lib/courts';
import { isAppealsCaseId, isFederalBillId, loadPopulation } from './lib/data';
import { caseStateCounts } from './lib/filters';
import { NATION_KEY, isCensusLayer, isDistrictLayer, isLayer, parseGeoKey, unionBbox, type Bbox } from './lib/geo';
import { caseStatesTheme, circuitTheme, coverageTheme, linkedRecordsTheme, partyControlTheme, populationTheme, redrawnTheme, type MapTheme } from './lib/mapTheme';
import { linkedStates, relationshipsForRecord } from './lib/relations';
import { buildHash, mapQuery, moveStartedOn, navigate, patchQuery, useRoute, type Route } from './lib/router';
import { COMPACT_QUERY, SHORT_COMPACT_QUERY, TINY_COMPACT_QUERY, useMediaQuery } from './lib/media';
import { isPlainClick, RaiseSheetContext } from './lib/sheet';
import { dataOf, useLoad } from './lib/useLoad';
import { focusHeadingWhenShown, restorePlaceWhenShown } from './lib/focus';
import { lastArrival } from './lib/scrollMemory';
import { BrandMark } from './components/BrandMark';
import { GlobalSearch } from './components/GlobalSearch';
import { LayerControl, Legend, type DistrictPlan, type MapChoice, type StateShading } from './components/MapChrome';
import { ReleaseNotice } from './components/ReleaseNotice';
import type { MapPadding } from './components/MapView';
import { ErrorNote, Icon, Loading } from './components/ui';
import { AboutPage } from './features/about/AboutPage';
import { CourtPage } from './features/courts/CourtPage';
import { CourtsOverview } from './features/courts/CourtsOverview';
import { FederalWorkspace } from './features/federal/FederalWorkspace';
import { HomePanel } from './features/geography/HomePanel';
import { PackView } from './features/geography/PackView';
import { PlaceWorkspace } from './features/geography/PlaceWorkspace';
import { BillDetail } from './features/legislation/BillDetail';
import { BillDirectory } from './features/legislation/BillDirectory';
import { VersionCompare } from './features/legislation/VersionCompare';
import { CaseDetail } from './features/litigation/CaseDetail';
import { CaseDirectory } from './features/litigation/CaseDirectory';
import { RedistrictingPanel } from './features/redistricting/RedistrictingPanel';
import { SourcesPage } from './features/sources/SourcesPage';
import { WatchlistPage } from './features/watchlist/WatchlistPage';

export type View =
  | { name: 'home' }
  | { name: 'litigation' }
  | { name: 'case'; id: string }
  | { name: 'laws' }
  | { name: 'bill'; id: string }
  | { name: 'compare'; id: string }
  | { name: 'redistricting' }
  | { name: 'place'; key: string }
  | { name: 'courts' }
  | { name: 'court'; id: string }
  | { name: 'sources' }
  | { name: 'about' }
  | { name: 'watchlist' }
  | { name: 'pack'; kind: string | undefined; id: string | undefined }
  | { name: 'notfound' };

export function resolveView(route: Route): View {
  const [a, b, c] = route.path;
  if (!a) return { name: 'home' };
  if (a === 'litigation') return b ? { name: 'case', id: b } : { name: 'litigation' };
  if (a === 'laws') {
    if (!b) return { name: 'laws' };
    return c === 'compare' ? { name: 'compare', id: b } : { name: 'bill', id: b };
  }
  if (a === 'redistricting') return { name: 'redistricting' };
  if (a === 'place' && b) {
    // A circuit is the area of a court of appeals, so its page is that court's page.
    const parsed = parseGeoKey(b);
    const courtId = parsed?.layer === 'circuit' ? circuitCourtId(parsed.geoid) : null;
    return courtId ? { name: 'court', id: courtId } : { name: 'place', key: b };
  }
  if (a === 'courts') return { name: 'courts' };
  if (a === 'court') return b && isCourtId(b) ? { name: 'court', id: b } : { name: 'notfound' };
  if (a === 'sources') return { name: 'sources' };
  if (a === 'about') return { name: 'about' };
  if (a === 'watchlist') return { name: 'watchlist' };
  if (a === 'pack') return { name: 'pack', kind: b, id: c };
  return { name: 'notfound' };
}

const WIDE: ReadonlySet<View['name']> = new Set(['compare', 'sources', 'about', 'watchlist', 'pack']);

/**
 * The map stack (MapLibre, its worker and the boundary files) is loaded with the first view that shows the map, so a
 * reader who opens the sources, the about page or a source pack directly does not download it.
 */
const MapView = lazy(() => import('./components/MapView').then((module) => ({ default: module.MapView })));

/** If the map code itself cannot be loaded, the panel and search still work; the map area says what happened. */
class MapLoadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="map-fallback">
        <p className="state state-error" role="alert"><strong>The map could not be loaded.</strong> Check the connection and reload the page. Everything else on this site works without it.</p>
      </div>
    );
  }
}

/** The document title of a source pack names its subject, so a saved or printed pack is named after it. */
export function packTitle(
  view: { kind: string | undefined; id: string | undefined },
  cases: ReadonlyArray<{ id: string; caseName: string; docketNumber: string }> | null | undefined,
  bills: ReadonlyArray<{ id: string; state: string; stateAbbr: string; identifier: string; subject?: string | null }> | null | undefined,
  geo: { get(key: string): { name: string } | undefined } | null | undefined,
): string {
  const base = 'Legal source pack';
  if (!view.id) return base;
  if (view.kind === 'case') {
    const record = cases?.find((c) => c.id === view.id);
    return record ? `${base}: ${record.caseName} (No. ${record.docketNumber})` : base;
  }
  if (view.kind === 'bill') {
    const bill = bills?.find((b) => b.id === view.id);
    if (!bill) return base;
    const subject = bill.subject?.trim().replace(/\.$/, '');
    return `${base}: ${billLabel(bill)}${subject ? ` (${subject})` : ''}`;
  }
  if (view.kind === 'place') {
    const name = geo?.get(view.id)?.name;
    return name ? `${base}: ${name}` : base;
  }
  return base;
}

function moduleOf(view: View): 'home' | 'litigation' | 'laws' | 'redistricting' | 'sources' | 'other' {
  if (view.name === 'home' || view.name === 'place' || view.name === 'courts' || view.name === 'court') return 'home';
  if (view.name === 'litigation' || view.name === 'case') return 'litigation';
  if (view.name === 'laws' || view.name === 'bill' || view.name === 'compare') return 'laws';
  if (view.name === 'redistricting') return 'redistricting';
  if (view.name === 'sources') return 'sources';
  return 'other';
}

type SheetSize = 'peek' | 'half' | 'full';

/** What the sheet size means, for screen readers (the sheet bar buttons announce it when it changes). */
const SHEET_LABELS: Readonly<Record<SheetSize, string>> = {
  peek: 'Panel lowered: the map fills most of the screen.',
  half: 'Panel at half height, below the map.',
  full: 'Panel at full height: the map is hidden.',
};

/**
 * A phone held sideways is too short for a half-height sheet, so the map views open with the sheet lowered.
 * A link to one of a place's tabs (?tab=) is a link to that content, so it opens with the sheet raised.
 */
function defaultSheet(view: View, short: boolean, tab: string | undefined): SheetSize {
  if (view.name === 'place' && tab && tab !== 'overview') return 'full';
  if (view.name === 'home' || view.name === 'place' || view.name === 'redistricting' || view.name === 'courts' || view.name === 'court') return short ? 'peek' : 'half';
  return 'full';
}

/** The choice in the map's control that draws a layer of boundaries. */
function choiceOfLayer(layer: Layer): MapChoice {
  if (layer === 'circuit') return 'circuit';
  if (layer === 'county') return 'county';
  return isDistrictLayer(layer) ? 'district' : 'state';
}

/** On a phone the top bar has no room for the page links, so the pages that are not in the tab bar sit behind one button. */
function MoreMenu({ view, route }: { view: View; route: Route }) {
  const ref = useRef<HTMLDetailsElement | null>(null);
  const close = () => { if (ref.current) ref.current.open = false; };
  useEffect(close, [route]);
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (ref.current?.open && !ref.current.contains(event.target as Node)) ref.current.open = false;
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, []);
  const onKeyDown = (event: React.KeyboardEvent<HTMLDetailsElement>) => {
    if (event.key !== 'Escape' || !ref.current?.open) return;
    close();
    ref.current.querySelector('summary')?.focus();
  };
  // When keyboard focus moves on past the menu, the menu closes, so it never covers the control that now has focus.
  // A blur with no new focus target (a tap that Safari does not turn into focus) is left to the pointerdown handler.
  const onBlur = (event: React.FocusEvent<HTMLDetailsElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && !event.currentTarget.contains(next)) close();
  };
  return (
    <details className="topnav-more" ref={ref} onKeyDown={onKeyDown} onBlur={onBlur}>
      <summary>More<span className="sr-only"> pages</span><Icon name="down" /></summary>
      <nav aria-label="Other pages" onClick={close}>
        <a href={buildHash(['watchlist'])} aria-current={view.name === 'watchlist' ? 'page' : undefined}>Watchlist</a>
        <a href={buildHash(['about'])} aria-current={view.name === 'about' ? 'page' : undefined}>About and corrections</a>
      </nav>
    </details>
  );
}

function Shell() {
  const route = useRoute();
  const core = useCore();
  const view = useMemo(() => resolveView(route), [route]);
  const module = moduleOf(view);
  const wide = WIDE.has(view.name);
  const compact = useMediaQuery(COMPACT_QUERY);
  const short = useMediaQuery(SHORT_COMPACT_QUERY);
  // A very short screen (for example a laptop screen at 400% zoom): the page scrolls as one document (see app.css).
  const tiny = useMediaQuery(TINY_COMPACT_QUERY);
  const geo = dataOf(core.geo);
  const relationships = dataOf(core.relationships);
  const cases = dataOf(core.cases);
  const bills = dataOf(core.bills);
  const courts = dataOf(core.courts);
  const redistricting = dataOf(core.redistricting);
  const sources = dataOf(core.sources) ?? [];
  const panelRef = useRef<HTMLElement | null>(null);
  const [sheet, setSheet] = useState<SheetSize>(() => defaultSheet(view, short, route.query.tab));
  const raiseSheet = useCallback(() => setSheet('full'), []);
  const [boundaryErrors, setBoundaryErrors] = useState<Partial<Record<Layer, string>>>({});
  // Once a view with the map has been shown, the map stays mounted (hidden) on the wide views, so going back is instant.
  const [mapWanted, setMapWanted] = useState(!wide);
  if (!wide && !mapWanted) setMapWanted(true);

  /* ----- what the map shows ----- */
  const placeParsed = view.name === 'place' ? parseGeoKey(view.key) : null;
  // Only the Census layers can be asked for in an address. The country as a whole and the circuits come with their own views.
  const queryLayer = isLayer(route.query.layer) && isCensusLayer(route.query.layer) ? route.query.layer : null;
  // The court a view is about: a court's own page, or the page of one of its cases.
  const viewCourt = view.name === 'court' ? view.id : view.name === 'case' ? courtIdOfCase(view.id) : null;
  const showsCircuits = view.name === 'courts' || (viewCourt !== null && viewCourt !== SCOTUS_ID);
  // A record of the whole country: the country's own page, a measure of Congress, or the list of them.
  const federalRecord = (view.name === 'place' && view.key === NATION_KEY)
    || ((view.name === 'bill' || view.name === 'compare') && isFederalBillId(view.id))
    || (view.name === 'laws' && route.query.jur === 'us');
  // The country is never the layer units are picked from: on its views the states stay in reach and it is outlined.
  const activeLayer: Layer = queryLayer
    ?? (placeParsed && isCensusLayer(placeParsed.layer) ? placeParsed.layer : null)
    ?? (showsCircuits ? 'circuit' : view.name === 'redistricting' ? 'cd120' : 'state');
  const mapChoice: MapChoice = queryLayer ? choiceOfLayer(queryLayer)
    : federalRecord ? 'federal'
    : viewCourt === SCOTUS_ID ? 'supreme'
    : choiceOfLayer(activeLayer);
  const districtPlan: DistrictPlan = activeLayer === 'cd119' ? 'cd119' : 'cd120';

  const focusKeys = useMemo<string[]>(() => {
    if (!geo) return [];
    const known = (keys: ReadonlyArray<string | null>) => keys.filter((key): key is string => Boolean(key && geo.get(key)));
    if (view.name === 'place') return known([view.key]);
    // The Supreme Court sits over the whole country; a court of appeals over its circuit; the Federal Circuit has no area.
    if (view.name === 'court') return known([view.id === SCOTUS_ID ? NATION_KEY : courtGeoKey(view.id)]);
    if (view.name === 'case') {
      if (isAppealsCaseId(view.id)) return known([courtGeoKey(courtIdOfCase(view.id) ?? '')]);
      if (!relationships) return [];
      return known(relationshipsForRecord('case', view.id, relationships).filter((r) => r.target.type === 'geography').map((r) => r.target.id));
    }
    if (view.name === 'bill' || view.name === 'compare') {
      if (isFederalBillId(view.id)) return known([NATION_KEY]);
      const bill = bills?.bills.find((b) => b.id === view.id);
      return bill ? known([`state:${bill.state}`]) : [];
    }
    if (view.name === 'litigation') {
      if (route.query.state) return known([`state:${route.query.state}`]);
      return route.query.court ? known([courtGeoKey(route.query.court)]) : [];
    }
    if (view.name === 'laws' && route.query.jur === 'us') return known([NATION_KEY]);
    return [];
  }, [geo, view, relationships, bills, route.query.state, route.query.court, route.query.jur]);

  // Outline the most specific linked unit (a district or county before its state).
  const selectedKey = useMemo(() => {
    const specific = focusKeys.find((key) => !key.startsWith('state:'));
    return specific ?? focusKeys[0] ?? null;
  }, [focusKeys]);

  const [fit, setFit] = useState<{ key: string; bbox: Bbox | null }>({ key: 'home', bbox: null });
  // Views without a place of their own that show the whole country: the overview, the list of courts, a court with no area.
  const showsCountry = view.name === 'home' || view.name === 'courts' || view.name === 'court';
  const courtsSettled = core.courts.status !== 'loading';
  useEffect(() => {
    if (!geo) return;
    if (focusKeys.length === 0) {
      // Going back to an overview shows the whole country again. Directory views keep the reader's camera.
      if (showsCountry) setFit((previous) => (previous.key === 'home' ? previous : { key: 'home', bbox: null }));
      return;
    }
    const key = focusKeys.join('|');
    let bbox: Bbox | null;
    if (key === NATION_KEY) {
      // The country is shown as the overview shows it: its outline from Guam to Puerto Rico would shrink the states to a strip.
      bbox = null;
    } else if (focusKeys.length === 1 && key.startsWith('circuit:')) {
      // A circuit is fitted to its states near the others; which states those are is in the list of courts.
      if (!courtsSettled) return;
      const court = courts?.forGeoKey(key);
      bbox = court ? circuitViewBbox(court, geo) : geo.get(key)!.bbox;
    } else {
      bbox = unionBbox(focusKeys.map((k) => geo.get(k)!.bbox));
    }
    setFit((previous) => (previous.key === key ? previous : { key, bbox }));
  }, [geo, focusKeys, showsCountry, courts, courtsSettled]);

  // Census counts exist for the Census layers only.
  const shade = isCensusLayer(activeLayer) ? route.query.shade : undefined;
  const populationDataset = shade === 'population' ? (activeLayer === 'state' ? 'state' : activeLayer === 'county' ? 'county' : 'cd119') : null;
  const populationFile = useLoad(populationDataset ? `population:${populationDataset}` : null, () => loadPopulation(populationDataset!));

  // The states by the party that holds their government: a choice of the reader that stays from state to state.
  const partyShading = activeLayer === 'state' && shade === 'party';
  const government = useGovernment(partyShading);

  const theme = useMemo<MapTheme | null>(() => {
    if (!geo) return null;
    if (activeLayer === 'circuit') return cases ? circuitTheme(casesByCourt(cases)) : null;
    if (shade === 'population') {
      return populationFile.status === 'ready' ? populationTheme(activeLayer, geo, populationFile.data, redistricting) : null;
    }
    if (partyShading) return government.status === 'ready' ? partyControlTheme(government.data.states) : null;
    if (isDistrictLayer(activeLayer)) return redistricting && shade !== 'none' ? redrawnTheme(activeLayer, geo, redistricting) : null;
    if (activeLayer !== 'state') return null;
    // A record of the whole country belongs to no single state, so no state is shaded for it.
    if (federalRecord) return null;
    if (module === 'laws') {
      if (!bills) return null;
      return coverageTheme(new Set(bills.bills.filter((b) => !isFederalBill(b)).map((b) => b.state)), bills.bills.some(isFederalBill));
    }
    if (module === 'litigation') return cases ? caseStatesTheme(caseStateCounts(cases)) : null;
    if (module === 'redistricting') return null;
    // The Supreme Court's page: the states its dockets are linked to.
    if (view.name === 'court') return relationships ? linkedRecordsTheme(linkedStates(relationships, 'case'), 'cases') : null;
    return relationships ? linkedRecordsTheme(linkedStates(relationships, 'any'), 'records') : null;
  }, [geo, shade, populationFile, partyShading, government, activeLayer, redistricting, module, bills, relationships, cases, federalRecord, view.name]);

  const onSelect = useCallback((key: string) => {
    const current = routeRef.current;
    const currentView = resolveView(current);
    const parsed = parseGeoKey(key);
    if (parsed?.layer === 'circuit') {
      const courtId = circuitCourtId(parsed.geoid);
      if (courtId) navigate(courtHash(courtId));
      return;
    }
    if (currentView.name === 'litigation' && key.startsWith('state:')) {
      const fips = key.slice(6);
      patchQuery(current, { state: current.query.state === fips ? '' : fips }, { replace: false });
      return;
    }
    navigate(buildHash(['place', key], mapQuery(current.query)));
  }, []);
  const routeRef = useRef(route);
  routeRef.current = route;

  // The map's control: a level of government or the federal courts.
  const onChoice = useCallback((choice: MapChoice) => {
    const current = routeRef.current;
    const currentView = resolveView(current);
    if (choice === 'federal') return navigate(buildHash(['place', NATION_KEY], mapQuery(current.query)));
    if (choice === 'supreme') return navigate(courtHash(SCOTUS_ID));
    if (choice === 'circuit') return navigate(buildHash(['courts']));
    const layer: Layer = choice === 'district' ? 'cd120' : choice;
    // The pages of the country and of the courts have no boundaries of their own to change: from them the choice
    // leads to the overview with those boundaries. Every other view stays and only its map changes.
    const leaves = currentView.name === 'courts' || currentView.name === 'court' || (currentView.name === 'place' && currentView.key === NATION_KEY);
    if (leaves) return navigate(buildHash([], layer === 'state' ? mapQuery(current.query) : { layer }));
    return patchQuery(current, { layer, shade: '' }, { replace: false });
  }, []);
  const onPlan = useCallback((plan: DistrictPlan) => patchQuery(routeRef.current, { layer: plan, shade: '' }, { replace: false }), []);
  const onCircuit = useCallback((courtId: string) => navigate(courtId ? courtHash(courtId) : buildHash(['courts'])), []);
  const onShading = useCallback((value: StateShading) => patchQuery(routeRef.current, { shade: value === 'party' ? 'party' : '' }, { replace: false }), []);
  const [controlBottom, setControlBottom] = useState(0);

  const onBoundaryError = useCallback((layer: Layer, message: string) => {
    setBoundaryErrors((previous) => ({ ...previous, [layer]: message }));
  }, []);
  // A layer that loads after an earlier failure (the connection came back) no longer shows the error.
  const onBoundaryLoaded = useCallback((layer: Layer) => {
    setBoundaryErrors((previous) => {
      if (!(layer in previous)) return previous;
      const next = { ...previous };
      delete next[layer];
      return next;
    });
  }, []);

  // Room kept clear for the floating controls: the map's control and zoom buttons on top,
  // the legend and locator row at the bottom. Where the control ends is measured, because it grows by a row when a
  // district plan or a circuit can be chosen and when its two groups do not fit side by side. A phone held sideways
  // has a short, wide stage: the controls sit in a column on the left and the legend at the bottom right.
  const padding = useMemo<MapPadding>(() => {
    if (!compact) return { top: controlBottom ? controlBottom + 10 : 92, right: 64, bottom: 236, left: 76 };
    // On a very short screen the map is too small to keep its controls clear.
    if (tiny) return { top: 8, right: 8, bottom: 8, left: 8 };
    if (short) return { top: 16, right: 104, bottom: 16, left: 264 };
    return { top: controlBottom ? controlBottom + 12 : 72, right: 20, bottom: 64, left: 20 };
  }, [compact, short, tiny, controlBottom]);

  /* ----- page-level behaviour ----- */
  const pathKey = route.path.join('/');
  const firstRender = useRef(true);
  useEffect(() => {
    setSheet(defaultSheet(view, short, route.query.tab));
    if (firstRender.current) {
      firstRender.current = false;
      return undefined;
    }
    const panel = panelRef.current;
    if (!panel) return undefined;
    const arrival = lastArrival();
    // Back or Forward to a view seen before: the same place in it, with focus on the link that was followed from it
    // (main.tsx starts keeping places).
    if (arrival.kind === 'traverse' && arrival.place) return restorePlaceWhenShown(panel, arrival.place, moveStartedOn());
    panel.scrollTo({ top: 0 });
    // On a very short screen the page itself scrolls.
    if (window.scrollY > 0) window.scrollTo({ top: 0 });
    // A move made with the map's own control leaves focus on it, so a reader going through its choices with the
    // arrow keys can keep going. The choice itself says what is shown now.
    const startedOn = moveStartedOn();
    if (startedOn?.closest('.layer-control')) return undefined;
    return focusHeadingWhenShown(panel, startedOn);
    // Only the path matters here; filter changes must not move focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathKey]);

  useEffect(() => {
    let title = '';
    if (view.name === 'case') {
      const record = cases?.find((c) => c.id === view.id);
      title = record ? `${record.caseName}, No. ${record.docketNumber}` : 'Court case';
    } else if (view.name === 'bill' || view.name === 'compare') {
      const bill = bills?.bills.find((b) => b.id === view.id);
      title = bill ? `${billLabel(bill)}: ${bill.subject ?? ''}` : 'Legislation';
      if (view.name === 'compare') title = `Text versions, ${title}`;
    } else if (view.name === 'place') title = geo?.get(view.key)?.name ?? 'Place';
    else if (view.name === 'courts') title = 'Federal courts';
    else if (view.name === 'court') title = courtFullName(courts?.get(view.id), view.id);
    else if (view.name === 'litigation') title = 'Election litigation';
    else if (view.name === 'laws') title = 'Election legislation';
    else if (view.name === 'redistricting') title = 'Districts and boundaries';
    else if (view.name === 'sources') title = 'Data sources and methodology';
    else if (view.name === 'about') title = 'About';
    else if (view.name === 'watchlist') title = 'Watchlist';
    else if (view.name === 'pack') title = packTitle(view, cases, bills?.bills, geo);
    else if (view.name === 'notfound') title = 'Page not found';
    document.title = title ? `${title} | ${APP_NAME}` : `${APP_NAME}: election law, litigation and district maps`;
  }, [view, cases, bills, geo, courts]);

  /* ----- render ----- */
  let panel: React.ReactNode;
  switch (view.name) {
    case 'home': panel = <HomePanel />; break;
    case 'litigation': panel = <CaseDirectory route={route} />; break;
    case 'case': panel = <CaseDetail id={view.id} route={route} />; break;
    case 'laws': panel = <BillDirectory route={route} />; break;
    case 'bill': panel = <BillDetail id={view.id} route={route} />; break;
    case 'compare': panel = <VersionCompare id={view.id} route={route} />; break;
    case 'redistricting': panel = <RedistrictingPanel route={route} layer={activeLayer} />; break;
    case 'place': panel = view.key === NATION_KEY ? <FederalWorkspace route={route} /> : <PlaceWorkspace placeKey={view.key} route={route} />; break;
    case 'courts': panel = <CourtsOverview />; break;
    case 'court': panel = <CourtPage id={view.id} />; break;
    case 'sources': panel = <SourcesPage route={route} />; break;
    case 'about': panel = <AboutPage route={route} />; break;
    case 'watchlist': panel = <WatchlistPage />; break;
    case 'pack': panel = <PackView kind={view.kind} id={view.id} />; break;
    default:
      panel = (
        <article className="view">
          <header className="view-head"><h1 tabIndex={-1}>Page not found</h1></header>
          <p>No page exists at this address. It may have been mistyped, or the record may have been removed.</p>
          <p><a href={buildHash([])}>Go to the map</a></p>
        </article>
      );
  }

  const navLinks: Array<{ id: ReturnType<typeof moduleOf>; label: string; short: string; hash: string }> = [
    { id: 'litigation', label: 'Litigation', short: 'Litigation', hash: buildHash(['litigation']) },
    { id: 'laws', label: 'Legislation', short: 'Laws', hash: buildHash(['laws']) },
    { id: 'redistricting', label: 'Redistricting', short: 'Districts', hash: buildHash(['redistricting']) },
  ];
  const sheetOrder: SheetSize[] = short ? ['peek', 'full'] : ['peek', 'half', 'full'];
  // A phone turned sideways has no half-height sheet.
  const sheetSize: SheetSize = short && sheet === 'half' ? 'peek' : sheet;
  // On a phone the full-height sheet covers the map, so the map must leave the tab order too.
  const mapHidden = wide || (compact && sheetSize === 'full');
  const sheetIndex = sheetOrder.indexOf(sheetSize);
  const atSmallest = sheetIndex === 0;
  const atLargest = sheetIndex === sheetOrder.length - 1;
  const tabbar = (
    <nav className="tabbar" aria-label="Sections">
      <a href={buildHash([])} aria-current={module === 'home' ? 'page' : undefined}>Map</a>
      {navLinks.map((link) => <a key={link.id} href={link.hash} aria-current={module === link.id ? 'page' : undefined}>{link.short}</a>)}
      <a href={buildHash(['sources'])} aria-current={module === 'sources' ? 'page' : undefined}>Sources</a>
    </nav>
  );

  return (
    <div className={`app${wide ? ' is-wide' : ''}${compact ? ' is-compact' : ''}`} data-sheet={compact ? (wide ? 'full' : sheetSize) : undefined}>
      {/* The address is the current view, so the link still works when it is opened in a new tab or copied ("#panel" would
          be read as a route and lead to "Page not found"). Followed here, it moves focus into the panel. */}
      <a className="skip-link" href={buildHash(route.path, route.query)} onClick={(event) => { if (!isPlainClick(event)) return; event.preventDefault(); panelRef.current?.focus(); }}>Skip to content</a>
      <header className="topnav">
        <a className="brand" href={buildHash([])} aria-label={`${APP_NAME}, overview map`} aria-current={view.name === 'home' ? 'page' : undefined}>
          <BrandMark />
          <span>{APP_NAME}</span>
        </a>
        <nav className="topnav-links" aria-label="Modules">
          {navLinks.map((link) => <a key={link.id} href={link.hash} aria-current={module === link.id ? 'page' : undefined}>{link.label}</a>)}
        </nav>
        <GlobalSearch />
        {compact ? <MoreMenu view={view} route={route} /> : null}
        <nav className="topnav-meta" aria-label="About this site">
          <a href={buildHash(['sources'])} aria-current={view.name === 'sources' ? 'page' : undefined}>Data and methodology</a>
          <a href={buildHash(['watchlist'])} aria-current={view.name === 'watchlist' ? 'page' : undefined}>Watchlist</a>
          <a href={buildHash(['about'])} aria-current={view.name === 'about' ? 'page' : undefined}>About</a>
          {REPO_URL
            ? <a href={REPO_URL} rel="noopener noreferrer external">GitHub</a>
            : <a href={buildHash(['about'], { section: 'source' })}>GitHub</a>}
        </nav>
      </header>
      {/* On a very short screen the page scrolls as one document: the section links follow the top bar, so they are
          reached first, and nothing stays fixed over the content. Elsewhere the tab bar is fixed at the bottom. */}
      {tiny ? tabbar : null}

      <div className="workspace">
        <section className="mapstage" aria-label="Map" aria-hidden={mapHidden ? true : undefined} inert={mapHidden ? true : undefined}>
          {!mapWanted ? null : core.geo.status === 'ready' ? (
            <MapLoadBoundary>
              <Suspense fallback={<div className="map-fallback"><Loading what="the map" /></div>}>
                <MapView
                  geo={core.geo.data}
                  activeLayer={activeLayer}
                  selectedKey={selectedKey}
                  theme={theme}
                  fitKey={fit.key}
                  fitBbox={fit.bbox}
                  padding={padding}
                  onSelect={onSelect}
                  onBoundaryError={onBoundaryError}
                  onBoundaryLoaded={onBoundaryLoaded}
                >
                  <LayerControl
                    choice={mapChoice}
                    plan={districtPlan}
                    circuit={showsCircuits && viewCourt ? viewCourt : ''}
                    courts={courts?.appeals ?? []}
                    compact={compact}
                    onChoice={onChoice}
                    onPlan={onPlan}
                    onCircuit={onCircuit}
                    shading={activeLayer === 'state' ? (partyShading ? 'party' : 'records') : null}
                    onShading={onShading}
                    onExtent={setControlBottom}
                  />
                  {/* On a phone the legend starts closed to leave the map and its controls clear; its summary shows the colours in use. */}
                  <Legend
                    theme={theme} layer={activeLayer} geo={core.geo.data} sources={sources} now={core.now} boundaryError={boundaryErrors[activeLayer] ?? null} startOpen={!compact}
                    emptyNote={partyShading
                      ? (government.status === 'error' ? 'The party figures could not be loaded, so the states are not coloured.' : 'Loading the party figures.')
                      : federalRecord && activeLayer === 'state' ? 'No shading: the records of Congress belong to the whole country, which is outlined. Select a state to open its records.' : null}
                  />
                </MapView>
              </Suspense>
            </MapLoadBoundary>
          ) : core.geo.status === 'error' ? (
            <div className="map-fallback"><ErrorNote error={core.geo.error} what="the map index" /></div>
          ) : (
            <div className="map-fallback"><Loading what="the map" /></div>
          )}
        </section>

        <main className="panel" id="panel" ref={panelRef} tabIndex={-1}>
          {compact && !wide ? (
            <div className="sheet-bar">
              <span className="sheet-grip" aria-hidden="true" />
              {/* aria-disabled, not disabled: a pressed button that reaches the end keeps keyboard focus. */}
              <button type="button" className="btn btn-quiet" aria-disabled={atSmallest} aria-describedby="sheet-size" onClick={() => { if (!atSmallest) setSheet(sheetOrder[sheetIndex - 1]!); }}>
                <Icon name="down" /><span className="sheet-label">Show more map</span>
              </button>
              <button type="button" className="btn btn-quiet" aria-disabled={atLargest} aria-describedby="sheet-size" onClick={() => { if (!atLargest) setSheet(sheetOrder[sheetIndex + 1]!); }}>
                <Icon name="up" /><span className="sheet-label">Show more detail</span>
              </button>
              <span id="sheet-size" className="sr-only" role="status">{SHEET_LABELS[sheetSize]}</span>
            </div>
          ) : null}
          <ReleaseNotice />
          <RaiseSheetContext.Provider value={raiseSheet}>{panel}</RaiseSheetContext.Provider>
          {/* The overview has its own footer with this statement and the About link. A printed source pack carries its own notices. */}
          {view.name !== 'home' ? (
            <footer className={`site-foot${view.name === 'pack' ? ' no-print' : ''}`}>
              <p>
                Research and educational tool. Not legal advice and not an official source. A data gap is not evidence of absence.{' '}
                <a href={buildHash(['about'])} aria-current={view.name === 'about' ? 'page' : undefined}>About and corrections</a>
              </p>
            </footer>
          ) : null}
        </main>
      </div>

      {tiny ? null : tabbar}
    </div>
  );
}

export function App() {
  return (
    <CoreProvider>
      <Shell />
    </CoreProvider>
  );
}
