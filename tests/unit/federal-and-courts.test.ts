/** The federal level: the names and ids of the courts, the labels and stages of measures of Congress, and removed tags. */
import { describe, expect, it } from 'vitest';
import {
  FEDERAL_STAGES, PASSED_IN_EACH_STAGES, stateLabel, billHeading, billJurisdiction, billLabel, billLabelFromId, billLabelWithSession, identifierVariants, isAdoptedMeasure,
  isFederalBill, shortSession, stageRank, statusNoun,
} from '../../src/lib/bills';
import {
  CourtDirectory, casesByCourt, circuitCourtId, courtCitation, courtGeoKey, courtIdOfCase, fixedFullName, fixedShortName, isAppealsCourtId, isCourtId, matchesCourt,
} from '../../src/lib/courts';
import { caseNameClass, isAllCaps } from '../../src/lib/format';
import { LegalCaseSchema, RemovedTagSchema } from '../../src/types/schemas';
import { makeAppealsCase, makeBill, makeCase, makeCircuitsFile, makeFederalBill, makeFullAppealsCase, SYNTHETIC_HOST } from './fixtures';

describe('the courts', () => {
  it('maps a circuit on the map to its court and back', () => {
    expect([circuitCourtId('05'), circuitCourtId('11'), circuitCourtId('DC'), circuitCourtId('12')]).toEqual(['ca5', 'ca11', 'cadc', null]);
    expect([courtGeoKey('ca5'), courtGeoKey('cadc'), courtGeoKey('cafc'), courtGeoKey('scotus')]).toEqual(['circuit:05', 'circuit:DC', null, null]);
  });

  it('knows exactly fourteen courts', () => {
    const ids = ['scotus', 'cadc', 'cafc', ...Array.from({ length: 11 }, (_, i) => `ca${i + 1}`)];
    expect(ids.every(isCourtId)).toBe(true);
    expect(['ca0', 'ca12', 'ca', 'scotus2', undefined].some(isCourtId)).toBe(false);
    expect(isAppealsCourtId('scotus')).toBe(false);
  });

  it('reads the court from a case id, and names no court for an id of neither form', () => {
    expect([courtIdOfCase('ca5-25-30725'), courtIdOfCase('cadc-24-07050'), courtIdOfCase('scotus-24-109'), courtIdOfCase('scotus-23a449')]).toEqual(['ca5', 'cadc', 'scotus', 'scotus']);
    expect([courtIdOfCase('bogus'), courtIdOfCase('scotus'), courtIdOfCase('')]).toEqual([null, null, null]);
    expect(matchesCourt('ca9', 'appeals') && matchesCourt('ca9', 'ca9') && !matchesCourt('scotus', 'appeals') && !matchesCourt('ca9', 'ca5')).toBe(true);
  });

  it('names and cites the courts', () => {
    expect([fixedShortName('ca2'), fixedShortName('cadc'), fixedShortName('cafc'), fixedShortName('scotus'), fixedShortName('x')])
      .toEqual(['Second Circuit', 'D.C. Circuit', 'Federal Circuit', 'Supreme Court', null]);
    expect(fixedFullName('ca11')).toBe('United States Court of Appeals for the Eleventh Circuit');
    expect(fixedFullName('cadc')).toBe('United States Court of Appeals for the District of Columbia Circuit');
    expect([courtCitation('ca2'), courtCitation('ca3'), courtCitation('ca5'), courtCitation('cadc'), courtCitation('cafc'), courtCitation('scotus')])
      .toEqual(['2d Cir.', '3d Cir.', '5th Cir.', 'D.C. Cir.', 'Fed. Cir.', 'U.S.']);
  });

  it('the directory finds the court of a state, and the Federal Circuit has no area', () => {
    const courts = new CourtDirectory([], makeCircuitsFile());
    expect(courts.forState('06')?.id).toBe('ca9');
    expect(courts.forState('99')).toBeUndefined();
    expect(courts.forGeoKey('circuit:05')?.id).toBe('ca5');
    expect(courts.regional.map((c) => c.id)).toEqual(['ca3', 'ca5', 'ca9']);
    expect(courts.shortName('cafc')).toBe('Federal Circuit');
    expect(courts.shortName('scotus')).toBe('Supreme Court');
    expect(casesByCourt([makeCase(), makeAppealsCase(), makeAppealsCase({ id: 'ca9-99-00002' })])).toEqual(new Map([['scotus', 1], ['ca9', 2]]));
  });
});

describe('measures of Congress', () => {
  const federal = makeFederalBill();
  const state = makeBill({ identifier: 'AB 604' });

  it('are cited by their own number; a state bill carries its state', () => {
    expect([isFederalBill(federal), isFederalBill(state)]).toEqual([true, false]);
    expect([billLabel(federal), billLabel(state)]).toEqual(['H.R. 9001', 'CA AB 604']);
    expect([billHeading(federal), billHeading(state)]).toEqual(['H.R. 9001', 'California AB 604']);
    // A bill of another state is named by that state's abbreviation, never as California's.
    expect([stateLabel(state), stateLabel({ ...state, stateAbbr: 'NY' }), billHeading({ ...state, stateAbbr: 'NY' })]).toEqual(['California', 'NY', 'NY AB 604']);
    expect([billJurisdiction(federal), billJurisdiction(state)]).toEqual(['us', 'ca']);
    expect(billLabelWithSession(federal)).toBe('H.R. 9001, 119th Congress');
    expect(shortSession('2025-2026 Regular Session')).toBe('2025-2026 Regular Session');
    expect([statusNoun(federal), statusNoun(state)]).toEqual(['Stage reached', 'Status as reported']);
  });

  it('are found however their number is typed, and labelled from an id alone', () => {
    expect(identifierVariants('H.R. 22')).toEqual(['H.R. 22', 'H.R.22', 'HR 22', 'HR22']);
    expect([billLabelFromId('us-119-hr22'), billLabelFromId('us-119-sjres5'), billLabelFromId('ca-20252026-ab604'), billLabelFromId('us-119-xx1'), billLabelFromId('nope')])
      .toEqual(['H.R. 22', 'S.J.Res. 5', 'CA AB 604', null, null]);
  });

  it('a simple or concurrent resolution is adopted; a joint resolution is acted on like a bill', () => {
    const of = (measureType: string) => isAdoptedMeasure({ state: 'US', measureType });
    expect([of('House Resolution'), of('Senate Concurrent Resolution'), of('House Joint Resolution'), of('Senate Bill')]).toEqual([true, true, false, false]);
    expect(isAdoptedMeasure({ state: '06', measureType: 'Assembly Constitutional Amendment' })).toBe(true);
  });

  it('stages are ranked from the first to the furthest, and an unknown stage ranks below them all', () => {
    expect(stageRank('Introduced')).toBe(0);
    expect(stageRank('Became law')).toBe(FEDERAL_STAGES.length - 1);
    expect(stageRank('Passed the House')).toBeLessThan(stageRank('Sent to the President'));
    expect([stageRank('Something new'), stageRank(null)]).toEqual([-1, -1]);
    for (const stage of PASSED_IN_EACH_STAGES) expect(FEDERAL_STAGES).toContain(stage);
    expect(FEDERAL_STAGES.some((stage) => /both chambers/i.test(stage))).toBe(false);
  });
});

describe('case names and removed tags', () => {
  it('a name the court writes in capitals is set a little smaller', () => {
    expect([isAllCaps('IN RE: JOHN DOE'), isAllCaps('Smith v. Jones'), isAllCaps('')]).toEqual([true, false, false]);
    expect(caseNameClass('IN RE: JOHN DOE')).toBe('case-name case-name-caps');
    expect(caseNameClass('Smith v. Jones')).toBe('case-name');
  });

  it('a removed tag carries its reason, the passage and the document, and a case without any reads as none', () => {
    const removed = {
      tag: 'redistricting', ruleId: 'tag-synthetic-1', matchedField: 'full text of the opinion', matchedText: 'gerrymander', matchCount: 6,
      removalRuleId: 'tag-removal-1', reason: 'The case is about a primary.', quote: 'a closed primary', quoteUrl: `${SYNTHETIC_HOST}/appeals/99-00001/opinion.pdf`,
    };
    expect(RemovedTagSchema.safeParse(removed).success).toBe(true);
    expect(RemovedTagSchema.safeParse({ ...removed, quoteUrl: 'http://example.test/x' }).success).toBe(false);
    expect(RemovedTagSchema.safeParse({ ...removed, reason: undefined }).success).toBe(false);
    const { removedTags: _none, ...older } = makeFullAppealsCase();
    expect(LegalCaseSchema.parse(older).removedTags).toEqual([]);
    expect(LegalCaseSchema.parse(makeFullAppealsCase({ removedTags: [removed] })).removedTags).toHaveLength(1);
  });
});
