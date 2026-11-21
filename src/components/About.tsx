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
    case 'opinion': return about.date ? `Opening of the opinion of ${formatDate(about.date)}` : 'Opening of the opinion';
  }
}

/** Where the quoted text can be read, named for a link. */
function sourceName(about: AboutText): string {
  switch (about.source) {
    case 'crs-summary':
    case 'official-title': return 'Congress.gov';
    case 'digest': return 'California Legislative Information';
    case 'question-presented': return 'the Court’s document';
    case 'cited-passage': return 'the document';
    case 'docket-entry': return 'the docket';
    case 'opinion': return 'the opinion on GovInfo';
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

/** True when one of the terms stands in the text, compared without letter case. */
export function holdsTerm(text: string | null | undefined, terms: readonly string[]): boolean {
  const lower = (text ?? '').toLowerCase();
  return terms.some((term) => term.trim() !== '' && lower.includes(term.trim().toLowerCase()));
}

/**
 * Text with the words a selection rule matched marked in it. The mark shows the reader why the record is listed; it
 * changes no word. Longer terms are tried first, so "voter registration" is marked whole and not only "voter".
 */
export function Highlight({ text, terms }: { text: string; terms?: readonly string[] }): ReactNode {
  const wanted = [...new Set((terms ?? []).map((term) => term.trim()).filter((term) => term.length >= 3))].sort((a, b) => b.length - a.length);
  if (wanted.length === 0) return text;
  const pattern = new RegExp(`(${wanted.map(escapeRegExp).join('|')})`, 'gi');
  const parts = text.split(pattern);
  if (parts.length === 1) return text;
  // split() with one capturing group puts the matches at the odd positions.
  return <>{parts.map((part, index) => (index % 2 === 1 ? <mark key={index} className="hit">{part}</mark> : <Fragment key={index}>{part}</Fragment>))}</>;
}

/** The quotation in a row of a list: the kind of text above it, then its words. */
export function AboutLine({ about, terms }: { about: AboutText | null | undefined; terms?: readonly string[] }) {
  if (!about) return null;
  const label = aboutLabel(about);
  return (
    <p className="row-about">
      {/* A long label names a document and whose words it holds: it is set as a sentence, not as a heading. */}
      <span className={`row-about-src${label.length > 48 ? ' is-long' : ''}`}>{label}</span>
      <q cite={about.url ?? undefined}><Highlight text={aboutQuote(about)} terms={terms} /></q>
    </p>
  );
}

/** The quotation at the head of a record's page, with the link to the text it is from and the rule that took it. */
export function AboutBlock({ about, terms, type }: { about: AboutText | null | undefined; terms?: readonly string[]; type: 'case' | 'bill' }) {
  if (!about) return null;
  return (
    <figure className={`about-block about-${type}`}>
      <figcaption className={`about-src${aboutLabel(about).length > 48 ? ' is-long' : ''}`}>{aboutLabel(about)}</figcaption>
      <blockquote cite={about.url ?? undefined}><Highlight text={aboutQuote(about)} terms={terms} /></blockquote>
      <p className="about-foot">
        Quoted, not summarised{about.url ? <>: read it at <Ext href={about.url}>{sourceName(about)}</Ext></> : null}.{' '}
        <A to={buildHash(['sources'], { section: 'rules' })}>Rule {about.ruleId}</A> says how the passage is chosen.
      </p>
    </figure>
  );
}
