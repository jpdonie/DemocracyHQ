// @vitest-environment jsdom
/**
 * What a row says a record is about: a quotation from an official text, the label of that text, and the words a
 * selection rule matched, marked where they stand. Synthetic records only (see fixtures.ts).
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AboutBlock, AboutLine, Highlight, aboutLabel, aboutQuote, holdsTerm, laterLabel, sourceName } from '../../src/components/About';
import { BillRow, excerptAround, matchedElsewhere, termsInQuotation } from '../../src/features/legislation/BillDirectory';
import { CaseRow } from '../../src/features/litigation/CaseDirectory';
import { AboutTextSchema, LegalCaseSummarySchema, LegislativeInstrumentSummarySchema, type AboutText } from '../../src/types/schemas';
import { SYNTHETIC_HOST, makeAppealsCase, makeBill, makeCase, makeFederalBill } from './fixtures';

afterEach(cleanup);

const LABELS = new Map([['mail-voting', 'Mail and absentee voting'], ['redistricting', 'Redistricting']]);

/** The one row a test rendered. Its tags are list items too, so the row is found by its class. */
function theRow(): HTMLElement {
  const rows = document.querySelectorAll<HTMLElement>('li.row');
  expect(rows.length).toBe(1);
  return rows[0]!;
}

function about(overrides: Partial<AboutText> = {}): AboutText {
  return {
    text: 'This bill requires each state to offer synthetic voter registration at every licensing office.',
    source: 'crs-summary', url: `${SYNTHETIC_HOST}/bill/22`, date: '2025-01-03', cut: false, of: null, document: null, ruleId: 'about-crs-1',
    ...overrides,
  };
}

describe('the label says which official text is quoted', () => {
  it('names each kind of text', () => {
    expect(aboutLabel(about())).toBe('Congressional Research Service summary');
    expect(aboutLabel(about({ source: 'official-title' }))).toBe('Official title');
    expect(aboutLabel(about({ source: 'digest' }))).toBe('Legislative Counsel’s Digest');
    expect(aboutLabel(about({ source: 'question-presented' }))).toBe('Question presented');
    expect(aboutLabel(about({ source: 'question-presented', of: 3 }))).toBe('Question presented (first of 3)');
    expect(aboutLabel(about({ source: 'docket-entry' }))).toBe('Entry that opens the docket');
    expect(aboutLabel(about({ source: 'opinion', date: '2026-10-26' }))).toBe('Opening of the opinion of Oct 26, 2026');
    expect(aboutLabel(about({ source: 'opinion', date: null }))).toBe('Opening of the opinion');
  });

  it('says which paragraph of an opinion is quoted where its first could not be', () => {
    expect(aboutLabel(about({ source: 'opinion', date: '2026-10-26', paragraph: 2 }))).toBe('Paragraph 2 of the opinion of Oct 26, 2026');
    expect(aboutLabel(about({ source: 'opinion', date: null, paragraph: 3 }))).toBe('Paragraph 3 of the opinion');
    expect(aboutLabel(about({ source: 'opinion', date: '2026-10-26', paragraph: null }))).toBe('Opening of the opinion of Oct 26, 2026');
  });

  it('says whose words a passage cited from a filing is', () => {
    const document = 'the filing that opened this docket, written by the party seeking relief (not a ruling)';
    expect(aboutLabel(about({ source: 'cited-passage', document }))).toBe(`From ${document}`);
    expect(aboutLabel(about({ source: 'cited-passage', document: null }))).toBe('From a document of this docket');
  });
});

describe('the quotation is shown as it stands', () => {
  it('adds nothing to a whole passage', () => {
    expect(aboutQuote(about())).toBe(about().text);
  });

  it('marks with an ellipsis where it begins or stops inside a sentence', () => {
    expect(aboutQuote(about({ text: 'Whether a county may reject a ballot that arrives late and', cut: true }))).toBe('Whether a county may reject a ballot that arrives late and …');
    expect(aboutQuote(about({ text: 'preclude the State from using the district boundaries enacted in 2025', cut: true })))
      .toBe('… preclude the State from using the district boundaries enacted in 2025 …');
  });
});

describe('the words a selection rule matched are marked, and no word is changed', () => {
  it('marks every occurrence without regard to letter case and keeps the text', () => {
    const { container } = render(<p><Highlight text="Voter registration by mail, and voter Registration in person." terms={['voter registration']} /></p>);
    expect(container.textContent).toBe('Voter registration by mail, and voter Registration in person.');
    expect([...container.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual(['Voter registration', 'voter Registration']);
  });

  it('marks the longer of two terms that overlap', () => {
    const { container } = render(<p><Highlight text="The voter registration deadline." terms={['voter', 'voter registration']} /></p>);
    expect([...container.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual(['voter registration']);
  });

  it('marks a term only where it stands as whole words, the way the rules count it', () => {
    const { container } = render(
      <p><Highlight text="Mail-ins and mail-in ballots: the electors of an election; voter rolls, a voter roll." terms={['mail-in', 'elect', 'voter roll', 'voter']} /></p>,
    );
    // "Mail-ins", "electors" and "election" hold a term inside a longer word. In "voter rolls" only "voter" is whole.
    expect([...container.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual(['mail-in', 'voter', 'voter roll']);
    expect(container.textContent).toBe('Mail-ins and mail-in ballots: the electors of an election; voter rolls, a voter roll.');
    expect(holdsTerm('The mailing of ballots', ['mail'])).toBe(false);
    expect(holdsTerm('Ballots sent by mail.', ['mail'])).toBe(true);
    expect(holdsTerm('Señor Peña’s vote', ['pe'])).toBe(false);
  });

  it('treats a term as words, not as a pattern, and marks nothing for no term', () => {
    const { container } = render(<p><Highlight text="Section 2 (a) of the Act (b)." terms={['(a)', '.*']} /><Highlight text=" Nothing here." terms={[]} /></p>);
    expect([...container.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual(['(a)']);
    expect(holdsTerm('Safeguard American Voter Eligibility Act', ['voter eligibility'])).toBe(true);
    expect(holdsTerm('Veterans Accessibility Advisory Committee Act', ['voter eligibility'])).toBe(false);
    expect(holdsTerm(null, ['voter'])).toBe(false);
  });
});

describe('a measure listed under a title that does not say why it is listed', () => {
  const veterans = makeFederalBill({
    subject: 'Synthetic Veterans Advisory Committee Act',
    title: 'A bill to establish a synthetic advisory committee, and for other purposes.',
    selection: { ruleId: 'us-select-1', test: 'named', matchedText: 'Voter Eligibility', matchedField: 'Short Title(s) from Engrossed Amendment House bill text', matchedTitle: 'Synthetic Voter Eligibility Act' },
    about: about({ text: 'This bill requires synthetic proof of citizenship when registering to vote in federal elections.' }),
  });

  it('names the title the rule matched when neither the shown title nor the quotation holds the matched words', () => {
    expect(matchedElsewhere(veterans)).toEqual({ title: 'Synthetic Voter Eligibility Act', field: 'Short Title(s) from Engrossed Amendment House bill text', words: 'Voter Eligibility' });
    render(<ul><BillRow bill={veterans} labels={LABELS} /></ul>);
    const row = theRow();
    // The title is a quotation (a <q>, which the browser sets in quotation marks), followed by where the record gives it.
    expect(row.querySelector('.row-why')?.textContent).toBe('Also titled Synthetic Voter Eligibility Act (Short Title(s) from Engrossed Amendment House bill text)');
    expect(row.querySelector('.row-why q')?.textContent).toBe('Synthetic Voter Eligibility Act');
    expect(within(row).getByText('Voter Eligibility').tagName).toBe('MARK');
    // The quotation follows, under the name of the text it is from.
    expect(within(row).getByText('Congressional Research Service summary')).toBeTruthy();
    expect(row.querySelector('.row-about q')?.textContent).toBe('This bill requires synthetic proof of citizenship when registering to vote in federal elections.');
  });

  it('still names the matched title when the summary happens to use the same words, and marks nothing in the summary', () => {
    // The selection rule reads the titles of a measure. It never read the summary, so the summary shows no reason.
    const bill = makeFederalBill({ ...veterans, about: about({ text: 'This bill sets synthetic rules on voter eligibility for federal elections in every state.' }) });
    expect(termsInQuotation(bill)).toEqual([]);
    expect(matchedElsewhere(bill)?.title).toBe('Synthetic Voter Eligibility Act');
    render(<ul><BillRow bill={bill} labels={LABELS} /></ul>);
    const row = theRow();
    expect(row.querySelector('.row-why')?.textContent).toContain('Also titled Synthetic Voter Eligibility Act');
    expect(row.querySelector('.row-about mark')).toBeNull();
    expect(row.querySelector('.row-why mark')?.textContent).toBe('Voter Eligibility');
  });

  it('marks the matched words in an official title that is quoted, because the rule reads titles', () => {
    const bill = makeFederalBill({ ...veterans, about: about({ source: 'official-title', ruleId: 'about-title-1', text: 'To require synthetic proof of voter eligibility, and for other purposes.' }) });
    expect(termsInQuotation(bill)).toEqual(['Voter Eligibility']);
    render(<ul><BillRow bill={bill} labels={LABELS} /></ul>);
    expect(theRow().querySelector('.row-about q mark')?.textContent).toBe('voter eligibility');
    expect(theRow().querySelector('.row-why')).toBeNull();
  });

  it('does not repeat a title whose matched words the row already shows', () => {
    const plain = makeFederalBill({ subject: 'Synthetic Voter Eligibility Act', selection: { ...veterans.selection!, matchedField: 'Display title' }, about: veterans.about });
    expect(matchedElsewhere(plain)).toBeNull();
    const inQuote = makeFederalBill({ ...veterans, about: about({ source: 'official-title', text: 'To require synthetic proof of voter eligibility, and for other purposes.' }) });
    expect(matchedElsewhere(inQuote)).toBeNull();
    render(<ul><BillRow bill={plain} labels={LABELS} /></ul>);
    expect(theRow().textContent).not.toContain('Also titled');
    expect(screen.getByRole('link', { name: /Synthetic Voter Eligibility Act/ }).querySelector('mark')?.textContent).toBe('Voter Eligibility');
  });

  it('shortens a long matched title around the matched words and says so with an ellipsis', () => {
    const long = `To amend the synthetic code ${'and to make further provision for many other things '.repeat(4)}and to protect voter eligibility in every election, ${'with a great many conforming changes '.repeat(4)}and for other purposes.`;
    const short = excerptAround(long, 'voter eligibility', 120);
    expect(short.length).toBeLessThanOrEqual(124);
    expect(short.startsWith('… ') && short.endsWith(' …') && short.includes('voter eligibility')).toBe(true);
    expect(long).toContain(short.slice(2, -2));
    expect(excerptAround('A short title.', 'title', 120)).toBe('A short title.');
    expect(excerptAround(long, 'To amend', 60)).toBe('To amend the synthetic code and to make further provision …');
  });

  it('shows a California bill with what it would do, in the words of its digest', () => {
    const bill = makeBill({ about: about({ source: 'digest', ruleId: 'about-digest-1', date: null, text: 'This bill would require a synthetic ballot to be counted if it is postmarked by election day.' }) });
    render(<ul><BillRow bill={bill} labels={LABELS} /></ul>);
    const row = theRow();
    expect(within(row).getByText('Legislative Counsel’s Digest')).toBeTruthy();
    expect(row.querySelector('.row-about q')?.textContent).toMatch(/^This bill would require a synthetic ballot/);
    expect(within(row).getByRole('link', { name: 'Mail and absentee voting' })).toBeTruthy();
  });

  it('shows a measure without a quotation as before, with no empty line', () => {
    render(<ul><BillRow bill={makeBill()} labels={LABELS} /></ul>);
    expect(theRow().querySelector('.row-about')).toBeNull();
  });
});

describe('a case row says what the case is about before it says what happened last', () => {
  it('quotes the opening of the opinion and names the phrases the selection rule found', () => {
    const record = makeAppealsCase({
      natureOfSuit: 'Civil Rights Voting',
      about: about({ source: 'opinion', ruleId: 'about-opinion-1', date: '2026-03-10', url: `${SYNTHETIC_HOST}/opinion.pdf`,
        text: 'The Synthetic Voters League appeals the dismissal of its challenge to the county’s rule on late absentee ballots.' }),
      matchedTerms: [{ term: 'absentee ballots', count: 12 }, { term: 'board of elections', count: 3 }],
    });
    render(<ul><CaseRow record={record} labels={LABELS} /></ul>);
    const row = theRow();
    expect(within(row).getByText('Opening of the opinion of Mar 10, 2026')).toBeTruthy();
    expect(row.querySelector('.row-about q mark')?.textContent).toBe('absentee ballots');
    expect(row.querySelector('.row-why')?.textContent).toBe('Nature of suit in the court’s record: Civil Rights Voting. In the opinion: “absentee ballots” 12×, “board of elections” 3×');
    // The quotation stands above the latest ruling.
    const quote = row.querySelector('.row-about')!;
    const ruling = row.querySelector('.row-line')!;
    expect(quote.compareDocumentPosition(ruling) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('quotes the question presented for a Supreme Court docket and gives no count of phrases', () => {
    const record = makeCase({ about: about({ source: 'question-presented', ruleId: 'about-question-1', date: null, of: 2, text: 'Whether the synthetic plan violates Section 2 of the Voting Rights Act.' }) });
    render(<ul><CaseRow record={record} labels={LABELS} /></ul>);
    const row = theRow();
    expect(within(row).getByText('Question presented (first of 2)')).toBeTruthy();
    expect(row.querySelector('.row-why')).toBeNull();
  });

  it('shows a further question of the Court after the question presented, as the Court set it', () => {
    const later = { text: 'WHETHER THE STATE’S INTENTIONAL CREATION OF A SECOND SYNTHETIC DISTRICT VIOLATES THE FOURTEENTH AMENDMENT.', date: '2025-08-01', cut: false };
    const record = makeCase({ about: about({ source: 'question-presented', ruleId: 'about-question-1', date: null, of: 4, text: 'Did the majority err in finding that race predominated in the synthetic plan?', later }) });
    render(<ul><CaseRow record={record} labels={LABELS} /></ul>);
    const row = theRow();
    const lines = [...row.querySelectorAll('.row-about')];
    expect(lines.map((line) => line.querySelector('.row-about-src')?.textContent)).toEqual(['Question presented (first of 4)', 'Further question from the Court, order of Aug 1, 2025']);
    expect(lines[1]!.querySelector('q')?.textContent).toBe(later.text);
    expect(laterLabel({ ...later, date: null })).toBe('Further question from the Court');
    expect(LegalCaseSummarySchema.parse(record).about?.later?.date).toBe('2025-08-01');
  });

  it('shows a case without a quotation with the nature of suit alone', () => {
    render(<ul><CaseRow record={makeAppealsCase({ natureOfSuit: 'Civil Rights Voting', about: null, matchedTerms: [] })} labels={LABELS} /></ul>);
    const row = theRow();
    expect(row.querySelector('.row-about')).toBeNull();
    expect(row.querySelector('.row-why')?.textContent).toBe('Nature of suit in the court’s record: Civil Rights Voting');
  });
});

describe('the head of a record page', () => {
  it('shows the quotation with a link to the text and to the rule that chose it', () => {
    render(<AboutBlock about={about({ source: 'opinion', ruleId: 'about-opinion-1', url: `${SYNTHETIC_HOST}/opinion.pdf` })} type="case" />);
    expect(screen.getByRole('link', { name: /the opinion on GovInfo/ }).getAttribute('href')).toBe(`${SYNTHETIC_HOST}/opinion.pdf`);
    expect(screen.getByRole('link', { name: 'Rule about-opinion-1' }).getAttribute('href')).toBe('#/sources?section=rules');
    expect(screen.getByText(/Quoted, not summarised/)).toBeTruthy();
  });

  it('names the site the quoted text is on by its address', () => {
    expect(sourceName(about({ source: 'opinion', ruleId: 'about-opinion-1', url: 'https://storage.courtlistener.com/pdf/2026/01/02/synthetic.pdf' }))).toBe('the decision on CourtListener');
    expect(sourceName(about({ source: 'opinion', ruleId: 'about-opinion-1', url: 'https://www.govinfo.gov/content/pkg/synthetic.pdf' }))).toBe('the opinion on GovInfo');
    expect(sourceName(about({ source: 'official-title', ruleId: 'about-title-1', url: 'https://www.congress.gov/bill/119th-congress/house-bill/1' }))).toBe('Congress.gov');
    expect(sourceName(about({ source: 'official-title', ruleId: 'about-title-1', url: 'https://legislature.example.test/bill/1' }))).toBe('the legislature’s page');
  });

  it('repeats a further question of the Court under the question presented', () => {
    const later = { text: 'WHETHER THE STATE’S INTENTIONAL CREATION OF A SECOND SYNTHETIC DISTRICT VIOLATES THE FOURTEENTH AMENDMENT.', date: '2025-08-01', cut: false };
    const { container } = render(<AboutBlock about={about({ source: 'question-presented', ruleId: 'about-question-1', of: 4, later })} type="case" />);
    expect([...container.querySelectorAll('blockquote')].map((quote) => quote.textContent)).toEqual([about().text, later.text]);
    expect(screen.getByText('Further question from the Court, order of Aug 1, 2025')).toBeTruthy();
    expect(container.querySelectorAll('figcaption').length).toBe(1);
  });

  it('renders nothing for a record without a quotation', () => {
    const { container } = render(<><AboutBlock about={null} type="bill" /><AboutLine about={undefined} /></>);
    expect(container.innerHTML).toBe('');
  });
});

describe('the schemas hold a quotation to its form', () => {
  it('accepts the sources the rules know and refuses others', () => {
    expect(AboutTextSchema.safeParse(about()).success).toBe(true);
    expect(AboutTextSchema.safeParse({ ...about(), source: 'ai-summary' }).success).toBe(false);
    expect(AboutTextSchema.safeParse({ ...about(), text: 'Too short.' }).success).toBe(false);
    expect(AboutTextSchema.safeParse({ ...about(), url: 'http://example.test/plain' }).success).toBe(false);
    expect(AboutTextSchema.safeParse({ ...about(), ruleId: undefined }).success).toBe(false);
    expect(AboutTextSchema.safeParse({ ...about(), paragraph: 1 }).success).toBe(false);
    expect(AboutTextSchema.safeParse({ ...about(), paragraph: 2, later: null }).success).toBe(true);
    expect(AboutTextSchema.safeParse({ ...about(), later: { text: 'Too short.' } }).success).toBe(false);
  });

  it('keeps the quotation and the matched words on the index entries', () => {
    const bill = LegislativeInstrumentSummarySchema.parse(makeFederalBill({ about: about(), selection: { ruleId: 'us-select-1', matchedText: 'Voter', matchedField: 'Display title' } }));
    expect(bill.about?.source).toBe('crs-summary');
    expect(bill.selection?.matchedText).toBe('Voter');
    const record = LegalCaseSummarySchema.parse(makeAppealsCase({ about: null, matchedTerms: [{ term: 'ballot access', count: 2 }] }));
    expect(record.about).toBeNull();
    expect(record.matchedTerms).toEqual([{ term: 'ballot access', count: 2 }]);
    // Records published before the rule existed carry neither, and are still read.
    expect(LegalCaseSummarySchema.parse(makeCase()).matchedTerms).toBeUndefined();
  });
});
