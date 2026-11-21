/**
 * What a record is about, in the words of an official text.
 *
 * DemocracyHQ does not write a line of its own about a measure or a case. It quotes one: the summary of the
 * Congressional Research Service, the Legislative Counsel's Digest, the Question Presented, the opening of the opinion.
 * A published rule takes each quotation (rules about-*), and this component always says which text is quoted.
 */
import { Fragment, type ReactNode } from 'react';
import type { AboutText } from '../types/schemas';
import { formatDate } from '../lib/format';
import { buildHash } from '../lib/router';
import { A, Ext } from './ui';

/** Which text is quoted, in a few words, as a row shows it above the quotation. */
export function aboutLabel(about: AboutText): string {
  switch (about.source) {
    case 'crs-summary': return 'Congressional Research Service summary';
    case 'official-title': return 'Official title';
    case 'digest': return 'Legislative Counsel’s Digest';
    case 'question-presented': return about.of ? `Question presented (first of ${about.of})` : 'Question presented';
    case 'cited-passage': return `From ${about.document ?? 'a document of this docket'}`;
    case 'docket-entry': return 'Entry that opens the docket';
    case 'opinion': {
      // The first paragraph is the opening. Where it could not be quoted, the line says which paragraph is.
      const part = about.paragraph ? `Paragraph ${about.paragraph}` : 'Opening';
      return about.date ? `${part} of the opinion of ${formatDate(about.date)}` : `${part} of the opinion`;
    }
  }
}

/** The host of the address the quoted text is published at, in lower case, or '' where it has none. */
function hostOf(url: string | null | undefined): string {
  try {
    return url ? new URL(url).hostname.toLowerCase() : '';
  } catch {
    return '';
  }
}

/** Where the quoted text can be read, named for a link: by the site it is published on, which the address tells. */
export function sourceName(about: AboutText): string {
  const host = hostOf(about.url);
  const on = (site: string) => host === site || host.endsWith(`.${site}`);
  switch (about.source) {
    case 'crs-summary': return 'Congress.gov';
    case 'official-title': return on('congress.gov') ? 'Congress.gov' : 'the legislature’s page';
    case 'digest': return 'California Legislative Information';
    case 'question-presented': return 'the Court’s document';
    case 'cited-passage': return 'the document';
    case 'docket-entry': return 'the docket';
    case 'opinion': return on('courtlistener.com') ? 'the decision on CourtListener' : 'the opinion on GovInfo';
  }
}

/**
 * The quotation as it is shown. An ellipsis stands where it begins or stops inside a sentence: a passage cited from a
 * filing can begin in the middle of one, and a first sentence too long for a row is cut at a word.
 */
export function aboutQuote(about: AboutText): string {
  const opensInside = /^\p{Ll}/u.test(about.text);
  return `${opensInside ? '… ' : ''}${about.text}${about.cut ? ' …' : ''}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const WORD_CHARACTER = /[\p{L}\p{N}]/u;

function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && WORD_CHARACTER.test(character);
}

/** The term among `terms` (lower case, longest first) that stands at `at` in the text as whole words, if one does. */
function termAt(text: string, at: number, terms: readonly string[]): string | undefined {
  if (isWordCharacter(text[at - 1])) return undefined;
  return terms.find((term) => text.slice(at, at + term.length).toLowerCase() === term && !isWordCharacter(text[at + term.length]));
}

/** The terms as they are looked for: trimmed, in lower case, without duplicates, the longest first. */
function wantedTerms(terms: readonly string[] | undefined, shortest: number): string[] {
  return [...new Set((terms ?? []).map((term) => term.trim().toLowerCase()).filter((term) => term.length >= shortest))].sort((a, b) => b.length - a.length);
}

/**
 * Where the terms stand in the text as whole words, the way the selection rules count them: "mail-in" does not stand
 * in "mail-ins", nor "elect" in "election". Letter case is not compared. Longer terms are tried first, so "voter
 * registration" is found whole and not only "voter".
 */
function termPlaces(text: string, wanted: readonly string[]): Array<{ at: number; length: number }> {
  if (wanted.length === 0) return [];
  const pattern = new RegExp(wanted.map(escapeRegExp).join('|'), 'gi');
  const places: Array<{ at: number; length: number }> = [];
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const term = termAt(text, match.index, wanted);
    if (term) places.push({ at: match.index, length: term.length });
    pattern.lastIndex = term ? match.index + term.length : match.index + 1;
  }
  return places;
}

/** True when one of the terms stands in the text as whole words, compared without letter case. */
export function holdsTerm(text: string | null | undefined, terms: readonly string[]): boolean {
  return termPlaces(text ?? '', wantedTerms(terms, 1)).length > 0;
}

/**
 * Text with the words a selection rule matched marked in it. The mark shows the reader why the record is listed; it
 * changes no word. A term is marked only where it stands as whole words (see termPlaces).
 */
export function Highlight({ text, terms }: { text: string; terms?: readonly string[] }): ReactNode {
  const places = termPlaces(text, wantedTerms(terms, 3));
  if (places.length === 0) return text;
  const parts: ReactNode[] = [];
  let from = 0;
  for (const { at, length } of places) {
    if (at > from) parts.push(<Fragment key={from}>{text.slice(from, at)}</Fragment>);
    parts.push(<mark key={`hit-${at}`} className="hit">{text.slice(at, at + length)}</mark>);
    from = at + length;
  }
  if (from < text.length) parts.push(<Fragment key={from}>{text.slice(from)}</Fragment>);
  return <>{parts}</>;
}

/** The label of a further question the Court put to the parties, with the date of its order where the document gives it. */
export function laterLabel(later: NonNullable<AboutText['later']>): string {
  return later.date ? `Further question from the Court, order of ${formatDate(later.date)}` : 'Further question from the Court';
}

/** The quotation in a row of a list: the kind of text above it, then its words. */
export function AboutLine({ about, terms }: { about: AboutText | null | undefined; terms?: readonly string[] }) {
  if (!about) return null;
  const label = aboutLabel(about);
  return (
    <>
      <p className="row-about">
        {/* A long label names a document and whose words it holds: it is set as a sentence, not as a heading. */}
        <span className={`row-about-src${label.length > 48 ? ' is-long' : ''}`}>{label}</span>
        <q cite={about.url ?? undefined}><Highlight text={aboutQuote(about)} terms={terms} /></q>
      </p>
      {about.later ? (
        <p className="row-about row-about-later">
          <span className="row-about-src">{laterLabel(about.later)}</span>
          {/* The Court sets the questions of its orders in capitals. They are quoted as set. */}
          <q cite={about.url ?? undefined} className="as-set"><Highlight text={`${about.later.text}${about.later.cut ? ' …' : ''}`} terms={terms} /></q>
        </p>
      ) : null}
    </>
  );
}

/** The quotation at the head of a record's page, with the link to the text it is from and the rule that took it. */
export function AboutBlock({ about, terms, type }: { about: AboutText | null | undefined; terms?: readonly string[]; type: 'case' | 'bill' }) {
  if (!about) return null;
  return (
    <figure className={`about-block about-${type}`}>
      <figcaption className={`about-src${aboutLabel(about).length > 48 ? ' is-long' : ''}`}>{aboutLabel(about)}</figcaption>
      <blockquote cite={about.url ?? undefined}><Highlight text={aboutQuote(about)} terms={terms} /></blockquote>
      {about.later ? (
        <>
          <p className="about-src about-later-src">{laterLabel(about.later)}</p>
          <blockquote cite={about.url ?? undefined} className="as-set"><Highlight text={`${about.later.text}${about.later.cut ? ' …' : ''}`} terms={terms} /></blockquote>
        </>
      ) : null}
      <p className="about-foot">
        Quoted, not summarised{about.url ? <>: read it at <Ext href={about.url}>{sourceName(about)}</Ext></> : null}.{' '}
        <A to={buildHash(['sources'], { section: 'rules' })}>Rule {about.ruleId}</A> says how the passage is chosen.
      </p>
    </figure>
  );
}
