// The review desk for The Intelligence Radar, run by GitHub Actions in the contributions repository.
// Anyone can contribute: it checks each contribution against the contribution rules and sends every
// complete one to review, takes the editors' and specialist reviewers' decisions as commands in comments,
// applies the review policy, lists a contributor on the list of people (people.json) once a contribution
// of theirs is approved, keeps each issue's labels in step, and records every event as a marker comment
// that the private CHAP recorder replays. Each marker carries by_id, the numeric GitHub id of whoever acted.
// Its messages to contributors and applicants are cards with the TheIntelligenceRadar.com header (Desk.card).
// The publisher app marks a release published for the editor who runs it: `/published <release> for @editor`.
// See community/SPEC.md in the editorial package.
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
const aRole = (role) => (role === 'editor' ? 'an editor' : `a ${roleName(role)}`);
// a card's first line: the TheIntelligenceRadar.com header, linked to the website
const HEADER = '<a href="https://theintelligenceradar.com/"><img src="https://raw.githubusercontent.com/BrightbeamAI/Intelligence-Radar-Contributions/main/assets/message-header.png" alt="TheIntelligenceRadar.com" width="480"></a>';
// each kind in a sentence ("your correction"), and the word that links it to the entry it targets ("your correction to IR-028")
const KIND_WORDS = { review: 'review', correction: 'correction', evidence: 'evidence', 'label-change': 'label change', 'new-entry': 'proposed new entry' };
const KIND_LINKS = { review: 'of', correction: 'to', evidence: 'for', 'label-change': 'for' };
const kindWord = (kind) => KIND_WORDS[kind] ?? kindName(kind).toLowerCase();
const receivedTitle = (kind, payload) => {
  const entry = payload?.target?.entry;
  return `Received: your ${kindWord(kind)}${entry && KIND_LINKS[kind] ? ` ${KIND_LINKS[kind]} ${entry}` : ''}`;
};
// the publisher app's one command, on behalf of an editor: `/published <release> for @login`
const PUBLISHED_FOR = /^(\S+)\s+for\s+@([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})(?![A-Za-z0-9-])/i;

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

  /** While a contribution is in review: what it needs, and how reviewers decide. */
  statusLine(st) {
    if (st.status === 'in-review') return `It needs ${waitingFor(st)}. Reviewers decide by commenting \`/approve\`, \`/changes <what to change>\` or \`/decline <reason>\`.`;
    return '';
  }

  // ---------------------------------------------------------------- messages: cards for contributors and applicants

  /**
   * A message to a contributor or an applicant, as a card: the header (left out of a short card), the title, the text
   * (a paragraph or a list of them) and the footer. Notes for the reviewers follow the card, after a rule.
   */
  card(title, text, { notes = '', short = false } = {}) {
    const footer = '<sub>[TheIntelligenceRadar.com](https://theintelligenceradar.com/) · a community-driven radar for technical leaders · '
      + `[Your contributions](${this.link('issues?q=is%3Aissue%20author%3A%40me')}) · [How contributions work](${this.link('blob/main/CONTRIBUTING.md')})</sub>`;
    const card = [short ? '' : HEADER, `### ${title}`, ...[text].flat(), footer].filter(Boolean).join('\n\n');
    return notes ? `${card}\n\n---\n\n**For the reviewers.** ${notes}` : card;
  }

  /** The notes for the reviewers while a contribution is in review: what it needs, and who is asked to review it. */
  reviewerNotes(st, author) {
    return [this.statusLine(st), this.reviewCall(st, author)].filter(Boolean).join(' ');
  }

  /** A version made by an editor or a specialist reviewer, by editing the issue or with /edit: it counts as their approval. */
  editCard(st, { by, role, author, reason = '', shown = false }) {
    const approved = st.status === 'approved';
    return this.card(approved ? 'Approved, with an edit' : 'Edited by a reviewer', [
      `Version ${st.current.n}: edited by @${by} (${roleName(role)}), which counts as their approval of it.${shown ? ' The issue now shows this version.' : ''}`,
      reason ? quote(reason) : '',
      approved ? `@${author}, it will be published on TheIntelligenceRadar.com in the next release, and you will hear here when it is.`
        : `@${author}, this version is now the one under review.`,
    ], { notes: this.reviewerNotes(st, author) });
  }

  // ---------------------------------------------------------------- who is told: @mentions, so that GitHub notifies them

  mentions(logins) {
    return [...new Set(logins)].map((l) => `@${l}`).join(' ');
  }

  editors(except = null) {
    return this.roster.people.filter((p) => p.role === 'editor' && !same(p.login, except)).map((p) => p.login);
  }

  /** Everyone who can review: editors first, then specialist reviewers. */
  panel(except = null) {
    const order = { editor: 0, reviewer: 1 };
    return this.roster.people.filter((p) => canReview(p.role) && !same(p.login, except))
      .sort((a, b) => order[a.role] - order[b.role]).map((p) => p.login);
  }

  /** The people asked to review now: an editor when an editor's approval is what is missing, else the panel; never the contributor or anyone who has approved this version. */
  reviewCall(st, author) {
    if (st.status !== 'in-review') return '';
    const a = st.assessment;
    const done = new Set((a?.counted ?? []).map((d) => String(d.person).toLowerCase()));
    const editorOnly = a?.editorMissing && a.missing === 1;
    const who = (editorOnly ? this.editors(author) : this.panel(author)).filter((l) => !done.has(l.toLowerCase())).slice(0, 20);
    if (who.length) return `For review: ${this.mentions(who)}.`;
    return editorOnly ? 'No other editor is on the list of people yet, so it waits until an editor is added.'
      : 'No one else on the list of people can review it yet, so it waits until an editor adds a reviewer.';
  }

  // ---------------------------------------------------------------- events

  async handle(name, event) {
    if (!this.roster) await this.loadRoster();
    if ((name === 'issues' || name === 'issue_comment') && event.issue?.pull_request) return 'a pull request';
    if (name === 'issues') return this.onIssue(event.issue, { action: event.action, sender: event.sender?.login, senderId: event.sender?.id ?? null });
    if (name === 'issue_comment') return event.action === 'created' ? this.onComment(event.issue, event.comment) : 'not a new comment';
    return this.sweep();
  }

  /** A contribution or application was opened, edited or reopened (or is checked again by a sweep). */
  async onIssue(issue, { action = 'sweep', sender = null, senderId = null } = {}) {
    const parsed = this.parse(issue);
    if (!parsed) return 'not a contribution';
    const { events } = await this.context(issue);
    if (parsed.kind === 'apply') return this.onApplication(issue, parsed, events);
    if (issue.state === 'closed') return 'closed';
    const kind = parsed.kind;
    const st = contributionState(events, this.config, kind);
    if (FINAL.includes(st.status)) return st.status;
    const author = issue.user?.login;
    // anyone can contribute: someone not on the list of people contributes as a contributor
    const listedRole = this.roster.role(author, issue.user?.id);
    const authorRole = listedRole ?? 'contributor';
    const payload = parsed.payload;
    const errors = [...validate(payload).errors];
    const dg = digest(payload);
    if (st.current?.digest === dg) {
      await this.labels(issue, kind, st.status);
      return st.status;
    }
    if (errors.length) {
      await this.labels(issue, kind, st.status === 'new' ? 'needs-info' : st.status, st.status === 'new' ? [] : ['needs-info']);
      await this.notice(issue, events, `needs-info:${short(JSON.stringify(errors))}`, this.card('A few details are missing', [
        `@${author}, this contribution cannot go to review yet. Edit the issue to fix the following; it is checked again automatically.`,
        errors.map((e) => `- ${e}`).join('\n'),
      ]));
      return 'needs information';
    }
    // whoever made the version: the contributor, or an editor or a specialist reviewer who edited the issue
    let by = author;
    let byId = issue.user?.id ?? null;
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
        const editorRole = this.roster.role(editor, senderId);
        if (!(canReview(editorRole) && st.status === 'in-review' && !hasApproved(st, editor))) {
          await this.notice(issue, events, `edit-refused:${dg.slice(7, 23)}`,
            `The change made by @${editor} was not taken as a new version. The contributor can revise a contribution, and editors and specialist reviewers can edit one while it is in review, before approving it. Version ${st.current.n} is still the one under review.`);
          return 'edit not taken';
        }
        by = editor;
        byId = senderId;
        role = editorRole;
        cause = 'edited';
      }
    }
    const n = st.versions.length + 1;
    const ev = { e: 'version', n, digest: dg, by, by_id: byId, role, cause, payload };
    const st2 = contributionState([...events, { ...ev, at: this.now().toISOString() }], this.config, kind);
    const notes = this.reviewerNotes(st2, author);
    let text;
    if (cause === 'submitted') {
      // someone not on the list yet joins it with their first approved contribution, unless they chose not to be credited
      const credit = listedRole ? ''
        : payload.credit?.public === false ? ' As you asked, you will not be credited publicly.'
          : ` Once a contribution of yours is approved, you join the [list of people](${this.link('blob/main/PEOPLE.md')}) as a contributor.`;
      text = this.card(receivedTitle(kind, payload), [
        `Thank you for contributing to The Intelligence Radar, @${author}.${listedRole ? ` You are on the list of people as ${aRole(listedRole)}.` : ''}`,
        `Your ${kindWord(kind)} is complete and now with the editors and specialist reviewers, who aim to decide within three working days. `
          + `Each decision will be posted here with its reason, and GitHub will let you know.${credit}`,
        '**What happens next:** a specialist reviewer or an editor approves it, asks for changes or declines it, with the reason. '
          + 'Approved contributions are published on TheIntelligenceRadar.com in the next release.',
      ], { notes });
    } else if (cause === 'revised') {
      text = this.card(`Version ${n} received`, `Thank you, @${author}. Version ${n} is with the reviewers again. Approvals of earlier versions no longer count.`, { notes });
    } else text = this.editCard(st2, { by, role, author });
    await this.say(issue, text, [ev]);
    await this.labels(issue, kind, st2.status);
    if (st2.status === 'approved') await this.credit(issue, st2.current.payload, by, byId);
    return st2.status;
  }

  async onApplication(issue, parsed, events) {
    await this.labels(issue, 'apply', null);
    if (issue.state === 'closed') return 'closed application';
    // a contributor on the list may apply to be a specialist reviewer; a specialist reviewer or an editor already decides on contributions
    const known = this.roster.find(issue.user?.login, issue.user?.id);
    if (known && canReview(known.role)) {
      await this.notice(issue, events, 'already-listed', `@${issue.user.login} is already on the [list of people](${this.link('blob/main/PEOPLE.md')}) as ${aRole(known.role)}.`);
      return 'already listed';
    }
    const eds = this.editors(issue.user?.login);
    await this.notice(issue, events, 'application-received', this.card('Application received',
      `Thank you for applying to be a specialist reviewer, @${issue.user?.login}. The editors read each application and reply here.`,
      { notes: eds.length ? `${this.mentions(eds)}: a new application to be a specialist reviewer. Approve it with \`/admit reviewer\` (or \`/admit editor\`), or answer with \`/decline <reason>\`.` : '' }));
    return 'application';
  }

  /** Put a person on the list of people, or change their role on it, and say so on the issue: as a card on an application. */
  async admit(issue, { login, id, name, affiliation = '', role, areas = [], actor, actorId = null, application }) {
    const before = this.roster.find(login, id);
    await this.changeRoster((roster) => {
      const outcome = roster.admit({ login, id, name, affiliation, role, areas, since: this.today(), issue: issue.number });
      return outcome === 'nothing' ? null : `Admit @${login} as ${roleName(role)} (#${issue.number})`;
    });
    const what = aRole(role);
    const reviews = canReview(role)
      ? 'You will be asked to decide on contributions here: comment `/approve`, `/changes <what to change>` or `/decline <reason>` on the issue, '
        + `or from your AI assistant with The Intelligence Radar's MCP server. [CONTRIBUTING.md](${this.link('blob/main/CONTRIBUTING.md')}) explains the review policy.`
      : 'Thank you for contributing to The Intelligence Radar.';
    const list = `[list of people](${this.link('blob/main/PEOPLE.md')})`;
    const text = `${before ? `@${login} is now ${what} on the ${list}, approved by @${actor}.` : `Welcome, @${login}: approved by @${actor} as ${what}, and now on the ${list}.`} ${reviews}`;
    await this.say(issue, application ? this.card('Welcome to The Intelligence Radar', text) : text,
      [{ e: 'admitted', login, id, role, by: actor, by_id: actorId, name }]);
    if (application) {
      await this.labels(issue, 'apply', null, ['admitted']);
      await this.gh.close(issue.number, 'completed');
    }
  }

  /** Once a contribution is approved, list its contributor on the list of people, as they asked to be credited. */
  async credit(issue, payload, actor, actorId = null) {
    const login = issue.user?.login;
    const id = issue.user?.id ?? null;
    if (!login || this.roster.find(login, id) || payload?.credit?.public === false) return false;
    const name = payload?.credit?.name || login;
    const listed = await this.changeRoster((roster) => (roster.admit({ login, id, name, affiliation: payload?.credit?.affiliation || '', role: 'contributor',
      since: this.today(), contribution: issue.number }) === 'added' ? `List @${login} as a contributor (#${issue.number})` : null));
    if (!listed) return false;
    // a short card, without the header: it follows the card that approved the contribution
    await this.say(issue, this.card('You are on the list of people',
      `Thank you, @${login}: with this contribution approved, you are now on the [list of people](${this.link('blob/main/PEOPLE.md')}) as a contributor.`, { short: true }),
      [{ e: 'listed', login, id, role: 'contributor', by: actor, by_id: actorId, name }]);
    return true;
  }

  // ---------------------------------------------------------------- commands

  /** True for a comment by the publisher app (config.publisher_bot): a GitHub App, so its account is a bot. */
  fromPublisher(user) {
    return Boolean(this.config.publisher_bot) && same(user?.login, this.config.publisher_bot) && user?.type === 'Bot';
  }

  async onComment(issue, comment) {
    if (same(comment.user?.login, this.bot)) return 'the desk itself';
    let cmd = parseCommand(comment.body);
    if (!cmd) return 'no command';
    let actor = comment.user.login;
    let actorId = comment.user.id ?? null;
    let via = null;
    // the publisher app marks a release published for the editor who runs it, as if that editor had commented
    // `/published <release>`; it gives no other command. Anyone else's "for @login" changes nothing: their own role decides.
    if (this.fromPublisher(comment.user)) {
      const named = cmd.name === 'published' ? cmd.args.match(PUBLISHED_FOR) : null;
      if (!named) {
        await this.say(issue, 'This comment was ignored: the publisher app may only give `/published <release> for @<editor>`.');
        return 'ignored: the publisher app gives only /published <release> for @editor';
      }
      const editor = this.roster.find(named[2]);
      actor = editor?.login ?? named[2];
      actorId = editor?.id ?? null;
      via = 'publisher-app';
      cmd = { ...cmd, args: named[1], text: named[1] };
    }
    const actorRole = this.roster.role(actor, actorId);
    const reply = async (text) => {
      await this.say(issue, `@${actor} ${text}`);
      return 'refused';
    };
    if (via && actorRole !== 'editor') return reply('only editors record publications.');
    if (cmd.name === 'role' || cmd.name === 'remove') return this.peopleCommand(issue, cmd, actor, actorRole, reply, actorId);
    const parsed = this.parse(issue);
    if (!parsed) return 'not a contribution';
    if (parsed.kind === 'apply') return this.applicationCommand(issue, parsed, cmd, actor, actorRole, reply, actorId);
    return this.contributionCommand(issue, parsed, cmd, actor, actorRole, reply, comment, { actorId, via });
  }

  async contributionCommand(issue, parsed, cmd, actor, actorRole, reply, comment, { actorId = null, via = null } = {}) {
    const kind = parsed.kind;
    const { events } = await this.context(issue);
    const st = contributionState(events, this.config, kind);
    const author = issue.user?.login;
    const at = this.now().toISOString();
    // an editor can list the contributor with a role straight from their contribution
    if (cmd.name === 'admit') {
      if (actorRole !== 'editor') return reply('only editors decide who is on the list of people.');
      const role = roleWord(cmd.args.split(/\s+/)[0] || 'contributor');
      if (!role) return reply('name the role: `/admit contributor`, `/admit reviewer` or `/admit editor`.');
      const listed = this.roster.find(author, issue.user?.id);
      if (listed?.role === role) return reply(`@${author} is already on the list of people as ${aRole(role)}.`);
      // the name shown on the list: the credit the person chose on this contribution, else their GitHub login
      const credit = parsed.payload?.credit ?? {};
      const shown = credit.public !== false;
      await this.admit(issue, { login: author, id: issue.user?.id, name: (shown && credit.name) || author, affiliation: (shown && credit.affiliation) || '',
        role, actor, actorId, application: false });
      return `admitted as ${role}`;
    }
    // a contribution that never became complete: an editor can close it, with the reason
    if (cmd.name === 'decline' && st.status === 'new') {
      if (actorRole !== 'editor') return reply('this contribution is not yet in review; an editor can close it with `/decline <reason>`.');
      if (!cmd.text) return reply('give the reason: `/decline <reason>`.');
      await this.say(issue, this.card('Closed before review', [`Closed by @${actor} (editor) before review:`, quote(cmd.text),
        `Thank you for your interest in The Intelligence Radar, @${author}.`]), [{ e: 'closed', by: actor, by_id: actorId, reason: cmd.text }]);
      await this.labels(issue, kind, null);
      await this.gh.close(issue.number, 'not_planned');
      return 'closed before review';
    }
    if (['approve', 'changes', 'decline'].includes(cmd.name)) {
      if (!canReview(actorRole)) return reply(`only the editors and specialist reviewers on the [list of people](${this.link('blob/main/PEOPLE.md')}) decide on contributions.`);
      if (same(actor, author)) return reply('you cannot review your own contribution.');
      if (st.status !== 'in-review') return reply(`this contribution is ${STATUS_WORDS[st.status]}, so it takes no decisions now.`);
      if (cmd.digest && !st.current.digest.startsWith(cmd.digest)) return reply(`it has changed since you read it: version ${st.current.n} is current. Read it again before deciding.`);
      if (cmd.name !== 'approve' && !cmd.text) return reply(`give the reason with the command: \`/${cmd.name} <reason>\`.`);
      if (cmd.name === 'approve' && hasApproved(st, actor)) return reply(`you have already approved version ${st.current.n}.`);
      const ev = { e: 'decision', d: cmd.name, by: actor, by_id: actorId, role: actorRole, n: st.current.n, digest: st.current.digest, reason: cmd.text, comment: comment.id };
      const st2 = contributionState([...events, { ...ev, at }], this.config, kind);
      const who = `@${actor} (${roleName(actorRole)})`;
      let text;
      if (cmd.name === 'approve') {
        // approved now, or an approval recorded while it still needs another (an editor's, for one)
        const approved = st2.status === 'approved';
        text = this.card(approved ? 'Approved' : 'Approval recorded', [
          `Version ${st.current.n} approved by ${who}.`,
          cmd.text ? quote(cmd.text) : '',
          approved ? `@${author}, your ${kindWord(kind)} will be published on TheIntelligenceRadar.com in the next release, and you will hear here when it is.`
            : `@${author}, your ${kindWord(kind)} still needs ${waitingFor(st2)}.`,
        ], { notes: this.reviewerNotes(st2, author) });
      } else if (cmd.name === 'changes') {
        text = this.card('Changes requested', [
          `${who} asked for changes to version ${st.current.n}:`,
          quote(cmd.text),
          `@${author}, edit this issue to send a revised version; it is checked again automatically. `
            + 'From an AI assistant, use revise_contribution in The Intelligence Radar\'s MCP server.',
        ]);
      } else {
        text = this.card('Declined', [`Declined by ${who}:`, quote(cmd.text),
          `Thank you for taking the time to contribute, @${author}. The decision is final, and a new contribution is always welcome.`]);
      }
      await this.say(issue, text, [ev]);
      await this.labels(issue, kind, st2.status);
      if (st2.status === 'declined') await this.gh.close(issue.number, 'not_planned');
      if (st2.status === 'approved') await this.credit(issue, st2.current.payload, actor, actorId);
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
      const ev = { e: 'version', n: st.versions.length + 1, digest: dg, by: actor, by_id: actorId, role: actorRole, cause: 'edited', reason: cmd.text, payload: edited, comment: comment.id };
      const st2 = contributionState([...events, { ...ev, at }], this.config, kind);
      await this.say(issue, this.editCard(st2, { by: actor, role: actorRole, author, reason: cmd.text, shown: true }), [ev]);
      await this.labels(issue, kind, st2.status);
      if (st2.status === 'approved') await this.credit(issue, st2.current.payload, actor, actorId);
      return st2.status;
    }
    if (cmd.name === 'withdraw') {
      if (!same(actor, author)) return reply('only the contributor can withdraw a contribution.');
      if (!OPEN.includes(st.status)) return reply(`this contribution is ${STATUS_WORDS[st.status]}; a contribution can be withdrawn only before a final decision.`);
      await this.say(issue, this.card('Withdrawn', [`Withdrawn by @${actor}.`, cmd.text ? quote(cmd.text) : '', 'Thank you for contributing.']),
        [{ e: 'withdrawn', by: actor, by_id: actorId, reason: cmd.text }]);
      await this.labels(issue, kind, 'withdrawn');
      await this.gh.close(issue.number, 'not_planned');
      return 'withdrawn';
    }
    if (cmd.name === 'published') {
      if (actorRole !== 'editor') return reply('only editors record publications.');
      if (st.status !== 'approved') return reply(`this contribution is ${STATUS_WORDS[st.status]}; only approved contributions are published.`);
      const release = cmd.args.split(/\s+/)[0];
      if (!release) return reply('name the release: `/published <release>`, for example `/published 2026-12-01`.');
      const entry = st.current.payload?.target?.entry;
      await this.say(issue, this.card('Published on TheIntelligenceRadar.com', [
        `@${author}, your ${kindWord(kind)} is now part of The Intelligence Radar, in release ${release}.`
          + (entry ? ` See it on [${entry}](https://theintelligenceradar.com/entries/${entry.toLowerCase()}.html).` : ''),
        `Marked published by @${actor} (editor). Thank you for contributing.`,
      ]), [{ e: 'published', by: actor, by_id: actorId, ...(via ? { via } : {}), release, n: st.current.n, digest: st.current.digest }]);
      await this.labels(issue, kind, 'published');
      await this.gh.close(issue.number, 'completed');
      return 'published';
    }
    return reply('that command applies to applications or people, not to a contribution.');
  }

  async applicationCommand(issue, parsed, cmd, actor, actorRole, reply, actorId = null) {
    if (!['admit', 'decline'].includes(cmd.name)) return reply('on an application, editors use `/admit reviewer`, `/admit editor` or `/decline <reason>`.');
    if (actorRole !== 'editor') return reply('only editors decide on applications.');
    const applicant = issue.user;
    if (cmd.name === 'decline') {
      if (!cmd.text) return reply('give the reason: `/decline <reason>`.');
      await this.say(issue, this.card('Application not approved', [`Not approved by @${actor} (editor):`, quote(cmd.text),
        `Thank you for your interest in The Intelligence Radar, @${applicant.login}.`]),
        [{ e: 'application-declined', login: applicant.login, id: applicant.id ?? null, by: actor, by_id: actorId, reason: cmd.text }]);
      await this.gh.close(issue.number, 'not_planned');
      return 'application declined';
    }
    // an application is to review: a bare /admit makes the applicant a specialist reviewer, and /admit editor an editor
    const role = roleWord(cmd.args.split(/\s+/)[0] || 'reviewer');
    if (!role) return reply('name the role: `/admit reviewer`, `/admit editor` or `/admit contributor`.');
    if (this.roster.find(applicant.login, applicant.id)?.role === role) {
      return reply(`@${applicant.login} is already on the list of people as ${aRole(role)}.`);
    }
    const app = parsed.application;
    await this.admit(issue, { login: applicant.login, id: applicant.id, name: app.name || applicant.login, affiliation: app.affiliation || '', role,
      areas: Array.isArray(app.areas) ? app.areas : [], actor, actorId, application: true });
    return `admitted as ${role}`;
  }

  async peopleCommand(issue, cmd, actor, actorRole, reply, actorId = null) {
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
      if (person.role === role) return reply(`@${person.login} is already ${aRole(role)}.`);
      await this.changeRoster((roster) => (roster.admit({ ...roster.find(login), role }) === 'role' ? `@${person.login} is now ${roleName(role)}` : null));
      await this.say(issue, `@${person.login} is now ${aRole(role)} (changed by @${actor}).`,
        [{ e: 'role', login: person.login, id: person.id ?? null, role, by: actor, by_id: actorId }]);
      return `role ${role}`;
    }
    const reason = rest.join(' ').trim() || cmd.text.replace(who, '').trim();
    if (!reason) return reply('give the reason: `/remove @login <reason>`.');
    if (person.role === 'editor' && editors.length === 1) return reply('the list must keep at least one editor.');
    await this.changeRoster((roster) => (roster.remove(login) ? `Remove @${person.login} from the list of people` : null));
    await this.say(issue, `@${person.login} is no longer on the list of people (removed by @${actor}).\n\n${quote(reason)}`,
      [{ e: 'removed', login: person.login, id: person.id ?? null, by: actor, by_id: actorId, reason }]);
    return 'removed';
  }

  // ---------------------------------------------------------------- sweeps

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
