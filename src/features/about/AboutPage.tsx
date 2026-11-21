import { useEffect } from 'react';
import { APP_NAME, POSITIONING, REPO_URL, correctionUrl } from '../../config';
import { embedCode } from '../../lib/embed';
import { buildHash, type Route } from '../../lib/router';
import { A, Ext, Section, TypeMark } from '../../components/ui';

export function AboutPage({ route }: { route: Route }) {
  const section = route.query.section;
  useEffect(() => {
    if (section) document.getElementById(section)?.scrollIntoView({ block: 'start' });
  }, [section]);
  const issue = correctionUrl('General correction', typeof window === 'undefined' ? '' : window.location.href);
  return (
    <article className="view view-wide view-doc">
      <header className="view-head">
        <TypeMark type="data" label="About" />
        <h1 tabIndex={-1}>About {APP_NAME}</h1>
        <p className="lede">{POSITIONING}</p>
      </header>

      <Section title="What this is">
        <p>{APP_NAME} is a free, open-source research tool that puts three kinds of public record on one map: court records in election cases, election bills with their text versions, and the official boundaries those cases and bills are about. Every record links to the official page it came from, published by a court, a legislature, the Government Publishing Office or the Census Bureau, and says when it was last checked.</p>
        <p>It is built for people who need to get to a primary source quickly: lawyers and legal researchers, reporters, academics, students, election officials and interested members of the public. Naming these audiences describes who the tool is meant to serve. It does not mean any organisation uses, endorses or is affiliated with it.</p>
      </Section>

      <Section title="What this is not" id="disclaimer">
        <ul className="plain-list spaced">
          <li><strong>Not legal advice.</strong> Nothing here is a substitute for a lawyer or for reading the source documents.</li>
          <li><strong>Not an official source.</strong> {APP_NAME} is not operated by any court, legislature or election office. The official record always controls.</li>
          <li><strong>Not complete.</strong> Coverage is deliberately narrow and is set out in full under <A to={buildHash(['sources'], { section: 'coverage' })}>Data and methodology</A>. A data gap is not evidence of absence.</li>
          <li><strong>Not voting guidance.</strong> It does not tell anyone whether, where or how they can vote. Ask your state or local election office.</li>
          <li><strong>Not predictive.</strong> It does not forecast outcomes and does not say whether a map or a law is lawful.</li>
        </ul>
      </Section>

      <Section title="Neutrality">
        <p>The same rules apply to every record, whichever party or interest benefits. Records are described in the words of the source: docket entries and court records are quoted, and a bill carries its official titles, subject line and summary. Where {APP_NAME} adds something of its own, such as an issue tag or a link between a case and a place, the rule or the supporting passage is shown next to it. Map colours avoid red and blue, with one exception: where the site shows which party holds a governor&rsquo;s office or a chamber, red and blue stand for the two parties and for nothing else, and every part also names its party in words. Those figures are the members a source lists today. They are not an election result and not a forecast.</p>
      </Section>

      <Section title="Corrections" id="corrections">
        <p>Corrections are welcome and are handled in public through GitHub Issues. Please include the page link, what is wrong, and a primary source that shows the correct information.</p>
        {issue
          ? <p><Ext href={issue}>Open a correction on GitHub</Ext></p>
          : <p>This copy of the site was built without a repository address, so it cannot link straight to the issue tracker. If you are running it yourself, set <span className="hash">VITE_REPO_URL</span> at build time; the published site links to its own repository automatically.</p>}
      </Section>

      <Section title="Embedding" id="embed">
        <p>Any view of {APP_NAME} can be shown inside another page. Put <span className="hash">?embed=1</span> before the <span className="hash">#</span> of its address. The embedded form keeps the map, the records and their sources, and adds a link that opens the same view here in a new tab. This is the overview:</p>
        <pre className="snippet"><code>{embedCode(buildHash([]), APP_NAME)}</code></pre>
        <p className="quiet">For a state, a case or a measure, open it here and copy the part of its address after the <span className="hash">#</span> into the snippet. An embedded view is the same site with the same data. It sets no cookies and loads nothing from third parties.</p>
      </Section>

      <Section title="Privacy">
        <p>The site is a set of static files. It has no accounts, no analytics, no advertising and no cookies, and it loads nothing from third-party servers: fonts, map glyphs and boundary data are served with the site. Your watchlist is stored only in this browser. {APP_NAME} holds no voter files and no data about individual voters.</p>
      </Section>

      <Section title="About the mark" id="mark">
        <figure className="motif">
          <img src={`${import.meta.env.BASE_URL}brand/motif.svg`} alt="" width={900} height={640} loading="lazy" />
          <figcaption>
            The mark and this drawing are frames of one generative study: rows of lines that start as noise and settle until none of them cross, with hatching wherever a stretch is left unrecorded. It is a decoration made by an algorithm. It is not a map and shows no real place, boundary or data.
          </figcaption>
        </figure>
      </Section>

      <Section title="Source code and licence" id="source">
        <p>The code is open source under the Apache License 2.0. That licence covers the code, the documentation and the design files written for this project. It does not cover the upstream data the pipeline retrieves and publishes: those records belong to, or are published by, their sources and are reused under the terms listed for each source in <A to={buildHash(['sources'])}>Data and methodology</A>.</p>
        {REPO_URL ? <p><Ext href={REPO_URL}>Repository on GitHub</Ext></p> : <p className="quiet">The repository address is added when the site is published.</p>}
        <p>Built with public data from the U.S. Census Bureau, the Supreme Court of the United States, the U.S. Government Publishing Office (GovInfo), the California Legislative Counsel, Open States (Plural Policy) and CourtListener (Free Law Project), and with the open-source projects MapLibre GL JS, React, Mapshaper, and the Archivo, Newsreader and Noto Sans typefaces. Their licence notices ship with the site: <a href="third-party-licenses.md">third-party licences</a> (code bundled into the site) and <a href="fonts/README.md">font licences</a>.</p>
      </Section>
    </article>
  );
}
