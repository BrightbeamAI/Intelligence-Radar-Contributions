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
const PUBLISHER = config.publisher_bot;
// a card's first and last lines
const HEAD = '<a href="https://theintelligenceradar.com/"><img src="https://raw.githubusercontent.com/BrightbeamAI/Intelligence-Radar-Contributions/main/assets/message-header.png" alt="TheIntelligenceRadar.com" width="480"></a>';
const FOOT = `<sub>[TheIntelligenceRadar.com](https://theintelligenceradar.com/) · a community-driven radar for technical leaders · [Your contributions](https://github.com/${REPO}/issues?q=is%3Aissue%20author%3A%40me) · [How contributions work](https://github.com/${REPO}/blob/main/CONTRIBUTING.md)</sub>`;

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
  // the event's sender, as GitHub gives it: the login and the numeric id
  const sender = (login) => ({ login, id: gh.users.get(login.toLowerCase())?.id ?? null });
  const opened = async (login, issue) => desk.handle('issues', { action: 'opened', issue: gh.openIssue(login, issue), sender: sender(login) });
  const edited = async (n, login, changes) => desk.handle('issues', { action: 'edited', issue: gh.editIssue(n, changes), sender: sender(login) });
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
  assert.match(last(1), /### Application received\n\nThank you for applying to be a specialist reviewer, @newcomer\./);
  // the call to the editors follows the card, in the notes for the reviewers
  assert.match(last(1), /\n\n---\n\n\*\*For the reviewers\.\*\* @ed-one: a new application to be a specialist reviewer/);
});

test("anyone can contribute: a newcomer's contribution goes straight to review, and its approval lists them", async () => {
  const { gh, opened, says, state, last } = setUp();
  assert.equal(await opened('newcomer', correction({ credit_name: 'Nia Newcomer' })), 'in-review');
  assert.match(last(1), /### Received: your correction to IR-028\n\nThank you for contributing to The Intelligence Radar, @newcomer\.\n\nYour correction is complete/);
  assert.match(last(1), /Once a contribution of yours is approved, you join the \[list of people\]/);
  assert.match(last(1), /For review: @ed-one @rev-two\./);
  assert.deepEqual(gh.labelsOf(1), ['contribution', 'correction', 'in-review']);
  assert.equal(state(1, 'correction').current.role, 'contributor');
  assert.ok(!people(gh).some((p) => p.login === 'newcomer'), 'listed only once a contribution is approved');
  assert.equal(await says(1, 'newcomer', '/approve'), 'refused');
  assert.equal(await says(1, 'rev-two', '/approve Matches the announcement.'), 'approved');
  // the listing is a short card: no header, the title first
  assert.match(last(1), /^### You are on the list of people\n\nThank you, @newcomer: with this contribution approved, you are now on the \[list of people\]/);
  assert.ok(last(1).includes(`\n\n${FOOT}\n\n<!-- radar-desk `));
  assert.deepEqual(eventsOf(gh.commentsOn(1), BOT).filter((e) => e.e === 'listed').map(({ login, role, by, name }) => ({ login, role, by, name })),
    [{ login: 'newcomer', role: 'contributor', by: 'rev-two', name: 'Nia Newcomer' }]);
  assert.deepEqual(people(gh).find((p) => p.login === 'newcomer'),
    { login: 'newcomer', id: 104, name: 'Nia Newcomer', role: 'contributor', areas: [], since: '2026-11-08', contribution: 1 });
  assert.match(gh.files.get('PEOPLE.md').text, /Nia Newcomer\*\* \(\[@newcomer\]/);
  // from now on the list names them, and a second approval lists no one again
  assert.equal(await opened('newcomer', correction()), 'in-review');
  assert.match(last(2), /Thank you for contributing to The Intelligence Radar, @newcomer\. You are on the list of people as a contributor\./);
  assert.equal(await says(2, 'ed-one', '/approve'), 'approved');
  assert.match(last(2), /^### Approved$/m);
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
  assert.match(gh.commentsOn(2).at(-2).body, /### Approved, with an edit\n\nVersion 2: edited by @ed-one \(editor\), which counts as their approval of it\.\n\n@first-timer, it will be published/);
  assert.match(last(2), /^### You are on the list of people\n\nThank you, @first-timer/);
  assert.equal(people(gh).find((p) => p.login === 'first-timer').role, 'contributor');
});

test('an editor closes an incomplete contribution before review; a label change asks the editors', async () => {
  const { gh, opened, says, last } = setUp();
  assert.equal(await opened('newcomer', correction({ why: 'Too short' })), 'needs information');
  assert.equal(await says(1, 'rev-two', '/decline Outside the scope.'), 'refused');
  assert.equal(await says(1, 'ed-one', '/decline Outside the scope of The Intelligence Radar.'), 'closed before review');
  assert.equal(gh.issues.get(1).state_reason, 'not_planned');
  assert.match(last(1), /### Closed before review\n\nClosed by @ed-one \(editor\) before review:\n\n> Outside the scope of The Intelligence Radar\.\n\nThank you for your interest in The Intelligence Radar, @newcomer\./);
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
  assert.match(last(1), /### Welcome to The Intelligence Radar\n\nWelcome, @newcomer: approved by @ed-one as a specialist reviewer[\s\S]*You will be asked to decide on contributions here/);
  assert.equal(gh.issues.get(1).state, 'closed');
  // a contributor already on the list applies to review
  const app2 = { title: '[Apply] Con Three', labels: ['apply-to-contribute'], body: formBody('apply.yml', { name: 'Con Three', experience: 'Model risk.', disclosure: 'None' }) };
  assert.equal(await opened('cont-three', app2), 'application');
  assert.equal(await says(2, 'ed-one', '/admit reviewer'), 'admitted as reviewer');
  assert.match(last(2), /^@cont-three is now a specialist reviewer on the \[list of people\]\([^)]*\), approved by @ed-one\./m);
  assert.equal(people(gh).find((p) => p.login === 'cont-three').role, 'reviewer');
  // a specialist reviewer who applies is told they are listed already
  assert.equal(await opened('rev-two', { ...app2, title: '[Apply] Rev Two' }), 'already listed');
});

test('one approval publishes a correction; the contributor cannot approve their own', async () => {
  const { gh, opened, says, state, last } = setUp();
  assert.equal(await opened('cont-three', correction()), 'in-review');
  assert.match(last(1), /### Received: your correction to IR-028\n\nThank you for contributing to The Intelligence Radar, @cont-three\./);
  assert.equal(await says(1, 'cont-three', '/approve'), 'refused');
  assert.equal(await says(1, 'stranger', '/approve'), 'refused');
  assert.equal(await says(1, 'rev-two', '/approve Checked against the announcement.'), 'approved');
  assert.match(last(1), /^### Approved$/m);
  assert.deepEqual(gh.labelsOf(1), ['approved', 'contribution', 'correction']);
  assert.equal(await says(1, 'rev-two', '/published 2026-12-01'), 'refused');
  assert.equal(await says(1, 'ed-one', '/published 2026-12-01'), 'published');
  assert.match(last(1), /### Published on TheIntelligenceRadar\.com\n\n@cont-three, your correction is now part of The Intelligence Radar, in release 2026-12-01\. See it on \[IR-028\]\(https:\/\/theintelligenceradar\.com\/entries\/ir-028\.html\)\.\n\nMarked published by @ed-one \(editor\)\. Thank you for contributing\./);
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
  const { gh, opened, edited, says, state, last } = setUp();
  await opened('cont-three', labelChange());
  await says(1, 'rev-two', '/approve');
  assert.equal(await says(1, 'ed-one', '/changes'), 'refused');
  assert.equal(await says(1, 'ed-one', '/changes Say which regulator.'), 'changes-requested');
  assert.match(last(1), /### Changes requested\n\n@ed-one \(editor\) asked for changes to version 1:\n\n> Say which regulator\.\n\n@cont-three, edit this issue to send a revised version/);
  assert.deepEqual(gh.labelsOf(1), ['changes-requested', 'contribution', 'label-change']);
  const body = gh.issues.get(1).body.replace('Where audit logging is in place.', 'Where audit logging is in place, as the EBA expects.');
  assert.equal(await edited(1, 'cont-three', { body }), 'in-review');
  assert.match(last(1), /### Version 2 received\n\nThank you, @cont-three\. Version 2 is with the reviewers again\. Approvals of earlier versions no longer count\./);
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
  assert.match(last(1), /### Approved, with an edit\n\nVersion 2: edited by @ed-one \(editor\)/);
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
  const { gh, opened, says, last } = setUp();
  await opened('cont-three', correction());
  assert.equal(await says(1, 'rev-two', '/withdraw'), 'refused');
  assert.equal(await says(1, 'rev-two', '/decline The entry already says this.'), 'declined');
  assert.match(last(1), /### Declined\n\nDeclined by @rev-two \(specialist reviewer\):\n\n> The entry already says this\.\n\nThank you for taking the time to contribute, @cont-three\. The decision is final, and a new contribution is always welcome\./);
  assert.equal(gh.issues.get(1).state, 'closed');
  assert.equal(gh.issues.get(1).state_reason, 'not_planned');
  await opened('cont-three', correction());
  assert.equal(await says(2, 'cont-three', '/withdraw Sent twice.'), 'withdrawn');
  assert.match(last(2), /### Withdrawn\n\nWithdrawn by @cont-three\.\n\n> Sent twice\.\n\nThank you for contributing\./);
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
  assert.match(last(1), /### A few details are missing\n\n@cont-three, this contribution cannot go to review yet\./);
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
  assert.match(last(1), /### Edited by a reviewer\n\nVersion 2: edited by @rev-two \(specialist reviewer\), which counts as their approval of it\. The issue now shows this version\.\n\n> Narrower conditions\.\n\n@cont-three, this version is now the one under review\./);
  assert.equal(state(1, 'label-change').current.payload.conditions, p.conditions);
  assert.match(gh.issues.get(1).body, /human sign-off/);
  const changedTarget = { ...p, target: { entry: 'IR-001' } };
  assert.equal(await says(1, 'ed-one', `/edit Other entry.\n\`\`\`json\n${JSON.stringify(changedTarget)}\n\`\`\``), 'refused');
  assert.equal(await says(1, 'ed-one', '/approve'), 'approved');
  // the issue's body is the current version, so a later sweep finds nothing new
  assert.equal(await desk.handle('workflow_dispatch', {}), 'PEOPLE.md rewritten. #1: approved');
});

test('a message to a contributor is a card: the header, a title, the text and the footer, with the markers last', async () => {
  const { gh, opened, says, last } = setUp();
  await opened('newcomer', correction());
  const receipt = last(1);
  assert.ok(receipt.startsWith(`${HEAD}\n\n### Received: your correction to IR-028\n\nThank you for contributing to The Intelligence Radar, @newcomer.\n\n`), receipt);
  assert.match(receipt, /\n\n\*\*What happens next:\*\* a specialist reviewer or an editor approves it, asks for changes or declines it, with the reason\. Approved contributions are published on TheIntelligenceRadar\.com in the next release\.\n\n/);
  // the footer is the card's last line; the notes for the reviewers follow a rule, and the marker comes last
  const [card, after] = receipt.split(`\n\n${FOOT}\n\n`);
  assert.ok(!card.includes('For review:') && after.startsWith('---\n\n**For the reviewers.** '), receipt);
  assert.match(after, /For review: @ed-one @rev-two\.\n\n<!-- radar-desk \{"e":"version",[^\n]*\} -->$/);
  assert.equal(await says(1, 'rev-two', '/approve Matches the announcement.'), 'approved');
  // the approval, followed by the short card that lists the newcomer
  const approval = gh.commentsOn(1).at(-2).body;
  assert.ok(approval.startsWith(`${HEAD}\n\n### Approved\n\nVersion 1 approved by @rev-two (specialist reviewer).\n\n> Matches the announcement.\n\n`
    + `@newcomer, your correction will be published on TheIntelligenceRadar.com in the next release, and you will hear here when it is.\n\n${FOOT}\n\n<!-- radar-desk {"e":"decision"`), approval);
});

test("notes for the reviewers follow the card after a rule: an approval that still needs an editor's", async () => {
  const { opened, says, last } = setUp();
  await opened('cont-three', labelChange());
  assert.equal(await says(1, 'rev-two', '/approve Evidence holds.'), 'in-review');
  const [card, notes] = last(1).split(`\n\n${FOOT}\n\n---\n\n`);
  assert.ok(card.startsWith(`${HEAD}\n\n### Approval recorded\n\nVersion 1 approved by @rev-two (specialist reviewer).\n\n> Evidence holds.\n\n`
    + "@cont-three, your label change still needs an editor's approval."), card);
  assert.match(notes, /^\*\*For the reviewers\.\*\* It needs an editor's approval\. Reviewers decide by commenting `\/approve`, `\/changes <what to change>` or `\/decline <reason>`\. For review: @ed-one\.\n\n<!-- radar-desk /);
  // once it is approved, the reviewers have nothing left to do: no notes
  assert.equal(await says(1, 'ed-one', '/approve'), 'approved');
  assert.ok(!last(1).includes('**For the reviewers.**') && !last(1).includes('\n---\n'), last(1));
});

test('refusals and changes to the list of people stay plain messages', async () => {
  const { gh, opened, edited, says, last } = setUp();
  await opened('cont-three', correction());
  assert.equal(await says(1, 'cont-three', '/approve'), 'refused');
  assert.match(last(1), /^@cont-three only the editors and specialist reviewers on the \[list of people\]\([^)]*\) decide on contributions\.$/);
  gh.user('outsider', 200);
  assert.equal(await edited(1, 'outsider', { body: gh.issues.get(1).body.replace('(AAIF)', '(the AAIF)') }), 'edit not taken');
  assert.match(last(1), /^The change made by @outsider was not taken as a new version\./);
  assert.equal(await says(1, 'ed-one', '/admit reviewer'), 'admitted as reviewer');
  assert.match(last(1), /^@cont-three is now a specialist reviewer on the \[list of people\]/);
  assert.equal(await says(1, 'ed-one', '/role @cont-three editor'), 'role editor');
  assert.match(last(1), /^@cont-three is now an editor \(changed by @ed-one\)\./);
  assert.equal(await says(1, 'ed-one', '/remove @cont-three Asked to leave.'), 'removed');
  assert.match(last(1), /^@cont-three is no longer on the list of people \(removed by @ed-one\)\./);
  assert.equal(gh.commentsOn(1).filter((c) => c.body.includes('message-header.png')).length, 1, 'only the receipt is a card');
});

test('the publisher app marks a contribution published for the editor it names, and gives no other command', async () => {
  const { gh, opened, says, state, last } = setUp();
  gh.user(PUBLISHER, 9001);
  await opened('newcomer', correction());
  await opened('cont-three', correction());
  await opened('cont-three', correction());
  for (const n of [1, 2, 3]) assert.equal(await says(n, 'rev-two', '/approve'), 'approved');
  // anything else from the app is ignored, with a short reply
  assert.match(await says(1, PUBLISHER, '/approve'), /^ignored/);
  assert.match(await says(1, PUBLISHER, '/published 2026-12-01'), /^ignored/);
  assert.equal(last(1), 'This comment was ignored: the publisher app may only give `/published <release> for @<editor>`.');
  // the person it names must be an editor on the list of people
  assert.equal(await says(1, PUBLISHER, '/published 2026-12-01 for @rev-two'), 'refused');
  assert.equal(last(1), '@rev-two only editors record publications.');
  assert.equal(state(1, 'correction').status, 'approved');
  // for an editor, it is as if they had commented /published themselves
  assert.equal(await says(1, PUBLISHER, '/published 2026-12-01 for @ed-one'), 'published');
  const ev = eventsOf(gh.commentsOn(1), BOT).find((e) => e.e === 'published');
  assert.deepEqual({ by: ev.by, by_id: ev.by_id, via: ev.via, release: ev.release }, { by: 'ed-one', by_id: 101, via: 'publisher-app', release: '2026-12-01' });
  assert.match(last(1), /^Marked published by @ed-one \(editor\)\. Thank you for contributing\.$/m);
  assert.equal(gh.issues.get(1).state_reason, 'completed');
  assert.deepEqual(gh.labelsOf(1), ['contribution', 'correction', 'published']);
  // anyone else who writes "for @someone" is judged by their own role
  assert.equal(await says(2, 'rev-two', '/published 2026-12-01 for @ed-one'), 'refused');
  assert.equal(last(2), '@rev-two only editors record publications.');
  assert.equal(await says(2, 'ed-one', '/published 2026-12-01 for @ed-four'), 'published');
  const ev2 = eventsOf(gh.commentsOn(2), BOT).find((e) => e.e === 'published');
  assert.deepEqual([ev2.by, ev2.by_id, 'via' in ev2], ['ed-one', 101, false]);
  // and so is an account with the app's name that is not an app
  gh.user(PUBLISHER, 9002, 'User');
  assert.equal(await says(3, PUBLISHER, '/published 2026-12-01 for @ed-one'), 'refused');
  assert.equal(state(3, 'correction').status, 'approved');
});

test('every marker carries by_id, the numeric GitHub id of whoever acted', async () => {
  const { gh, opened, edited, says, state } = setUp();
  const events = (n) => eventsOf(gh.commentsOn(n), BOT).filter((e) => e.e !== 'notice');
  const byIds = (n, e) => events(n).filter((x) => x.e === e).map((x) => [x.by, x.by_id]);
  // versions: the contributor's, a specialist reviewer's edit of the issue, and an editor's /edit
  await opened('cont-three', labelChange());
  const body = gh.issues.get(1).body.replace('Where audit logging is in place.', 'Where audit logging and human sign-off are in place.');
  assert.equal(await edited(1, 'rev-two', { body }), 'in-review');
  const p = structuredClone(state(1, 'label-change').current.payload);
  p.conditions = 'Where audit logging and human sign-off are in place, as the EBA expects.';
  assert.equal(await says(1, 'ed-one', `/edit Name the regulator.\n\`\`\`json\n${JSON.stringify(p)}\n\`\`\``), 'approved');
  assert.deepEqual(byIds(1, 'version'), [['cont-three', 103], ['rev-two', 102], ['ed-one', 101]]);
  // a decision, the listing it brings, and the publication
  await opened('newcomer', correction());
  assert.equal(await says(2, 'rev-two', '/approve'), 'approved');
  assert.deepEqual(byIds(2, 'decision'), [['rev-two', 102]]);
  assert.deepEqual(byIds(2, 'listed'), [['rev-two', 102]]);
  assert.equal(await says(2, 'ed-one', '/published 2026-12-01'), 'published');
  assert.deepEqual(byIds(2, 'published'), [['ed-one', 101]]);
  // the rest: an admission, a withdrawal, a declined application with the applicant's id, a role change, a removal and a closing
  assert.equal(await says(2, 'ed-one', '/admit reviewer'), 'admitted as reviewer');
  await opened('cont-three', correction());
  assert.equal(await says(3, 'cont-three', '/withdraw'), 'withdrawn');
  await opened('ed-four', { title: '[Apply] Ed Four', labels: ['apply-to-contribute'], body: formBody('apply.yml', { name: 'Ed Four', experience: 'Model risk.', disclosure: 'None' }) });
  assert.equal(await says(4, 'ed-one', '/decline Not now.'), 'application declined');
  assert.equal(events(4).find((e) => e.e === 'application-declined').id, 105);
  assert.equal(await says(4, 'ed-one', '/role @rev-two editor'), 'role editor');
  assert.equal(await says(4, 'ed-one', '/remove @cont-three Asked to leave.'), 'removed');
  await opened('cont-three', correction({ why: 'Too short' }));
  assert.equal(await says(5, 'ed-one', '/decline Outside the scope.'), 'closed before review');
  const all = [1, 2, 3, 4, 5].flatMap((n) => events(n));
  assert.deepEqual([...new Set(all.map((e) => e.e))].sort(),
    ['admitted', 'application-declined', 'closed', 'decision', 'listed', 'published', 'removed', 'role', 'version', 'withdrawn']);
  for (const e of all) assert.ok(Number.isInteger(e.by_id), JSON.stringify(e));
});
