// node --test .github/desk/test/*.test.mjs   (from the repository root)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GitHub } from '../api.mjs';
import { Desk, parseCommand } from '../desk.mjs';
import { normalise, renderIssue } from '../lib/contribution.mjs';
import { contributionState, eventsOf, marker } from '../state.mjs';
import { FakeGitHub } from './fake-github.mjs';

const read = (name) => JSON.parse(readFileSync(new URL(`../lib/${name}`, import.meta.url), 'utf8'));
const config = read('config.json');
const forms = read('forms.json');
const REPO = 'BrightbeamAI/Intelligence-Radar-Contributions';
const BOT = 'github-actions[bot]';

/** An issue body as GitHub writes it for a form: each field's label as a heading, then its value. */
function formBody(file, values) {
  const form = forms.forms.find((f) => f.file === file);
  return form.fields.map((f) => {
    let v = values[f.id];
    if (f.type === 'checkboxes') v = f.options.map((o) => `- [${values[f.id]?.includes(o) || f.id === 'terms' ? 'X' : ' '}] ${o}`).join('\n');
    return `### ${f.label}\n\n${v === undefined || v === '' ? '_No response_' : v}`;
  }).join('\n\n');
}

function setUp() {
  const gh = new FakeGitHub(REPO, { bot: BOT });
  gh.user(BOT, 41898282);
  gh.user('ed-one', 101);
  gh.user('rev-two', 102);
  gh.user('cont-three', 103);
  gh.user('newcomer', 104);
  gh.user('ed-four', 105);
  gh.setFile('people.json', `${JSON.stringify({ note: 'test', people: [
    { login: 'ed-one', id: 101, name: 'Edith One', role: 'editor', areas: [], since: '2026-11-07' },
    { login: 'rev-two', id: 102, name: 'Rev Two', role: 'reviewer', areas: [], since: '2026-11-07' },
    { login: 'cont-three', id: 103, name: 'Con Three', role: 'contributor', areas: [], since: '2026-11-07' },
  ] }, null, 1)}\n`);
  const desk = new Desk({ gh: new GitHub({ repo: REPO, token: 't', base: 'https://api.test', fetchImpl: gh.fetch }), config, forms, now: () => new Date(gh.clock) });
  const opened = async (login, issue) => desk.handle('issues', { action: 'opened', issue: gh.openIssue(login, issue), sender: { login } });
  const edited = async (n, login, changes) => desk.handle('issues', { action: 'edited', issue: gh.editIssue(n, changes), sender: { login } });
  const says = async (n, login, body) => desk.handle('issue_comment', { action: 'created', issue: structuredClone(gh.issues.get(n)), comment: gh.addComment(n, login, body) });
  const state = (n, kind) => contributionState(eventsOf(gh.commentsOn(n), BOT), config, kind);
  const last = (n) => gh.commentsOn(n).at(-1).body;
  return { gh, desk, opened, edited, says, state, last };
}

const correction = (extra = {}) => ({
  title: '[Correction] Name the foundation precisely',
  labels: ['contribution', 'correction'],
  body: formBody('correction.yml', {
    entry: 'IR-028', section: 'Judgement', current: 'under the Agentic AI Foundation', proposed: 'under the Agentic AI Foundation (AAIF)',
    why: 'The announcement names the foundation; the entry should too.', disclosure: 'None', credit: 'Credit me by name', ...extra,
  }),
});

const labelChange = () => ({
  title: '[Label change] Move IR-028 to Use for regulated firms',
  labels: ['contribution', 'label-change'],
  body: formBody('label-change.yml', {
    entry: 'IR-028', proposed_intelligence: 'Use', proposed_enterprise: 'No change', conditions: 'Where audit logging is in place.',
    why: 'Three regulated adopters report stable operation for a year.', sources: 'https://example.org/report | Report | Example | 2026', disclosure: 'None',
  }),
});

const people = (gh) => JSON.parse(gh.files.get('people.json').text).people;

test('an application to be a specialist reviewer tells the editors, by @mention', async () => {
  const { opened, last } = setUp();
  const app = { title: '[Apply] Nia Newcomer', labels: ['apply-to-contribute'], body: formBody('apply.yml', { name: 'Nia Newcomer', experience: 'Model risk.', disclosure: 'None' }) };
  assert.equal(await opened('newcomer', app), 'application');
  assert.match(last(1), /Thank you for applying to be a specialist reviewer/);
  assert.match(last(1), /@ed-one: a new application to be a specialist reviewer/);
});

test("anyone can contribute: a newcomer's contribution goes straight to review, and its approval lists them", async () => {
  const { gh, opened, says, state, last } = setUp();
  assert.equal(await opened('newcomer', correction({ credit_name: 'Nia Newcomer' })), 'in-review');
  assert.match(last(1), /^Received: correction from @newcomer\. Thank you for contributing\. It is complete/);
  assert.match(last(1), /Once a contribution of yours is approved, you join the \[list of people\]/);
  assert.match(last(1), /For review: @ed-one @rev-two\./);
  assert.deepEqual(gh.labelsOf(1), ['contribution', 'correction', 'in-review']);
  assert.equal(state(1, 'correction').current.role, 'contributor');
  assert.ok(!people(gh).some((p) => p.login === 'newcomer'), 'listed only once a contribution is approved');
  assert.equal(await says(1, 'newcomer', '/approve'), 'refused');
  assert.equal(await says(1, 'rev-two', '/approve Matches the announcement.'), 'approved');
  assert.match(last(1), /^Thank you, @newcomer: with this contribution approved, you are now on the \[list of people\]/);
  assert.deepEqual(eventsOf(gh.commentsOn(1), BOT).filter((e) => e.e === 'listed').map(({ login, role, by, name }) => ({ login, role, by, name })),
    [{ login: 'newcomer', role: 'contributor', by: 'rev-two', name: 'Nia Newcomer' }]);
  assert.deepEqual(people(gh).find((p) => p.login === 'newcomer'),
    { login: 'newcomer', id: 104, name: 'Nia Newcomer', role: 'contributor', areas: [], since: '2026-11-08', contribution: 1 });
  assert.match(gh.files.get('PEOPLE.md').text, /Nia Newcomer\*\* \(\[@newcomer\]/);
  // from now on the list names them, and a second approval lists no one again
  assert.equal(await opened('newcomer', correction()), 'in-review');
  assert.match(last(2), /^Received: correction from @newcomer, on the list of people as a contributor\./);
  assert.equal(await says(2, 'ed-one', '/approve'), 'approved');
  assert.match(last(2), /\*\*Approved\.\*\*/);
  assert.equal(people(gh).filter((p) => p.login === 'newcomer').length, 1);
});

test('a contributor who chose not to be credited is not listed; an editor edit that approves lists the contributor', async () => {
  const { gh, opened, edited, says, last } = setUp();
  assert.equal(await opened('newcomer', correction({ credit: 'Do not credit me publicly' })), 'in-review');
  assert.match(last(1), /As you asked, you will not be credited publicly\./);
  assert.equal(await says(1, 'rev-two', '/approve'), 'approved');
  assert.ok(!people(gh).some((p) => p.login === 'newcomer'));
  gh.user('first-timer', 106);
  await opened('first-timer', correction());
  const body = gh.issues.get(2).body.replace('(AAIF)', '(the AAIF)');
  assert.equal(await edited(2, 'ed-one', { body }), 'approved');
  assert.match(last(2), /^Thank you, @first-timer/);
  assert.equal(people(gh).find((p) => p.login === 'first-timer').role, 'contributor');
});

test('an editor closes an incomplete contribution before review; a label change asks the editors', async () => {
  const { gh, opened, says, last } = setUp();
  assert.equal(await opened('newcomer', correction({ why: 'Too short' })), 'needs information');
  assert.equal(await says(1, 'rev-two', '/decline Outside the scope.'), 'refused');
  assert.equal(await says(1, 'ed-one', '/decline Outside the scope of The Intelligence Radar.'), 'closed before review');
  assert.equal(gh.issues.get(1).state_reason, 'not_planned');
  assert.match(last(1), /^Closed by @ed-one \(editor\) before review/);
  await opened('cont-three', labelChange());
  assert.match(last(2), /For review: @ed-one\.$/m);
  await says(2, 'rev-two', '/approve');
  assert.match(last(2), /It needs an editor's approval[\s\S]*For review: @ed-one\./);
});

test('commands are read from the first line, with an optional digest', () => {
  assert.deepEqual(parseCommand('/approve Looks right.'), { name: 'approve', args: 'Looks right.', text: 'Looks right.', digest: null, json: null });
  assert.equal(parseCommand('/changes sha256:abcdef12 Cite the source\nand the date').digest, 'sha256:abcdef12');
  assert.equal(parseCommand('/changes sha256:abcdef12 Cite the source\nand the date').text, 'Cite the source\nand the date');
  assert.equal(parseCommand('I /approve of this'), null);
});

test('someone applies to be a specialist reviewer and is admitted; a listed contributor can apply too', async () => {
  const { gh, opened, says, last } = setUp();
  const app = { title: '[Apply] Nia Newcomer', labels: ['apply-to-contribute'], body: formBody('apply.yml', { name: 'Nia Newcomer', affiliation: 'Example Bank', role: 'Specialist reviewer', experience: 'Ten years of model risk.', disclosure: 'None' }) };
  assert.equal(await opened('newcomer', app), 'application');
  assert.equal(await says(1, 'rev-two', '/admit'), 'refused');
  assert.equal(await says(1, 'ed-one', '/admit'), 'admitted as reviewer');
  assert.deepEqual(people(gh).find((p) => p.login === 'newcomer'), { login: 'newcomer', id: 104, name: 'Nia Newcomer', role: 'reviewer', affiliation: 'Example Bank', areas: [], since: '2026-11-08', application: 1 });
  assert.match(gh.files.get('PEOPLE.md').text, /Nia Newcomer\*\* \(\[@newcomer\]/);
  assert.match(last(1), /^Welcome, @newcomer: approved by @ed-one as a specialist reviewer[\s\S]*You will be asked to decide on contributions here/);
  assert.equal(gh.issues.get(1).state, 'closed');
  // a contributor already on the list applies to review
  const app2 = { title: '[Apply] Con Three', labels: ['apply-to-contribute'], body: formBody('apply.yml', { name: 'Con Three', experience: 'Model risk.', disclosure: 'None' }) };
  assert.equal(await opened('cont-three', app2), 'application');
  assert.equal(await says(2, 'ed-one', '/admit reviewer'), 'admitted as reviewer');
  assert.match(last(2), /^@cont-three is now a specialist reviewer on the \[list of people\]\([^)]*\), approved by @ed-one\./);
  assert.equal(people(gh).find((p) => p.login === 'cont-three').role, 'reviewer');
  // a specialist reviewer who applies is told they are listed already
  assert.equal(await opened('rev-two', { ...app2, title: '[Apply] Rev Two' }), 'already listed');
});

test('one approval publishes a correction; the contributor cannot approve their own', async () => {
  const { gh, opened, says, state, last } = setUp();
  assert.equal(await opened('cont-three', correction()), 'in-review');
  assert.match(last(1), /Received: correction from @cont-three/);
  assert.equal(await says(1, 'cont-three', '/approve'), 'refused');
  assert.equal(await says(1, 'stranger', '/approve'), 'refused');
  assert.equal(await says(1, 'rev-two', '/approve Checked against the announcement.'), 'approved');
  assert.match(last(1), /\*\*Approved\.\*\*/);
  assert.deepEqual(gh.labelsOf(1), ['approved', 'contribution', 'correction']);
  assert.equal(await says(1, 'rev-two', '/published 2026-12-01'), 'refused');
  assert.equal(await says(1, 'ed-one', '/published 2026-12-01'), 'published');
  assert.equal(state(1, 'correction').status, 'published');
  assert.equal(gh.issues.get(1).state_reason, 'completed');
});

test("a label change needs an editor's approval: a specialist reviewer's alone is not enough", async () => {
  const { gh, opened, says, state, last } = setUp();
  await opened('cont-three', labelChange());
  assert.match(last(1), /It needs an editor's approval/);
  assert.equal(await says(1, 'rev-two', '/approve Evidence holds.'), 'in-review');
  assert.match(last(1), /It needs an editor's approval/);
  assert.equal(await says(1, 'ed-one', '/approve'), 'approved');
  assert.equal(state(1, 'label-change').status, 'approved');
  assert.deepEqual(gh.labelsOf(1), ['approved', 'contribution', 'label-change']);
});

test('changes asked for, a revision by editing the issue, and approvals of earlier versions no longer count', async () => {
  const { gh, opened, edited, says, state } = setUp();
  await opened('cont-three', labelChange());
  await says(1, 'rev-two', '/approve');
  assert.equal(await says(1, 'ed-one', '/changes'), 'refused');
  assert.equal(await says(1, 'ed-one', '/changes Say which regulator.'), 'changes-requested');
  assert.deepEqual(gh.labelsOf(1), ['changes-requested', 'contribution', 'label-change']);
  const body = gh.issues.get(1).body.replace('Where audit logging is in place.', 'Where audit logging is in place, as the EBA expects.');
  assert.equal(await edited(1, 'cont-three', { body }), 'in-review');
  const st = state(1, 'label-change');
  assert.equal(st.current.n, 2);
  assert.equal(st.assessment.have, 0);
  assert.equal(await says(1, 'ed-one', '/approve'), 'approved');
});

test("an editor's edit while in review is a new version and counts as their approval", async () => {
  const { gh, opened, edited, state, last } = setUp();
  await opened('cont-three', labelChange());
  const body = gh.issues.get(1).body.replace('Where audit logging is in place.', 'Where audit logging and human sign-off are in place.');
  assert.equal(await edited(1, 'ed-one', { body }), 'approved');
  assert.match(last(1), /Version 2: edited by @ed-one \(editor\)/);
  assert.equal(state(1, 'label-change').current.by, 'ed-one');
});

test('someone outside the panel cannot make a version by editing; an approved contribution takes no edits', async () => {
  const { gh, opened, edited, says, last } = setUp();
  await opened('cont-three', correction());
  const body2 = gh.issues.get(1).body.replace('(AAIF)', '(the AAIF)');
  gh.user('outsider', 200);
  assert.equal(await edited(1, 'outsider', { body: body2 }), 'edit not taken');
  await says(1, 'rev-two', '/approve');
  assert.equal(await edited(1, 'cont-three', { body: body2.replace('the AAIF', 'AAIF, Linux Foundation') }), 'approved; edit not taken');
  assert.match(last(1), /no longer taken/);
});

test('a decline closes the issue; a withdrawal is only for the contributor', async () => {
  const { gh, opened, says } = setUp();
  await opened('cont-three', correction());
  assert.equal(await says(1, 'rev-two', '/withdraw'), 'refused');
  assert.equal(await says(1, 'rev-two', '/decline The entry already says this.'), 'declined');
  assert.equal(gh.issues.get(1).state, 'closed');
  assert.equal(gh.issues.get(1).state_reason, 'not_planned');
  await opened('cont-three', correction());
  assert.equal(await says(2, 'cont-three', '/withdraw Sent twice.'), 'withdrawn');
});

test('a marker typed by anyone else is ignored', async () => {
  const { gh, opened, says, state } = setUp();
  await opened('cont-three', correction());
  gh.addComment(1, 'cont-three', marker({ e: 'decision', d: 'approve', by: 'ed-one', role: 'editor', n: 1, digest: state(1, 'correction').current.digest }));
  assert.equal(state(1, 'correction').status, 'in-review');
  assert.equal(await says(1, 'cont-three', 'just a comment'), 'no command');
});

test('an incomplete contribution is explained once and goes to review once fixed', async () => {
  const { gh, opened, edited, last } = setUp();
  assert.equal(await opened('cont-three', correction({ why: 'Too short' })), 'needs information');
  assert.match(last(1), /summary must be 20 to 4000 characters/);
  assert.deepEqual(gh.labelsOf(1), ['contribution', 'correction', 'needs-info']);
  const body = gh.issues.get(1).body.replace('Too short', 'The announcement names the foundation; the entry should too.');
  assert.equal(await edited(1, 'cont-three', { body }), 'in-review');
  assert.deepEqual(gh.labelsOf(1), ['contribution', 'correction', 'in-review']);
});

test('an issue opened by an AI assistant, without labels, is recognised and reviewed', async () => {
  const { gh, opened, state } = setUp();
  const p = normalise({ kind: 'evidence', target: { entry: 'IR-028' }, title: 'A second source for adoption', summary: 'An independent survey supports the adoption claim.', claim: 'Adoption is broad.', evidence: [{ url: 'https://example.org/survey', relation: 'supports', note: 'n = 400' }], disclosure: 'None' });
  const issue = renderIssue(p, forms);
  assert.equal(await opened('cont-three', { title: issue.title, body: issue.body, labels: [] }), 'in-review');
  assert.deepEqual(state(1, 'evidence').current.payload, p);
  assert.deepEqual(gh.labelsOf(1), ['contribution', 'evidence', 'in-review']);
});

test('editors change roles and remove people, and the list keeps an editor', async () => {
  const { gh, opened, says } = setUp();
  await opened('cont-three', correction());
  assert.equal(await says(1, 'ed-one', '/role @ed-one reviewer'), 'refused');
  assert.equal(await says(1, 'ed-one', '/role @rev-two editor'), 'role editor');
  assert.equal(JSON.parse(gh.files.get('people.json').text).people.find((p) => p.login === 'rev-two').role, 'editor');
  assert.equal(await says(1, 'ed-one', '/remove @cont-three'), 'refused');
  assert.equal(await says(1, 'ed-one', '/remove @cont-three Asked to leave.'), 'removed');
  assert.ok(!gh.files.get('PEOPLE.md').text.includes('Con Three'));
  assert.equal(await says(1, 'cont-three', '/role @ed-one contributor'), 'refused');
});

test('a sweep rewrites PEOPLE.md and checks open issues again', async () => {
  const { gh, desk } = setUp();
  gh.openIssue('cont-three', correction());
  const out = await desk.handle('workflow_dispatch', {});
  assert.match(out, /PEOPLE\.md rewritten\. #1: in-review/);
  assert.equal(await desk.handle('workflow_dispatch', {}), '#1: in-review');
});

test('the publish queue lists approved contributions in their approved version, with credit and approvals', async () => {
  const { gh, desk, opened, says } = setUp();
  await opened('cont-three', correction());
  await opened('cont-three', labelChange());
  await says(1, 'rev-two', '/approve');
  const { publishQueue } = await import('../queue.mjs');
  const q = await publishQueue({ gh: desk.gh, config });
  assert.equal(q.items.length, 1);
  const item = q.items[0];
  assert.equal(item.id, 'C-0001');
  assert.equal(item.github_issue, 1);
  assert.equal(item.payload.edits[0].replace, 'under the Agentic AI Foundation (AAIF)');
  assert.deepEqual(item.contributor, { name: 'Con Three', affiliation: null, public: true });
  assert.deepEqual(item.approvals.map((a) => [a.name, a.role]), [['Rev Two', 'reviewer']]);
  assert.equal(gh.issues.size, 2);
});

test('a reviewer edits with /edit and a JSON block: the desk rewrites the issue and the version counts as their approval', async () => {
  const { gh, desk, opened, says, state, last } = setUp();
  await opened('cont-three', labelChange());
  const p = structuredClone(state(1, 'label-change').current.payload);
  p.conditions = 'Where audit logging and human sign-off are in place.';
  const block = `\`\`\`json\n${JSON.stringify(p, null, 1)}\n\`\`\``;
  assert.equal(await says(1, 'rev-two', `/edit\n${block}`), 'refused');
  assert.equal(await says(1, 'rev-two', `/edit Narrower conditions.\n${block}`), 'in-review');
  assert.match(last(1), /Version 2: edited by @rev-two/);
  assert.equal(state(1, 'label-change').current.payload.conditions, p.conditions);
  assert.match(gh.issues.get(1).body, /human sign-off/);
  const changedTarget = { ...p, target: { entry: 'IR-001' } };
  assert.equal(await says(1, 'ed-one', `/edit Other entry.\n\`\`\`json\n${JSON.stringify(changedTarget)}\n\`\`\``), 'refused');
  assert.equal(await says(1, 'ed-one', '/approve'), 'approved');
  // the issue's body is the current version, so a later sweep finds nothing new
  assert.equal(await desk.handle('workflow_dispatch', {}), 'PEOPLE.md rewritten. #1: approved');
});
