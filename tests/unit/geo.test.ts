import { describe, expect, it } from 'vitest';
import { STATE_ABBR, stateKind, unitNoun } from '../../src/lib/geo';

describe('stateKind', () => {
  it('calls the 50 states states, and nothing else', () => {
    const states = Object.keys(STATE_ABBR).filter((fips) => stateKind(fips) === 'State');
    expect(states).toHaveLength(50);
    expect(states).not.toContain('11');
    expect(states).not.toContain('72');
  });

  it('calls the District of Columbia a federal district', () => {
    expect(stateKind('11')).toBe('Federal district');
  });

  it('calls Puerto Rico and the island areas territories', () => {
    for (const fips of ['60', '66', '69', '72', '78']) expect(stateKind(fips)).toBe('Territory');
  });

  it('does not guess for a code it does not know', () => {
    expect(stateKind('99')).toBe('State or equivalent');
  });
});

describe('unitNoun', () => {
  it('uses the kind for state-level units and the layer noun for the others', () => {
    expect(unitNoun({ layer: 'state', stateFips: '06' })).toBe('State');
    expect(unitNoun({ layer: 'state', stateFips: '72' })).toBe('Territory');
    expect(unitNoun({ layer: 'state', stateFips: '11' })).toBe('Federal district');
    expect(unitNoun({ layer: 'county', stateFips: '72' })).toBe('County');
    expect(unitNoun({ layer: 'cd120', stateFips: '11' })).toBe('Congressional district, 120th Congress');
  });
});
