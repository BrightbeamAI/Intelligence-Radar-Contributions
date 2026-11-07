// The review desk for The Intelligence Radar, run by GitHub Actions in the contributions repository.
// It checks every contribution against the list of people (people.json) and the contribution rules,
// takes the editors' and specialist reviewers' decisions as commands in comments, applies the review
// policy, keeps each issue's labels in step, and records every event as a marker comment that the
// private CHAP recorder replays. See community/SPEC.md in the editorial package.
import { createHash } from 'node:crypto';
import { canonical, digest, issueSections, kindName, normalise, payloadFromIssue, renderIssue, validate } from './lib/contribution.mjs';
import { canReview, peoplePage, Roster, ROLE_NAMES } from './roster.mjs';
import { contributionState, eventsOf, FINAL, hasApproved, marker, noticesOf, OPEN, waitingFor } from './state.mjs';

const STATUS_LABELS = ['in-review', 'changes-requested', 'approved', 'published', 'declined', 'withdrawn', 'needs-info', 'needs-approval'];
const short = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const quote = (text) => String(text).trim().split('\n').map((l) => `> ${l}`).join('\n');
const roleName = (role) => (ROLE_NAMES[role] ?? role).toLowerCase();
const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
const labelNames = (issue) => (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
const STATUS_WORDS = { new: 'not yet in review', 'in-review': 'in review', 'changes-requested': 'waiting for changes', approved: 'approved', declined: 'declined', withdrawn: 'withdrawn', published: 'published' };

/** A command on the first line of a comment: /approve, /changes, /decline, /edit, /withdraw, /published, /admit, /role, /remove. */
export function parseCommand(body) {
  const first = String(body ?? '').replace(/\r\n?/g, '\n').trim().split('\n')[0] ?? '';
  const m = first.match(/^\/(approve|changes|decline|edit|withdraw|published|admit|role|remove)\b\s*(.*)$/i);
  if (!m) return null;
  const rest = String(body).replace(/\r\n?/g, '\n').trim().slice(first.length).trim();
  let args = m[2].trim();
  let digestPrefix = null;
  const d = args.match(/^(sha256:[0-9a-f]{8,64})\b\s*(.*)$/);
  if (d) {
    digestPrefix = d[1];
    args = d[2];
  }
  const block = rest.match(/(`{3,})json\n([\s\S]*?)\n\1/);
  const text = [args, block ? rest.replace(block[0], '') : rest].filter(Boolean).join('\n').trim();
  return { name: m[1].toLowerCase(), args, text, digest: digestPrefix, json: block ? block[2] : null };
}

export class Desk {
  constructor({ gh, config, forms, now = () => new Date(), log = () => {} }) {
    this.gh = gh;
    this.config = config;
    this.forms = forms;
    this.now = now;
    this.log = log;
    this.bot = config.desk_bot || 'github-actions[bot]';
    this.repo = gh.repo;
    this.roster = null;
  }

  link(path) {
    return `https://github.com/${this.repo}/${path}`;
  }

  /** An issue form. Through www.github.com: a full page load opens the form, where a link inside GitHub opens a blank issue. */
  form(file) {
    return `https://www.github.com/${this.repo}/issues/new?template=${file}`;
  }

  today() {
    return this.now().toISOString().slice(0, 10);
  }

  async loadRoster() {
    const f = await this.gh.file('people.json');
    this.rosterSha = f?.sha ?? null;
    this.roster = f ? Roster.parse(f.text) : new Roster(null);
    return this.roster;
  }

  /** Change the list of people and its page, retrying on a concurrent change. `change` returns a commit message, or null for no change. */
  async changeRoster(change) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await this.loadRoster();
      const message = change(this.roster);
      if (!message) return false;
      try {
        await this.gh.putFile('people.json', this.roster.text(), message, this.rosterSha);
      } catch (err) {
        if (err.status === 409 || err.status === 422) continue;
        throw err;
      }
      await this.writePeoplePage(message);
      return true;
    }
    throw new Error('The list of people kept changing; try the command again.');
  }

  async writePeoplePage(message = 'Update the list of people') {
    const page = peoplePage(this.roster, this.repo);
    const f = await this.gh.file('PEOPLE.md');
    if (f?.text === page) return false;
    await this.gh.putFile('PEOPLE.md', page, message, f?.sha);
    return true;
  }

  // ---------------------------------------------------------------- reading issues

  /** The form an issue was opened from, or null when it is not a contribution or an application. */
  parse(issue) {
    const labels = labelNames(issue);
    const title = String(issue.title ?? '');
    const byLabel = labels.includes('contribution') || labels.includes('apply-to-contribute');
    const byTitle = this.forms.forms.some((f) => title.startsWith(f.title.trim()));
    const headings = Object.keys(issueSections(issue.body));
    const byFields = this.forms.forms.some((f) => f.fields.filter((x) => headings.includes(x.label)).length >= 3);
    if (!byLabel && !byTitle && !byFields) return null;
    const parsed = payloadFromIssue({ title, body: issue.body, labels }, this.forms);
    return parsed.kind ? parsed : null;
  }

  async context(issue) {
    const comments = await this.gh.comments(issue.number);
    return { comments, events: eventsOf(comments, this.bot) };
  }

  async say(issue, text, events = []) {
    const body = [text, ...events.map(marker)].join('\n\n');
    await this.gh.comment(issue.number, body);
  }

  /** A notice given once per key on an issue. */
  async notice(issue, events, key, text) {
    if (noticesOf(events).has(key)) return false;
    await this.say(issue, text, [{ e: 'notice', key }]);
    return true;
  }

  async labels(issue, kind, status, extra = []) {
    const want = [];
    if (kind && kind !== 'apply') want.push('contribution', kind);
    if (kind === 'apply') want.push('apply-to-contribute');
    if (status && STATUS_LABELS.includes(status)) want.push(status);
    want.push(...extra);
    const issueNow = { ...issue, labels: issue.labels };
    issue.labels = await this.gh.setLabels(issueNow, [...new Set(want)], STATUS_LABELS, this.config.labels ?? {});
  }

  statusLine(st) {
    if (st.status === 'approved') return '**Approved.** It will be published on TheIntelligenceRadar.com with the next publication.';
    if (st.status === 'in-review') return `It needs ${waitingFor(st)}. Reviewers decide by commenting \`/approve\`, \`/changes <what to change>\` or \`/decline <reason>\`.`;
    return '';
  }

  // ---------------------------------------------------------------- events

  async handle(name, event) {
    if (!this.roster) await this.loadRoster();
    if ((name === 'issues' || name === 'issue_comment') && event.issue?.pull_request) return 'a pull request';
    if (name === 'issues') return this.onIssue(event.issue, { action: event.action, sender: event.sender?.login });
    if (name === 'issue_comment') return event.action === 'created' ? this.onComment(event.issue, event.comment) : 'not a new comment';
    return this.sweep();
  }

  /** A contribution or application was opened, edited or reopened (or is checked again by a sweep). */
  async onIssue(issue, { action = 'sweep', sender = null } = {}) {
    const parsed = this.parse(issue);
    if (!parsed) return 'not a contribution';
    const { events } = await this.context(issue);
    if (parsed.kind === 'apply') return this.onApplication(issue, parsed, events);
    if (issue.state === 'closed') return 'closed';
    const kind = parsed.kind;
    const st = contributionState(events, this.config, kind);
    if (FINAL.includes(st.status)) return st.status;
    const author = issue.user?.login;
    const authorRole = this.roster.role(author, issue.user?.id);
    if (!authorRole) {
      await this.labels(issue, kind, 'needs-approval');
      await this.notice(issue, events, 'needs-approval',
        `Thank you, @${author}. Contributions go to review only from the people on the [list of people](${this.link('blob/main/PEOPLE.md')}), and this account is not on it yet. `
        + `To apply, open [Apply to contribute](${this.form('apply.yml')}). Once an editor approves the application, this issue goes to review automatically.`);
      return 'needs approval';
    }
    const payload = parsed.payload;
    const errors = [...validate(payload).errors];
    const dg = digest(payload);
    if (st.current?.digest === dg) {
      await this.labels(issue, kind, st.status);
      return st.status;
    }
    if (errors.length) {
      await this.labels(issue, kind, st.status === 'new' ? 'needs-info' : st.status, st.status === 'new' ? [] : ['needs-info']);
      await this.notice(issue, events, `needs-info:${short(JSON.stringify(errors))}`,
        'This contribution cannot go to review yet. Edit the issue to fix the following; it is checked again automatically.\n\n'
        + errors.map((e) => `- ${e}`).join('\n'));
      return 'needs information';
    }
    let by = author;
    let role = authorRole;
    let cause = 'submitted';
    if (st.current) {
      const editor = action === 'edited' && sender ? sender : author;
      if (st.status === 'approved') {
        await this.notice(issue, events, `locked:${dg.slice(7, 23)}`,
          `This contribution is approved, so changes to the issue are no longer taken: version ${st.current.n}, as approved, is the one that will be published. To change it further, open a new contribution.`);
        return 'approved; edit not taken';
      }
      if (same(editor, author)) cause = 'revised';
      else {
        const editorRole = this.roster.role(editor);
        if (!(canReview(editorRole) && st.status === 'in-review' && !hasApproved(st, editor))) {
          await this.notice(issue, events, `edit-refused:${dg.slice(7, 23)}`,
            `The change made by @${editor} was not taken as a new version. The contributor can revise a contribution, and editors and specialist reviewers can edit one while it is in review, before approving it. Version ${st.current.n} is still the one under review.`);
          return 'edit not taken';
        }
        by = editor;
        role = editorRole;
        cause = 'edited';
      }
    }
    const n = st.versions.length + 1;
    const ev = { e: 'version', n, digest: dg, by, role, cause, payload };
    const st2 = contributionState([...events, { ...ev, at: this.now().toISOString() }], this.config, kind);
    const head = {
      submitted: `Received: ${kindName(kind).toLowerCase()} from @${author}, on the list of people as ${roleName(authorRole) === 'editor' ? 'an editor' : `a ${roleName(authorRole)}`}. It is complete, so it is now with the editors and specialist reviewers, and each decision will be posted here with its reason.`,
      revised: `Version ${n} received from @${author}. Approvals of earlier versions no longer count.`,
      edited: `Version ${n}: edited by @${by} (${roleName(role)}), which counts as their approval of it.`,
    }[cause];
    await this.say(issue, [head, this.statusLine(st2)].filter(Boolean).join('\n\n'), [ev]);
    await this.labels(issue, kind, st2.status);
    return st2.status;
  }

  async onApplication(issue, parsed, events) {
    await this.labels(issue, 'apply', null);
    if (issue.state === 'closed') return 'closed application';
    const known = this.roster.find(issue.user?.login, issue.user?.id);
    if (known) {
      await this.notice(issue, events, 'already-listed', `@${issue.user.login} is already on the [list of people](${this.link('blob/main/PEOPLE.md')}) as ${roleName(known.role) === 'editor' ? 'an editor' : `a ${roleName(known.role)}`}.`);
      return 'already listed';
    }
    await this.notice(issue, events, 'application-received',
      'Thank you for applying. The editors read each application and reply here. An editor approves it by commenting `/admit contributor` or `/admit reviewer`.');
    return 'application';
  }

  // ---------------------------------------------------------------- commands

  async onComment(issue, comment) {
    if (same(comment.user?.login, this.bot)) return 'the desk itself';
    const cmd = parseCommand(comment.body);
    if (!cmd) return 'no command';
    const actor = comment.user.login;
    const actorRole = this.roster.role(actor, comment.user.id);
    const reply = async (text) => {
      await this.say(issue, `@${actor} ${text}`);
      return 'refused';
    };
    if (cmd.name === 'role' || cmd.name === 'remove') return this.peopleCommand(issue, cmd, actor, actorRole, reply);
    const parsed = this.parse(issue);
    if (!parsed) return 'not a contribution';
    if (parsed.kind === 'apply') return this.applicationCommand(issue, parsed, cmd, actor, actorRole, reply);
    return this.contributionCommand(issue, parsed, cmd, actor, actorRole, reply, comment);
  }

  async contributionCommand(issue, parsed, cmd, actor, actorRole, reply, comment) {
    const kind = parsed.kind;
    const { events } = await this.context(issue);
    const st = contributionState(events, this.config, kind);
    const author = issue.user?.login;
    const at = this.now().toISOString();
    if (['approve', 'changes', 'decline'].includes(cmd.name)) {
      if (!canReview(actorRole)) return reply(`only the editors and specialist reviewers on the [list of people](${this.link('blob/main/PEOPLE.md')}) decide on contributions.`);
      if (same(actor, author)) return reply('you cannot review your own contribution.');
      if (st.status !== 'in-review') return reply(`this contribution is ${STATUS_WORDS[st.status]}, so it takes no decisions now.`);
      if (cmd.digest && !st.current.digest.startsWith(cmd.digest)) return reply(`it has changed since you read it: version ${st.current.n} is current. Read it again before deciding.`);
      if (cmd.name !== 'approve' && !cmd.text) return reply(`give the reason with the command: \`/${cmd.name} <reason>\`.`);
      if (cmd.name === 'approve' && hasApproved(st, actor)) return reply(`you have already approved version ${st.current.n}.`);
      const ev = { e: 'decision', d: cmd.name, by: actor, role: actorRole, n: st.current.n, digest: st.current.digest, reason: cmd.text, comment: comment.id };
      const st2 = contributionState([...events, { ...ev, at }], this.config, kind);
      const who = `@${actor} (${roleName(actorRole)})`;
      let text;
      if (cmd.name === 'approve') text = [`Version ${st.current.n} approved by ${who}.`, cmd.text ? quote(cmd.text) : '', this.statusLine(st2)].filter(Boolean).join('\n\n');
      else if (cmd.name === 'changes') {
        text = `${who} asked for changes to version ${st.current.n}:\n\n${quote(cmd.text)}\n\n@${author}, edit this issue to send a revised version; it is checked again automatically. `
          + 'From an AI assistant, use revise_contribution in The Intelligence Radar\'s MCP server.';
      } else text = `Declined by ${who}:\n\n${quote(cmd.text)}\n\nThank you for taking the time to contribute.`;
      await this.say(issue, text, [ev]);
      await this.labels(issue, kind, st2.status);
      if (st2.status === 'declined') await this.gh.close(issue.number, 'not_planned');
      return st2.status;
    }
    if (cmd.name === 'edit') {
      if (!canReview(actorRole)) return reply(`only the editors and specialist reviewers on the [list of people](${this.link('blob/main/PEOPLE.md')}) edit contributions.`);
      if (same(actor, author)) return reply('to change your own contribution, edit the issue.');
      if (st.status !== 'in-review') return reply(`this contribution is ${STATUS_WORDS[st.status]}; it can be edited only while in review.`);
      if (cmd.digest && !st.current.digest.startsWith(cmd.digest)) return reply(`it has changed since you read it: version ${st.current.n} is current. Read it again before editing.`);
      if (hasApproved(st, actor)) return reply(`you have already approved version ${st.current.n}; ask for changes instead.`);
      if (!cmd.text) return reply('give the reason for the edit on the command line: `/edit <reason>`, then the edited contribution in a ```json block.');
      let edited;
      try {
        edited = normalise(JSON.parse(cmd.json ?? ''));
      } catch {
        return reply('put the whole edited contribution, as JSON, in a ```json block under the command.');
      }
      const before = st.current.payload;
      const kept = ['kind', 'target', 'credit', 'disclosure'].filter((k) => canonical(edited[k] ?? null) !== canonical(before[k] ?? null));
      if (kept.length) return reply(`an edit keeps the contribution's ${kept.join(', ')}; it changed ${kept.length === 1 ? 'it' : 'them'}.`);
      if (before.base && !edited.base) edited.base = before.base;
      const errors = validate(edited).errors;
      if (errors.length) return reply(`the edited contribution is not valid:\n\n${errors.map((e) => `- ${e}`).join('\n')}`);
      const dg = digest(edited);
      if (dg === st.current.digest) return reply('the edit changes nothing.');
      const issueNow = renderIssue(edited, this.forms);
      await this.gh.updateIssue(issue.number, { title: issueNow.title, body: issueNow.body });
      const ev = { e: 'version', n: st.versions.length + 1, digest: dg, by: actor, role: actorRole, cause: 'edited', reason: cmd.text, payload: edited, comment: comment.id };
      const st2 = contributionState([...events, { ...ev, at }], this.config, kind);
      await this.say(issue, [`Version ${ev.n}: edited by @${actor} (${roleName(actorRole)}), which counts as their approval of it. The issue now shows this version.`,
        quote(cmd.text), this.statusLine(st2)].filter(Boolean).join('\n\n'), [ev]);
      await this.labels(issue, kind, st2.status);
      return st2.status;
    }
    if (cmd.name === 'withdraw') {
      if (!same(actor, author)) return reply('only the contributor can withdraw a contribution.');
      if (!OPEN.includes(st.status)) return reply(`this contribution is ${STATUS_WORDS[st.status]}; a contribution can be withdrawn only before a final decision.`);
      await this.say(issue, `Withdrawn by @${actor}.${cmd.text ? `\n\n${quote(cmd.text)}` : ''}`, [{ e: 'withdrawn', by: actor, reason: cmd.text }]);
      await this.labels(issue, kind, 'withdrawn');
      await this.gh.close(issue.number, 'not_planned');
      return 'withdrawn';
    }
    if (cmd.name === 'published') {
      if (actorRole !== 'editor') return reply('only editors record publications.');
      if (st.status !== 'approved') return reply(`this contribution is ${STATUS_WORDS[st.status]}; only approved contributions are published.`);
      const release = cmd.args.split(/\s+/)[0];
      if (!release) return reply('name the release: `/published <release>`, for example `/published 2026-12-01`.');
      await this.say(issue, `Published on TheIntelligenceRadar.com in release ${release}. Thank you for contributing.`,
        [{ e: 'published', by: actor, release, n: st.current.n, digest: st.current.digest }]);
      await this.labels(issue, kind, 'published');
      await this.gh.close(issue.number, 'completed');
      return 'published';
    }
    return reply('that command applies to applications or people, not to a contribution.');
  }

  async applicationCommand(issue, parsed, cmd, actor, actorRole, reply) {
    if (!['admit', 'decline'].includes(cmd.name)) return reply('on an application, editors use `/admit contributor`, `/admit reviewer` or `/decline <reason>`.');
    if (actorRole !== 'editor') return reply('only editors decide on applications.');
    const applicant = issue.user;
    if (cmd.name === 'decline') {
      if (!cmd.text) return reply('give the reason: `/decline <reason>`.');
      await this.say(issue, `Not approved by @${actor} (editor):\n\n${quote(cmd.text)}\n\nThank you for your interest in The Intelligence Radar.`,
        [{ e: 'application-declined', login: applicant.login, by: actor, reason: cmd.text }]);
      await this.gh.close(issue.number, 'not_planned');
      return 'application declined';
    }
    const role = roleWord(cmd.args.split(/\s+/)[0] || (/reviewer/i.test(parsed.application.role ?? '') ? 'reviewer' : 'contributor'));
    if (!role) return reply('name the role: `/admit contributor`, `/admit reviewer` or `/admit editor`.');
    const app = parsed.application;
    const areas = Array.isArray(app.areas) ? app.areas : [];
    let outcome = 'nothing';
    await this.changeRoster((roster) => {
      outcome = roster.admit({ login: applicant.login, id: applicant.id, name: app.name, affiliation: app.affiliation, role, areas, since: this.today(), issue: issue.number });
      return outcome === 'nothing' ? null : `Admit @${applicant.login} as ${roleName(role)} (#${issue.number})`;
    });
    const what = role === 'editor' ? 'an editor' : `a ${roleName(role)}`;
    await this.say(issue,
      `Welcome, @${applicant.login}: approved by @${actor} as ${what}, and now on the [list of people](${this.link('blob/main/PEOPLE.md')}). `
      + `Contribute with the [forms](${this.link('issues/new/choose')}) or from your AI assistant with The Intelligence Radar's MCP server; everything you send is checked against the list automatically.`,
      [{ e: 'admitted', login: applicant.login, id: applicant.id, role, by: actor, name: app.name || applicant.login }]);
    await this.labels(issue, 'apply', null, ['admitted']);
    await this.gh.close(issue.number, 'completed');
    await this.recheckAuthor(applicant.login);
    return `admitted as ${role}`;
  }

  async peopleCommand(issue, cmd, actor, actorRole, reply) {
    if (actorRole !== 'editor') return reply('only editors change the list of people.');
    const [who, ...rest] = cmd.args.split(/\s+/);
    const login = String(who ?? '').replace(/^@/, '');
    const person = this.roster.find(login);
    if (!person) return reply(`@${login || '…'} is not on the list of people.`);
    const editors = this.roster.people.filter((p) => p.role === 'editor');
    if (cmd.name === 'role') {
      const role = roleWord(rest[0]);
      if (!role) return reply('name the role: `/role @login contributor`, `reviewer` or `editor`.');
      if (person.role === 'editor' && role !== 'editor' && editors.length === 1) return reply('the list must keep at least one editor.');
      if (person.role === role) return reply(`@${person.login} is already ${role === 'editor' ? 'an editor' : `a ${roleName(role)}`}.`);
      await this.changeRoster((roster) => (roster.admit({ ...roster.find(login), role }) === 'role' ? `@${person.login} is now ${roleName(role)}` : null));
      await this.say(issue, `@${person.login} is now ${role === 'editor' ? 'an editor' : `a ${roleName(role)}`} (changed by @${actor}).`,
        [{ e: 'role', login: person.login, id: person.id ?? null, role, by: actor }]);
      return `role ${role}`;
    }
    const reason = rest.join(' ').trim() || cmd.text.replace(who, '').trim();
    if (!reason) return reply('give the reason: `/remove @login <reason>`.');
    if (person.role === 'editor' && editors.length === 1) return reply('the list must keep at least one editor.');
    await this.changeRoster((roster) => (roster.remove(login) ? `Remove @${person.login} from the list of people` : null));
    await this.say(issue, `@${person.login} is no longer on the list of people (removed by @${actor}).\n\n${quote(reason)}`,
      [{ e: 'removed', login: person.login, id: person.id ?? null, by: actor, reason }]);
    return 'removed';
  }

  // ---------------------------------------------------------------- sweeps

  async recheckAuthor(login) {
    const issues = await this.gh.openIssues(`&creator=${encodeURIComponent(login)}`);
    for (const issue of issues) {
      if (!issue.pull_request && labelNames(issue).includes('needs-approval')) await this.onIssue(issue, { action: 'sweep' });
    }
  }

  /** After the list of people changes by hand, or on request: rewrite PEOPLE.md and check every open contribution again. */
  async sweep() {
    await this.loadRoster();
    const wrote = await this.writePeoplePage();
    const out = [];
    for (const issue of await this.gh.openIssues()) {
      if (issue.pull_request) continue;
      try {
        out.push(`#${issue.number}: ${await this.onIssue(issue, { action: 'sweep' })}`);
      } catch (err) {
        out.push(`#${issue.number}: ${err.message}`);
      }
    }
    return `${wrote ? 'PEOPLE.md rewritten. ' : ''}${out.join('; ')}`;
  }
}

function roleWord(word) {
  const w = String(word ?? '').toLowerCase();
  if (w === 'contributor') return 'contributor';
  if (w === 'reviewer' || w === 'specialist' || w === 'specialist-reviewer') return 'reviewer';
  if (w === 'editor') return 'editor';
  return null;
}
