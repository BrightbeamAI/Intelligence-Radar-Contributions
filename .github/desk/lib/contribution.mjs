// The contribution contract in code: canonical JSON and digests, entry parsing and edits, validation,
// previews, and the GitHub issue route in both directions. Shared by the review desk (community/desk) and
// the Radar MCP server (mcp/, which bundles a copy). No dependencies; Node 20 or later. See community/SPEC.md.
import { createHash } from 'node:crypto';

export const SCHEMA = 'radar-contribution/1';
export const KINDS = ['review', 'correction', 'evidence', 'label-change', 'new-entry'];
export const INTELLIGENCE = ['Use', 'Trial', 'Evaluate', 'Wait', 'Prepare'];
export const ENTERPRISE = ['Revisit', 'Test', 'Plan for', 'Watch'];
export const RELATIONS = ['supports', 'challenges', 'qualifies'];
export const SECTORS = ['financial-services', 'insurance', 'pharma-and-biotech', 'medtech', 'manufacturing', 'public-services'];
// entry sections: payload key -> heading in source/entries/IR-xxx.md ("judgement" is the text before the first heading)
export const SECTIONS = { where: 'Where it fits', test: 'Test before committing', failure: 'Failure to watch', examples: 'Examples', owner: 'Owner' };
export const SECTION_NAMES = { title: 'Title', judgement: 'Judgement', ...SECTIONS };

// ---------------------------------------------------------------- canonical JSON (RFC 8785) and digests
export function canonical(v) {
  if (v === null || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || Math.abs(v) > Number.MAX_SAFE_INTEGER) throw new Error('canonical JSON allows integers only');
    return String(v);
  }
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort(); // UTF-16 code-unit order, as JCS requires
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  throw new Error('value has no canonical JSON form');
}
export const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
export const digest = (v) => 'sha256:' + sha256(canonical(v));
export const entryDigest = (raw) => digest(String(raw));
export const artefact = (contribution, version, payload) => ({ contribution, version, payload });

// ---------------------------------------------------------------- entries
/** Spans of an entry file's parts, as [start, end) offsets into the raw text, and its header fields. */
export function parseEntry(raw) {
  const text = String(raw);
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error('entry has no header');
  const header = {};
  const spans = {};
  let off = 4; // after "---\n"
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z_]+):\s?(.*)$/);
    if (kv) {
      header[kv[1]] = kv[2];
      if (kv[1] === 'title') spans.title = [off + line.length - kv[2].length, off + line.length];
    }
    off += line.length + 1;
  }
  const bodyStart = m[0].length;
  const heads = [...text.slice(bodyStart).matchAll(/^## (.+)$/gm)].map((h) => ({ name: h[1].trim(), at: bodyStart + h.index, len: h[0].length }));
  spans.judgement = [bodyStart, heads.length ? heads[0].at : text.length];
  const byHeading = Object.fromEntries(Object.entries(SECTIONS).map(([k, v]) => [v, k]));
  heads.forEach((h, i) => {
    const key = byHeading[h.name] || (h.name === 'Evidence' ? 'evidence' : h.name === 'Change in this edition' ? 'change' : null);
    if (key) spans[key] = [h.at + h.len, i + 1 < heads.length ? heads[i + 1].at : text.length];
  });
  const sections = Object.fromEntries(Object.entries(spans).map(([k, [a, b]]) => [k, text.slice(a, b).trim()]));
  return { header, spans, sections };
}

const count = (hay, needle) => {
  if (!needle) return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
};

/** Apply edits to an entry's raw text. Each `find` must occur exactly once in its section (or in the whole file when no section is named). */
export function applyEntryEdits(raw, edits = []) {
  let text = String(raw);
  const errors = [];
  edits.forEach((e, i) => {
    let a = 0;
    let b = text.length;
    if (e.section) {
      const span = parseEntry(text).spans[e.section];
      if (!span) return errors.push(`edit ${i + 1}: the entry has no ${SECTION_NAMES[e.section] || e.section} section`);
      [a, b] = span;
    }
    const part = text.slice(a, b);
    const n = count(part, e.find);
    if (n !== 1) return errors.push(`edit ${i + 1}: the text to replace occurs ${n === 0 ? 'nowhere' : n + ' times'} in ${e.section ? SECTION_NAMES[e.section] : 'the entry'}; copy it exactly, with enough words to be unique`);
    const at = a + part.indexOf(e.find);
    text = text.slice(0, at) + e.replace + text.slice(at + e.find.length);
  });
  return { text, errors };
}

/** Every string inside a dimension or sector object, for edits that target them. */
export function objectTexts(obj, out = []) {
  if (typeof obj === 'string') out.push(obj);
  else if (Array.isArray(obj)) obj.forEach((x) => objectTexts(x, out));
  else if (obj && typeof obj === 'object') Object.values(obj).forEach((x) => objectTexts(x, out));
  return out;
}

/** Apply edits to a dimension or sector object: each `find` must occur exactly once across its strings. Returns a new object. */
export function applyObjectEdits(obj, edits = []) {
  let cur = JSON.parse(JSON.stringify(obj));
  const errors = [];
  edits.forEach((e, i) => {
    const n = objectTexts(cur).reduce((s, t) => s + count(t, e.find), 0);
    if (n !== 1) return errors.push(`edit ${i + 1}: the text to replace occurs ${n === 0 ? 'nowhere' : n + ' times'}; copy it exactly, with enough words to be unique`);
    const walk = (x) => (typeof x === 'string' ? (x.includes(e.find) ? x.replace(e.find, () => e.replace) : x)
      : Array.isArray(x) ? x.map(walk) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v)])) : x);
    cur = walk(cur);
  });
  return { value: cur, errors };
}

// ---------------------------------------------------------------- normalising and validating
const str = (v) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim() : v);
const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;

/** Trim strings, drop empty optional fields and fill defaults. Does not fill `base`. */
export function normalise(p) {
  const out = JSON.parse(JSON.stringify(p || {}));
  out.schema = SCHEMA;
  for (const k of ['title', 'summary', 'conditions', 'reverse_if', 'claim', 'disclosure']) {
    if (out[k] === undefined) continue;
    out[k] = str(out[k]);
    if (out[k] === '' && k !== 'title' && k !== 'summary' && k !== 'disclosure') delete out[k];
  }
  if (out.title) out.title = out.title.replace(/\s+/g, ' ');
  if (out.target && typeof out.target.entry === 'string') {
    const m = out.target.entry.trim().match(/^(?:ir[\s-]?)?0*(\d{1,3})$/i);
    if (m) out.target.entry = `IR-${m[1].padStart(3, '0')}`;
  }
  for (const k of ['edits', 'evidence']) if (Array.isArray(out[k]) && out[k].length === 0) delete out[k];
  if (Array.isArray(out.edits)) out.edits = out.edits.map((e) => ({ ...(e.section ? { section: e.section } : {}), find: String(e.find ?? ''), replace: String(e.replace ?? '') }));
  if (Array.isArray(out.evidence)) out.evidence = out.evidence.map((e) => Object.fromEntries(Object.entries({ ...e, relation: e.relation || 'supports' }).map(([k, v]) => [k, str(v)]).filter(([, v]) => v !== '' && v !== undefined)));
  if (out.labels) for (const k of Object.keys(out.labels)) if (!out.labels[k]) delete out.labels[k];
  if (out.labels && Object.keys(out.labels).length === 0) delete out.labels;
  if (out.review) {
    for (const k of Object.keys(out.review)) { out.review[k] = str(out.review[k]); if (!out.review[k]) delete out.review[k]; }
    if (Object.keys(out.review).length === 0) delete out.review;
  }
  out.credit = { public: true, ...(out.credit || {}) };
  for (const k of ['name', 'affiliation']) { if (out.credit[k] !== undefined) out.credit[k] = str(out.credit[k]); if (!out.credit[k]) delete out.credit[k]; }
  return out;
}

const ALLOWED = new Set(['schema', 'kind', 'target', 'title', 'summary', 'base', 'edits', 'labels', 'conditions', 'reverse_if', 'claim', 'evidence', 'review', 'entry', 'disclosure', 'credit']);

/**
 * Check a normalised payload against the schema and the kind's rules, and, when `ctx` is given, against the Radar:
 *   ctx.entry(id) -> raw entry text or undefined; ctx.dimension(n) -> object or undefined; ctx.sector(slug) -> object or undefined
 * Returns { ok, errors, warnings }.
 */
export function validate(p, ctx) {
  const errors = [];
  const warnings = [];
  const need = (cond, msg) => { if (!cond) errors.push(msg); };
  need(p && typeof p === 'object', 'the contribution must be an object');
  if (!p || typeof p !== 'object') return { ok: false, errors, warnings };
  for (const k of Object.keys(p)) need(ALLOWED.has(k), `unknown field: ${k}`);
  need(p.schema === SCHEMA, `schema must be ${SCHEMA}`);
  need(KINDS.includes(p.kind), `kind must be one of ${KINDS.join(', ')}`);
  const t = p.target || {};
  const tk = Object.keys(t);
  need(tk.length === 1, 'target must name exactly one of entry, dimension, sector or general');
  if (t.entry !== undefined) need(/^IR-\d{3}$/.test(t.entry), 'target.entry must look like IR-028');
  if (t.dimension !== undefined) need(Number.isInteger(t.dimension) && t.dimension >= 1 && t.dimension <= 9, 'target.dimension must be 1 to 9');
  if (t.sector !== undefined) need(SECTORS.includes(t.sector), `target.sector must be one of ${SECTORS.join(', ')}`);
  if (t.general !== undefined) need(nonEmpty(t.general) && t.general.length <= 300, 'target.general must say where, in up to 300 characters');
  need(nonEmpty(p.title) && p.title.length >= 5 && p.title.length <= 120 && !p.title.includes('\n'), 'title must be one line of 5 to 120 characters');
  need(nonEmpty(p.summary) && p.summary.length >= 20 && p.summary.length <= 4000, 'summary must be 20 to 4000 characters: say why');
  need(nonEmpty(p.disclosure) && p.disclosure.length <= 1000, 'disclosure is required: write None if there is nothing to declare');
  need(p.credit && typeof p.credit.public === 'boolean', 'credit.public must be true or false');
  for (const k of ['conditions', 'reverse_if', 'claim']) if (p[k] !== undefined) need(typeof p[k] === 'string' && p[k].length <= 2000, `${k} must be up to 2000 characters`);
  const edits = p.edits || [];
  need(Array.isArray(edits) && edits.length <= 20, 'edits must be a list of up to 20');
  edits.forEach((e, i) => {
    need(typeof e.find === 'string' && e.find.length >= 3 && e.find.length <= 4000, `edit ${i + 1}: find must be 3 to 4000 characters of the current text`);
    need(typeof e.replace === 'string' && e.replace.length <= 6000, `edit ${i + 1}: replace must be up to 6000 characters`);
    need(e.find !== e.replace, `edit ${i + 1}: the replacement is the same as the current text`);
    if (e.section !== undefined) need(Object.keys(SECTION_NAMES).includes(e.section), `edit ${i + 1}: section must be one of ${Object.keys(SECTION_NAMES).join(', ')}`);
    if (t.entry === undefined) need(e.section === undefined, `edit ${i + 1}: sections apply to entries only`);
  });
  const ev = p.evidence || [];
  need(Array.isArray(ev) && ev.length <= 20, 'evidence must be a list of up to 20');
  ev.forEach((e, i) => {
    need(typeof e.url === 'string' && /^https:\/\/\S+$/.test(e.url) && e.url.length <= 2000, `evidence ${i + 1}: url must be an https address`);
    need(RELATIONS.includes(e.relation), `evidence ${i + 1}: relation must be supports, challenges or qualifies`);
  });
  if (p.labels !== undefined) {
    need(p.labels && Object.keys(p.labels).length >= 1, 'labels must name intelligence, enterprise or both');
    if (p.labels.intelligence !== undefined) need(INTELLIGENCE.includes(p.labels.intelligence), `labels.intelligence must be one of ${INTELLIGENCE.join(', ')}`);
    if (p.labels.enterprise !== undefined) need(ENTERPRISE.includes(p.labels.enterprise), `labels.enterprise must be one of ${ENTERPRISE.join(', ')}`);
  }
  if (p.review !== undefined) {
    need(p.kind === 'review', 'review ratings belong to kind review');
    const r = p.review;
    for (const k of ['makes_sense', 'easy_to_read']) if (r[k] !== undefined) need(['yes', 'partly', 'no'].includes(r[k]), `review.${k} must be yes, partly or no`);
    for (const k of ['intelligence_label', 'enterprise_label']) if (r[k] !== undefined) need(['yes', 'no', 'not-sure'].includes(r[k]), `review.${k} must be yes, no or not-sure`);
  }
  if (p.entry !== undefined) need(p.kind === 'new-entry', 'entry belongs to kind new-entry');
  // the kind's rules
  switch (p.kind) {
    case 'review':
      need(p.review && ['makes_sense', 'easy_to_read', 'intelligence_label', 'enterprise_label'].some((k) => p.review[k]), 'a review needs at least one rating');
      break;
    case 'correction':
      need(edits.length >= 1, 'a correction needs at least one edit: the exact current text and its replacement');
      need(t.general === undefined, 'a correction must target an entry, a dimension or a sector');
      break;
    case 'evidence':
      need(ev.length >= 1, 'evidence needs at least one source');
      need(nonEmpty(p.claim), 'evidence needs the claim it bears on');
      break;
    case 'label-change':
      need(t.entry !== undefined, 'a label change must target an entry');
      need(p.labels, 'a label change needs the proposed labels');
      need(nonEmpty(p.conditions), 'a label change needs the conditions under which the labels hold');
      need(ev.length >= 1, 'a label change needs at least one source');
      break;
    case 'new-entry': {
      need(t.dimension !== undefined, 'a new entry targets its dimension');
      const e = p.entry || {};
      const lens = { title: [3, 80], judgement: [80, 4000], where: [10, 1000], test: [10, 1000], failure: [10, 1000], examples: [3, 1000], owner: [3, 120] };
      for (const [k, [lo, hi]] of Object.entries(lens)) need(nonEmpty(e[k]) && e[k].length >= lo && e[k].length <= hi, `entry.${k} must be ${lo} to ${hi} characters`);
      need(INTELLIGENCE.includes(e.intelligence), 'entry.intelligence is required');
      need(ENTERPRISE.includes(e.enterprise), 'entry.enterprise is required');
      need(Number.isInteger(e.dimension) && e.dimension === t.dimension, 'entry.dimension must match target.dimension');
      need(ev.length >= 1, 'a new entry needs at least one source');
      break;
    }
    default:
  }
  // against the Radar
  if (ctx && errors.length === 0) {
    if (t.entry !== undefined) {
      const raw = ctx.entry(t.entry);
      if (raw === undefined) errors.push(`${t.entry} is not an entry of The Intelligence Radar`);
      else {
        const { errors: ee } = applyEntryEdits(raw, edits);
        errors.push(...ee);
        const { header } = parseEntry(raw);
        if (p.kind === 'label-change' && p.labels) {
          const same = (p.labels.intelligence ?? header.intelligence) === header.intelligence && (p.labels.enterprise ?? header.enterprise) === header.enterprise;
          need(!same, `the proposed labels are the entry's current labels (${header.intelligence}, ${header.enterprise})`);
        }
        if (p.base && p.base.entry_digest && p.base.entry_digest !== entryDigest(raw)) warnings.push(`${t.entry} has changed since this contribution was prepared; check the edits against the current text`);
      }
    }
    if (t.dimension !== undefined && p.kind !== 'new-entry') {
      const d = ctx.dimension(t.dimension);
      if (!d) errors.push(`dimension ${t.dimension} does not exist`);
      else errors.push(...applyObjectEdits(d, edits).errors);
    }
    if (t.sector !== undefined) {
      const s = ctx.sector(t.sector);
      if (!s) errors.push(`sector ${t.sector} does not exist`);
      else errors.push(...applyObjectEdits(s, edits).errors);
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** Fill `base` from the Radar: the edition, and for an entry target its digest and labels. */
export function fillBase(p, ctx, edition) {
  const out = { ...p, base: { edition } };
  const id = p.target && p.target.entry;
  const raw = id && ctx.entry(id);
  if (raw !== undefined && raw !== null && id) {
    const { header } = parseEntry(raw);
    out.base.entry_digest = entryDigest(raw);
    out.base.labels = { intelligence: header.intelligence, enterprise: header.enterprise };
  }
  return out;
}

// ---------------------------------------------------------------- reading a contribution
const KIND_NAMES = { review: 'Review', correction: 'Correction', evidence: 'Evidence', 'label-change': 'Label change', 'new-entry': 'New entry' };
export const kindName = (k) => KIND_NAMES[k] || k;
export function targetName(t = {}, names = {}) {
  if (t.entry) return names.entry ? `${t.entry} ${names.entry(t.entry) || ''}`.trim() : t.entry;
  if (t.dimension) return `Dimension ${t.dimension}${names.dimension ? ': ' + (names.dimension(t.dimension) || '') : ''}`;
  if (t.sector) return `Sector: ${names.sector ? names.sector(t.sector) || t.sector : t.sector}`;
  return t.general || '';
}

/** Exactly what will be submitted, as Markdown: the person sees this before confirming. */
export function preview(p, names = {}) {
  const L = [`**${kindName(p.kind)}: ${p.title}**`, `Target: ${targetName(p.target, names)}`];
  if (p.base && p.base.labels) L.push(`Current labels: ${p.base.labels.intelligence}, ${p.base.labels.enterprise}`);
  if (p.labels) L.push(`Proposed labels: ${[p.labels.intelligence, p.labels.enterprise].filter(Boolean).join(', ')}`);
  L.push('', p.summary);
  if (p.conditions) L.push('', `Conditions: ${p.conditions}`);
  if (p.claim) L.push('', `Claim: ${p.claim}`);
  if (p.reverse_if) L.push('', `What would change this judgement: ${p.reverse_if}`);
  (p.edits || []).forEach((e, i) => L.push('', `Edit ${i + 1}${e.section ? ` (${SECTION_NAMES[e.section]})` : ''}:`, `- Replace: "${e.find}"`, `- With: "${e.replace}"`));
  if (p.review) {
    const r = p.review;
    const lab = { yes: 'Yes', partly: 'Partly', no: 'No', 'not-sure': 'Not sure' };
    const rows = [['Makes sense', r.makes_sense], ['Easy to read', r.easy_to_read], ['Intelligence label reasonable', r.intelligence_label], ['Enterprise label reasonable', r.enterprise_label]].filter(([, v]) => v);
    L.push('', ...rows.map(([k, v]) => `- ${k}: ${lab[v]}`));
    if (r.suggested_wording) L.push('', `Suggested wording: ${r.suggested_wording}`);
    if (r.corrections) L.push('', `Corrections: ${r.corrections}`);
  }
  if (p.entry) {
    const e = p.entry;
    L.push('', `New entry: ${e.title} (dimension ${e.dimension}; ${e.intelligence}, ${e.enterprise})`, '', e.judgement,
      '', `Where it fits: ${e.where}`, `Test before committing: ${e.test}`, `Failure to watch: ${e.failure}`, `Examples: ${e.examples}`, `Owner: ${e.owner}`);
  }
  if ((p.evidence || []).length) L.push('', 'Evidence:', ...p.evidence.map((e) => `- ${e.relation}: ${[e.title, e.publisher, e.date].filter(Boolean).join(', ') || e.url} (${e.url})${e.note ? ': ' + e.note : ''}`));
  L.push('', `Interests declared: ${p.disclosure}`, `Credit: ${p.credit && p.credit.public ? (p.credit.name ? `by name, as ${p.credit.name}` : 'by name') : 'not credited publicly'}${p.credit && p.credit.affiliation ? `, ${p.credit.affiliation}` : ''}`);
  return L.join('\n');
}

// ---------------------------------------------------------------- the GitHub route
const SOURCE_LINE = (e) => [e.url, e.title, e.publisher, e.date].filter((x, i) => i === 0 || x).join(' | ');

/** Build the pre-filled issue link for a payload. `forms` is community/forms.json. */
export function issueLink(p, forms, { maxLength = 7500 } = {}) {
  const form = forms.forms.find((f) => f.kind === p.kind);
  const q = new URLSearchParams({ template: form.file, title: form.title + p.title });
  const set = (id, v) => { if (v !== undefined && v !== null && String(v).trim() !== '') q.set(id, String(v)); };
  for (const f of form.fields) {
    if (f.type === 'dropdown' || f.type === 'checkboxes') continue; // GitHub fills text fields only
    const to = f.to;
    if (to === 'target.entry') set(f.id, p.target && p.target.entry);
    else if (to === 'sources') set(f.id, (p.evidence || []).map(SOURCE_LINE).join('\n'));
    else if (to === 'prepared') continue;
    else if (to === 'credit.name') set(f.id, p.credit && p.credit.name);
    else if (to && to.startsWith('edits[0].')) set(f.id, p.edits && p.edits[0] && p.edits[0][to.slice(9)]);
    else if (to) set(f.id, to.split('.').reduce((o, k) => (o ? o[k] : undefined), p));
  }
  const withPrepared = new URLSearchParams(q);
  withPrepared.set('prepared', JSON.stringify(p, null, 1));
  const base = `https://github.com/${forms.repo}/issues/new?`;
  const full = base + withPrepared.toString();
  if (full.length <= maxLength) return { url: full, prepared_included: true };
  return { url: base + q.toString(), prepared_included: false, prepared: JSON.stringify(p, null, 1) };
}

/** The sections of an issue form's body: label -> value ('' when "_No response_"). */
export function issueSections(body) {
  const out = {};
  const parts = String(body || '').replace(/\r\n?/g, '\n').split(/^### /m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const label = (nl === -1 ? part : part.slice(0, nl)).trim();
    let value = nl === -1 ? '' : part.slice(nl + 1).trim();
    if (value === '_No response_' || value === 'None selected') value = '';
    const fence = value.match(/^(`{3,})[a-z]*\n([\s\S]*?)\n\1$/) || value.match(/^<details>[\s\S]*?\n(`{3,})json\n([\s\S]*?)\n\1\s*<\/details>$/);
    if (fence) value = fence[2];
    out[label] = value;
  }
  return out;
}

const setPath = (obj, path, v) => {
  const keys = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let o = obj;
  keys.slice(0, -1).forEach((k, i) => { if (o[k] === undefined) o[k] = /^\d+$/.test(keys[i + 1]) ? [] : {}; o = o[k]; });
  o[keys[keys.length - 1]] = v;
};

/** Parse sources, one per line: URL | title | publisher | date. */
export function parseSources(text, relation = 'supports') {
  return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [url, title, publisher, date] = l.split('|').map((x) => x.trim());
    return Object.fromEntries(Object.entries({ url: url.replace(/^[-*]\s*/, '').replace(/^<|>$/g, ''), title, publisher, date, relation }).filter(([, v]) => v));
  });
}

/**
 * Read an issue opened from a contribution form. `issue` has `title`, `body` and `labels` (names); `forms` is community/forms.json.
 * Returns { kind, payload, errors } with the payload normalised but not validated, or { kind: 'apply', application } for the apply form.
 */
export function payloadFromIssue(issue, forms) {
  const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
  const sec = issueSections(issue.body);
  const has = (f) => Object.prototype.hasOwnProperty.call(sec, f.label);
  const byLabels = forms.forms.find((f) => f.kind && labels.includes(f.kind));
  const byTitle = forms.forms.find((f) => String(issue.title || '').startsWith(f.title.trim()));
  const byFields = forms.forms.slice().sort((a, b) => b.fields.filter(has).length - a.fields.filter(has).length)[0];
  const form = labels.includes('apply-to-contribute') ? forms.forms.find((f) => f.kind === null) : byLabels || byTitle || byFields;
  if (!form) return { kind: null, errors: ['not a contribution form'] };
  if (form.kind === null) {
    const a = {};
    for (const f of form.fields) if (f.to && has(f)) a[f.to] = f.type === 'checkboxes' ? sec[f.label].split('\n').filter((l) => /^- \[x\]/i.test(l)).map((l) => l.replace(/^- \[x\]\s*/i, '')) : sec[f.label];
    return { kind: 'apply', application: a, errors: [] };
  }
  const errors = [];
  let p = { schema: SCHEMA, kind: form.kind };
  const prepared = form.fields.find((f) => f.to === 'prepared');
  if (prepared && sec[prepared.label]) {
    try {
      const j = JSON.parse(sec[prepared.label]);
      if (j && typeof j === 'object' && j.kind === form.kind) p = { ...j, schema: SCHEMA, kind: form.kind };
      else errors.push('the prepared contribution does not match this form; it was ignored');
    } catch { errors.push('the prepared contribution is not valid JSON; it was ignored'); }
  }
  const title = String(issue.title || '').replace(form.title.trim(), '').trim();
  if (title) p.title = title;
  let relation;
  const rel = form.fields.find((f) => f.to === 'relation');
  if (rel && sec[rel.label]) relation = { 'Supports it': 'supports', 'Challenges it': 'challenges', 'Qualifies it': 'qualifies' }[sec[rel.label]];
  for (const f of form.fields) {
    if (!f.to || !has(f) || f.to === 'prepared' || f.to === 'relation') continue;
    const v = sec[f.label];
    if (v === '') continue;
    if (f.to === 'sources') p.evidence = parseSources(v, relation || 'supports');
    else if (f.to === 'credit') p.credit = { ...(p.credit || {}), public: v !== 'Do not credit me publicly' };
    else if (f.to === 'dimension_name') {
      const n = forms.dimensions.indexOf(v) + 1;
      if (n > 0) { p.target = { dimension: n }; p.entry = { ...(p.entry || {}), dimension: n }; }
    } else if (f.to.startsWith('label:')) {
      if (v !== 'No change') setPath(p, f.to === 'label:entry.intelligence' ? 'entry.intelligence' : f.to === 'label:entry.enterprise' ? 'entry.enterprise' : 'labels.' + f.to.slice(6), v);
    } else if (f.to.startsWith('rating:')) setPath(p, 'review.' + f.to.slice(7), v.toLowerCase().replace(' ', '-'));
    else if (f.to === 'edits[0].section') setPath(p, f.to, Object.entries(SECTION_NAMES).find(([, n]) => n === v)?.[0]);
    else if (f.to === 'target.entry') p.target = { entry: v };
    else setPath(p, f.to, v);
  }
  if (relation && Array.isArray(p.evidence)) p.evidence = p.evidence.map((e) => ({ ...e, relation }));
  return { kind: form.kind, payload: normalise(p), errors };
}

/**
 * The issue an AI assistant opens for a payload: the form's title prefix and a body that reads well on
 * GitHub (the preview) and parses back to exactly this payload (the prepared JSON, folded away).
 * payloadFromIssue(renderIssue(p, forms)) gives back p. `names` is as for preview().
 */
export function renderIssue(p, forms, names = {}) {
  const form = forms.forms.find((f) => f.kind === p.kind);
  if (!form) throw new Error(`no form for kind ${p.kind}`);
  const prepared = form.fields.find((f) => f.to === 'prepared');
  const json = JSON.stringify(p, null, 1);
  const fence = '`'.repeat(Math.max(3, ...(json.match(/`+/g) || []).map((r) => r.length + 1)));
  const body = [
    preview(p, names).replace(/^### /gm, '#### '),
    '',
    `### ${prepared.label}`,
    '',
    '<details><summary>The contribution as data (read by the review desk)</summary>',
    '',
    `${fence}json`,
    json,
    fence,
    '</details>',
    '',
  ].join('\n');
  return { title: form.title + p.title, body, labels: ['contribution', p.kind] };
}
