#!/usr/bin/env node
/**
 * Validates everything under public/data against the same zod schemas the app
 * uses at runtime, then checks the things a schema cannot see: references
 * between files, counts, hashes, and arithmetic on the Census tables. It also
 * lists the whole folder and fails on any file that none of these checks read:
 * the site serves public/data as it is, so nothing else may be there.
 *
 *   node scripts/validate-data.mjs            human-readable report, exit 1 on any error
 *   node scripts/validate-data.mjs --json     the same result as JSON on stdout
 *
 * The schemas are TypeScript, so they are loaded through Vite's module runner
 * instead of being duplicated here.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, 'public', 'data');
const asJson = process.argv.includes('--json');

const errors = [];
const warnings = [];
const checks = [];
const fail = (message) => errors.push(message);
const warn = (message) => warnings.push(message);
const pass = (name, detail) => checks.push({ name, detail });

/** A data file's path inside public/data: folders in a-z, 0-9, "_" and "-", then a .json file name. */
const DATA_FILE = /^([a-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.json$/;
/** Every file the checks read (or looked for); section 7 refuses any other file under public/data. */
const referenced = new Set();

function read(rel) {
  if (typeof rel !== 'string' || !DATA_FILE.test(rel) || rel.split('/').some((part) => part === '.' || part === '..')) {
    fail(`${rel}: a data file refers to this path, which is not a .json file inside public/data`);
    return null;
  }
  referenced.add(rel);
  const path = join(dataDir, rel);
  if (!existsSync(path)) {
    fail(`${rel}: file is missing`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${rel}: not valid JSON (${error.message})`);
    return null;
  }
}

function parse(schema, rel, value) {
  if (value === null) return null;
  const result = schema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues.slice(0, 3).map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    fail(`${rel}: does not match its schema (${result.error.issues.length} issue(s); ${first})`);
    return null;
  }
  return result.data;
}

const server = await createServer({ root, logLevel: 'error', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true } });
let S, geoLib;
try {
  S = await server.ssrLoadModule('/src/types/schemas.ts');
  geoLib = await server.ssrLoadModule('/src/lib/geo.ts');
} finally {
  await server.close();
}

/* ---------- 1. every file matches its schema ---------- */
const manifest = parse(S.ManifestSchema, 'manifest.json', read('manifest.json'));
const sources = parse(S.SourcesFileSchema, 'sources.json', read('sources.json'));
const classification = parse(S.ClassificationFileSchema, 'classification.json', read('classification.json'));
const courts = parse(S.CourtsFileSchema, 'courts.json', read('courts.json'));
const redistricting = parse(S.RedistrictingFileSchema, 'redistricting.json', read('redistricting.json'));
const relationships = parse(S.RelationshipFileSchema, 'relationships.json', read('relationships.json'));
const events = parse(S.EventsFileSchema, 'events.json', read('events.json'));
const geoIndex = parse(S.GeoIndexSchema, 'geo/index.json', read('geo/index.json'));
const countyCd = parse(S.CountyCdSchema, 'geo/county_cd119.json', read('geo/county_cd119.json'));
const caseIndex = parse(S.CaseIndexSchema, 'litigation/index.json', read('litigation/index.json'));
const billIndex = parse(S.BillIndexSchema, 'legislation/index.json', read('legislation/index.json'));
const population = {};
for (const dataset of ['state', 'county', 'cd119']) {
  population[dataset] = parse(S.PopulationFileSchema, `population/${dataset}.json`, read(`population/${dataset}.json`));
}

const cases = new Map();
for (const summary of caseIndex?.cases ?? []) {
  const rel = `litigation/cases/${summary.id}.json`;
  const record = parse(S.LegalCaseSchema, rel, read(rel));
  if (record) cases.set(record.id, record);
}
const bills = new Map();
let textFiles = 0;
let hashedTexts = 0;
for (const summary of billIndex?.bills ?? []) {
  const rel = `legislation/bills/${summary.id}.json`;
  const record = parse(S.LegislativeInstrumentSchema, rel, read(rel));
  if (!record) continue;
  bills.set(record.id, record);
  for (const version of record.versions) {
    if (version.textAvailability !== 'mirrored') continue;
    if (!version.textPath) {
      fail(`${rel}: version ${version.id} is marked mirrored but has no textPath`);
      continue;
    }
    const text = parse(S.VersionTextSchema, version.textPath, read(version.textPath));
    if (!text) continue;
    textFiles += 1;
    const digest = createHash('sha256').update(text.blocks.map((block) => block[1]).join('\n'), 'utf8').digest('hex');
    if (version.textHash && digest !== version.textHash) fail(`${version.textPath}: text does not match the hash recorded on ${record.identifier} (${version.label})`);
    else if (version.textHash) hashedTexts += 1;
    if (text.instrumentId !== record.id) fail(`${version.textPath}: belongs to ${text.instrumentId}, but is listed under ${record.id}`);
  }
}
// Optional files written only when an API credential is configured. The site does not display
// them yet; they are still held to the same schemas so a bad import can never be published.
for (const [rel, key, schema] of [
  ['litigation_secondary.json', 'cases', S.LegalCaseSummarySchema],
  ['legislation_secondary.json', 'bills', S.LegislativeInstrumentSummarySchema],
]) {
  if (!existsSync(join(dataDir, rel))) continue;
  const file = read(rel);
  const rows = Array.isArray(file?.[key]) ? file[key] : null;
  if (!rows) {
    fail(`${rel}: expected a "${key}" list`);
    continue;
  }
  rows.forEach((row, i) => {
    const record = parse(schema, `${rel} [${i}]`, row);
    if (record && record.verification.status !== 'imported_secondary') fail(`${rel} [${i}]: a secondary import must be labelled imported_secondary, not ${record.verification.status}`);
  });
  warn(`${rel}: ${rows.length} record(s) imported from a secondary source are present; the site does not display them yet`);
}
if (errors.length === 0) pass('Schemas', `every published file matches its runtime schema (${cases.size} cases, ${bills.size} bills, ${textFiles} text versions)`);
if (textFiles > 0 && hashedTexts === textFiles) pass('Text hashes', `${hashedTexts} mirrored text versions hash to the value recorded on their bill`);

/* ---------- 2. files on disk that nothing lists: section 7, once every file above and below has been read ---------- */

/* ---------- 3. geography ---------- */
const geoKeys = new Set();
if (geoIndex) {
  const perLayer = Object.fromEntries(S.LAYERS.map((layer) => [layer, 0]));
  for (const row of geoIndex.rows) {
    const key = row[0];
    if (geoKeys.has(key)) fail(`geo/index.json: duplicate key ${key}`);
    geoKeys.add(key);
    const parsed = geoLib.parseGeoKey(key);
    if (!parsed) {
      fail(`geo/index.json: malformed key ${key}`);
      continue;
    }
    perLayer[parsed.layer] += 1;
    if (!parsed.geoid.startsWith(row[2])) fail(`geo/index.json: ${key} lists state ${row[2]}, which is not the start of its GEOID`);
    if (!(row[3] <= row[5] && row[4] <= row[6])) fail(`geo/index.json: ${key} has an inverted bounding box`);
    if (!geoLib.STATE_ABBR[row[2]]) fail(`geo/index.json: state FIPS ${row[2]} has no postal abbreviation in src/lib/geo.ts`);
  }
  for (const layer of S.LAYERS) {
    const info = geoIndex.layers[layer];
    if (info.featureCount !== perLayer[layer]) fail(`geo/index.json: layer ${layer} declares ${info.featureCount} features but lists ${perLayer[layer]}`);
    const topo = read(info.file);
    const geometries = topo?.objects?.[info.object]?.geometries;
    if (!geometries) {
      fail(`${info.file}: object "${info.object}" not found`);
      continue;
    }
    const ids = new Set(geometries.map((g) => g.properties?.GEOID));
    if (ids.size !== geometries.length) fail(`${info.file}: duplicate or missing GEOID`);
    if (geometries.length !== info.featureCount) fail(`${info.file}: has ${geometries.length} features, the index says ${info.featureCount}`);
    for (const id of ids) if (!geoKeys.has(`${layer}:${id}`)) fail(`${info.file}: ${id} is drawn but is not in the index`);
    if (layer === 'state') {
      for (const g of geometries) {
        const expected = geoLib.STATE_ABBR[g.properties.GEOID];
        if (expected !== g.properties.STUSPS) fail(`src/lib/geo.ts: abbreviation for ${g.properties.GEOID} is ${expected}, the Census file says ${g.properties.STUSPS}`);
      }
    }
    if (!sources?.sources.some((s) => s.id === info.sourceId)) fail(`geo/index.json: layer ${layer} cites unknown source ${info.sourceId}`);
  }
  pass('Geography', `${geoKeys.size} units, every GEOID unique, every drawn unit indexed, state abbreviations match the Census file`);
}
if (countyCd && geoIndex) {
  let bad = 0;
  for (const [county, district] of countyCd.pairs) if (!geoKeys.has(`county:${county}`) || !geoKeys.has(`cd119:${district}`)) bad += 1;
  if (bad > 0) fail(`geo/county_cd119.json: ${bad} pair(s) name a county or district that is not in the index`);
  else pass('County and district pairs', `${countyCd.pairs.length} pairs, all resolve to indexed units`);
}

/* ---------- 4. Census arithmetic ---------- */
const APPORTIONMENT_2020_RESIDENT = 331449281; // 50 states and DC, 2020 Census (P.L. 94-171)
if (population.state && population.county && population.cd119) {
  const totalIndex = (file) => file.variables.findIndex((v) => v.key === 'total');
  const st = population.state, co = population.county, cd = population.cd119;
  const stateTotal = (fips) => st.rows[fips]?.[totalIndex(st)];
  let national = 0;
  for (const [fips, row] of Object.entries(st.rows)) if (fips !== '72') national += row[totalIndex(st)];
  if (national !== APPORTIONMENT_2020_RESIDENT) fail(`population/state.json: the 50 states and DC sum to ${national}, the 2020 Census resident population is ${APPORTIONMENT_2020_RESIDENT}`);
  else pass('National total', `the 50 states and DC sum to ${national.toLocaleString('en-US')}, the published 2020 Census resident population`);

  const sumBy = (file) => {
    const sums = new Map();
    for (const [geoid, row] of Object.entries(file.rows)) sums.set(geoid.slice(0, 2), (sums.get(geoid.slice(0, 2)) ?? 0) + row[totalIndex(file)]);
    return sums;
  };
  let countyOk = 0, districtOk = 0;
  for (const [fips, sum] of sumBy(co)) {
    if (sum === stateTotal(fips)) countyOk += 1;
    else fail(`population/county.json: counties of state ${fips} sum to ${sum}, the state count is ${stateTotal(fips)}`);
  }
  for (const [fips, sum] of sumBy(cd)) {
    if (sum === stateTotal(fips)) districtOk += 1;
    else fail(`population/cd119.json: districts of state ${fips} sum to ${sum}, the state count is ${stateTotal(fips)}`);
  }
  pass('County sums', `in ${countyOk} states the county counts sum exactly to the state count`);
  pass('District sums', `in ${districtOk} states the 119th Congress district counts sum exactly to the state count`);

  for (const [name, file, layer] of [['state', st, 'state'], ['county', co, 'county'], ['cd119', cd, 'cd119']]) {
    let groupsBad = 0, unknown = 0;
    const groupKeys = file.variables.map((v) => v.key).filter((k) => !k.startsWith('vap') && k !== 'total');
    const idx = Object.fromEntries(file.variables.map((v, i) => [v.key, i]));
    for (const [geoid, row] of Object.entries(file.rows)) {
      if (row.length !== file.variables.length) fail(`population/${name}.json: ${geoid} has ${row.length} values for ${file.variables.length} variables`);
      if (groupKeys.reduce((acc, key) => acc + row[idx[key]], 0) !== row[idx.total]) groupsBad += 1;
      if (!geoKeys.has(`${layer}:${geoid}`)) unknown += 1;
    }
    if (groupsBad > 0) fail(`population/${name}.json: in ${groupsBad} unit(s) the race and origin groups do not sum to the total`);
    // Counts for units that no longer exist under current boundaries are legitimate (Connecticut's former counties).
    if (unknown > 0) warn(`population/${name}.json: ${unknown} counted unit(s) have no current boundary and are never displayed`);
  }
  pass('Group sums', 'in every state, county and district the race and origin groups sum exactly to the total');
}

/* ---------- 5. references between records ---------- */
const sourceIds = new Set((sources?.sources ?? []).map((s) => s.id));
const courtIds = new Set((courts?.courts ?? []).map((c) => c.id));
const ruleIds = new Set([
  ...(classification?.issueRules ?? []).map((r) => r.ruleId),
  ...(classification?.docketEntryRules ?? []).map((r) => r.ruleId),
  ...(classification?.legislativeActionRules ?? []).map((r) => r.ruleId),
  ...(classification?.otherRules ?? []).map((r) => r.ruleId),
]);
const exists = (ref) => (ref.type === 'case' ? cases.has(ref.id) : ref.type === 'bill' ? bills.has(ref.id) : geoKeys.has(ref.id));

for (const record of cases.values()) {
  if (!sourceIds.has(record.sourceId)) fail(`case ${record.id}: unknown source ${record.sourceId}`);
  if (!courtIds.has(record.courtId)) fail(`case ${record.id}: unknown court ${record.courtId}`);
  if (!/^https:\/\/www\.supremecourt\.gov\//.test(record.sourceUrl)) fail(`case ${record.id}: sourceUrl is not on supremecourt.gov`);
  if (record.events.length !== record.entryCount) fail(`case ${record.id}: entryCount is ${record.entryCount} but ${record.events.length} entries are stored`);
  for (const tag of record.issueTags) if (!ruleIds.has(tag.ruleId)) fail(`case ${record.id}: tag ${tag.tag} cites unknown rule ${tag.ruleId}`);
  for (const event of record.events) {
    if (event.classificationRule && !ruleIds.has(event.classificationRule)) fail(`case ${record.id}: entry ${event.id} cites unknown rule ${event.classificationRule}`);
    if (!/^https:\/\//.test(event.evidence.url)) fail(`case ${record.id}: entry ${event.id} cites a link that is not https (${event.evidence.url})`);
  }
  // A document with no public link has url null; a link that is given must be https.
  for (const doc of record.documents) if (doc.url != null && !/^https:\/\//.test(doc.url)) fail(`case ${record.id}: document ${doc.id} link is not https (${doc.url})`);
  for (const fips of record.stateFips) if (!geoKeys.has(`state:${fips}`)) fail(`case ${record.id}: unknown state ${fips}`);
}
for (const record of bills.values()) {
  if (!sourceIds.has(record.sourceId)) fail(`bill ${record.id}: unknown source ${record.sourceId}`);
  if (!geoKeys.has(`state:${record.state}`)) fail(`bill ${record.id}: unknown state ${record.state}`);
  if (record.versions.length !== record.versionCount) fail(`bill ${record.id}: versionCount is ${record.versionCount} but ${record.versions.length} versions are stored`);
  for (const tag of record.issueTags) if (!ruleIds.has(tag.ruleId)) fail(`bill ${record.id}: tag ${tag.tag} cites unknown rule ${tag.ruleId}`);
  for (const action of record.actions) if (action.classificationRule && !ruleIds.has(action.classificationRule)) fail(`bill ${record.id}: action cites unknown rule ${action.classificationRule}`);
  if (record.selection && !ruleIds.has(record.selection.ruleId)) fail(`bill ${record.id}: selection cites unknown rule ${record.selection.ruleId}`);
  if (record.chapteredDate && record.vetoedDate) fail(`bill ${record.id}: recorded as both chaptered and vetoed`);
  if (record.effective.date && !record.chapteredDate) fail(`bill ${record.id}: has an effective date but no chaptering date`);
  if (record.effective.date && !['immediate_effect_flag', 'stated_in_text'].includes(record.effective.basis)) fail(`bill ${record.id}: effective date given on basis ${record.effective.basis}`);
  if (['not_enacted', 'not_applicable'].includes(record.effective.basis) && record.chapteredDate && record.effective.basis === 'not_enacted') fail(`bill ${record.id}: chaptered but described as not enacted`);
  const versionIds = new Set(record.versions.map((v) => v.id));
  for (const condition of record.conditions ?? []) {
    if (!versionIds.has(condition.versionId)) fail(`bill ${record.id}: condition quotes unknown version ${condition.versionId}`);
    if (!ruleIds.has(condition.ruleId)) fail(`bill ${record.id}: condition cites unknown rule ${condition.ruleId}`);
  }
  const historyIds = record.actions.map((a) => a.historyId).filter(Boolean);
  if (new Set(historyIds).size !== historyIds.length) fail(`bill ${record.id}: a legislative history id appears twice`);
}
if (relationships) {
  const ids = new Set();
  for (const rel of relationships.relationships) {
    if (ids.has(rel.id)) fail(`relationships.json: duplicate id ${rel.id}`);
    ids.add(rel.id);
    if (!exists(rel.source)) fail(`relationship ${rel.id}: source ${rel.source.type}:${rel.source.id} does not exist`);
    if (!exists(rel.target)) fail(`relationship ${rel.id}: target ${rel.target.type}:${rel.target.id} does not exist`);
    if (rel.ruleId && !ruleIds.has(rel.ruleId)) fail(`relationship ${rel.id}: cites unknown rule ${rel.ruleId}`);
    // A curated link is published only after its passage was found in the cited document.
    if (!(rel.support?.quote && /^https:\/\//.test(rel.support?.url ?? '') && rel.support?.document)) {
      fail(`relationship ${rel.id}: published without its quoted passage, the document it is from and that document's link`);
    }
    if (rel.basis === 'curated' && rel.verification.status !== 'verified_primary') fail(`relationship ${rel.id}: a curated link is published with status ${rel.verification.status}`);
  }
  pass('Relationships', `${relationships.relationships.length} links, every end exists, every link carries its passage, the document it is from and the document's link`);
}
if (events) {
  const ids = new Set();
  for (const event of events.events) {
    if (ids.has(event.id)) fail(`events.json: duplicate id ${event.id}`);
    ids.add(event.id);
    if (!exists({ type: event.entityType, id: event.entityId })) fail(`event ${event.id}: ${event.entityType} ${event.entityId} does not exist`);
    for (const key of event.geoKeys) if (!geoKeys.has(key)) fail(`event ${event.id}: unknown place ${key}`);
    if (event.ruleId && !ruleIds.has(event.ruleId)) fail(`event ${event.id}: cites unknown rule ${event.ruleId}`);
  }
  pass('Timeline events', `${events.events.length} events, every record and place they name exists`);
}
if (redistricting && geoIndex) {
  for (const fips of redistricting.congress120.statesWithNewBoundaries) if (!geoKeys.has(`state:${fips}`)) fail(`redistricting.json: unknown state ${fips}`);
  for (const geoid of redistricting.areaCheck?.mismatches ?? []) warn(`redistricting.json: district ${geoid} failed the land-area check; its population count is withheld`);
  if (redistricting.areaCheck) pass('District area check', `${redistricting.areaCheck.compared} unchanged districts compared, largest land-area difference ${(redistricting.areaCheck.largestRelativeDifference * 100).toFixed(3)}%, ${redistricting.areaCheck.mismatches.length} over tolerance`);
  else warn('redistricting.json: no district area check is recorded');
}

/* ---------- 6. manifest ---------- */
if (manifest) {
  const actual = { cases: cases.size, bills: bills.size, relationships: relationships?.relationships.length ?? 0, events: events?.events.length ?? 0, geographicUnits: geoKeys.size };
  for (const [key, value] of Object.entries(actual)) if (manifest.counts[key] !== value) fail(`manifest.json: counts.${key} is ${manifest.counts[key]}, the data holds ${value}`);
  for (const id of Object.keys(manifest.sources)) if (!sourceIds.has(id)) fail(`manifest.json: status for unknown source ${id}`);
  for (const id of sourceIds) if (!manifest.sources[id]) fail(`manifest.json: no status for source ${id}`);
  const latest = Date.parse(manifest.generatedAt) + 36 * 3600 * 1000;
  const future = [];
  for (const record of cases.values()) for (const event of record.events) if (Date.parse(event.date) > latest) future.push(`${record.id} ${event.date}`);
  for (const record of bills.values()) for (const action of record.actions) if (Date.parse(action.date) > latest) future.push(`${record.id} ${action.date}`);
  if (future.length > 0) fail(`${future.length} event(s) are dated after the release itself, for example ${future[0]}`);
  pass('Manifest', `counts match the data (${Object.entries(actual).map(([k, v]) => `${k} ${v}`).join(', ')}); no event is dated after the release`);
  const notOk = Object.entries(manifest.sources).filter(([, v]) => v.processingStatus !== 'ok').map(([id, v]) => `${id}: ${v.processingStatus}`);
  for (const line of notOk) warn(`source ${line}`);
}

/* ---------- 7. nothing else is published ---------- */
// Vite copies public/data into the site unchanged, so every file here is served from the site's own address. Only
// the .json files read above may be there: the fixed files, the records an index lists, the texts a bill record
// names and the layers the geography index names. A page, a script, a link or an unlisted file stops the release.
{
  const notData = [];
  const hidden = [];
  const unlisted = new Map();
  let files = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir ? join(dataDir, dir) : dataDir, { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(rel);
        continue;
      }
      files += 1;
      const shown = entry.isFile() ? rel : `${rel} (not a regular file)`;
      if (rel.split('/').some((part) => part.startsWith('.'))) hidden.push(shown);
      else if (!entry.isFile() || !DATA_FILE.test(rel)) notData.push(shown);
      else if (!referenced.has(rel)) {
        const folder = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '(top level)';
        unlisted.set(folder, [...(unlisted.get(folder) ?? []), rel]);
      }
    }
  };
  if (existsSync(dataDir)) walk('');
  if (hidden.length > 0) {
    // Finder's .DS_Store and editors' swap files are the usual cause on a maintainer's computer; git ignores them,
    // so a fresh checkout has none, but a local build would still copy them into the site.
    fail(`${hidden.length} hidden file(s) under public/data (a name or folder that starts with a dot), for example ${hidden.slice(0, 3).join(', ')}; the site would serve them from its own address. Some systems and editors create such files on their own, for example .DS_Store`);
  }
  if (notData.length > 0) {
    fail(`${notData.length} file(s) under public/data are not .json data files with plain names, for example ${notData.slice(0, 3).join(', ')}; the site would serve them from its own address`);
  }
  for (const [folder, names] of unlisted) {
    fail(`${folder}: ${names.length} file(s) are not referenced by any index, bill record or the list of fixed data files, for example ${names[0]}`);
  }
  if (hidden.length === 0 && notData.length === 0 && unlisted.size === 0) pass('Published files', `the ${files} files under public/data are exactly the .json files the checks above read`);
}

/* ---------- report ---------- */
const result = { ok: errors.length === 0, generatedAt: manifest?.generatedAt ?? null, checks, warnings, errors };
if (asJson) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  for (const check of checks) console.log(`ok    ${check.name}: ${check.detail}`);
  for (const message of warnings) console.log(`note  ${message}`);
  for (const message of errors) console.log(`FAIL  ${message}`);
  console.log(errors.length === 0 ? `\nData release ${result.generatedAt} is valid (${checks.length} checks).` : `\n${errors.length} problem(s) found.`);
}
process.exit(errors.length === 0 ? 0 : 1);
