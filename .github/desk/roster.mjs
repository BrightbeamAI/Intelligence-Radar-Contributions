// The list of people (people.json) and its public page (PEOPLE.md): the editors, the dimension leads, the specialist
// reviewers, and the contributors, each listed once a contribution of theirs is approved. Reviewers and editors review.
// A dimension lead keeps the role of specialist reviewer, or of editor, and holds `leads`: the dimensions they lead, each
// with the day they started ({ dimension, since }). The editors approve leads, as they approve specialist reviewers.

export const ROLES = ['contributor', 'reviewer', 'editor'];
export const ROLE_NAMES = { contributor: 'Contributor', reviewer: 'Specialist reviewer', editor: 'Editor' };
export const canReview = (role) => role === 'reviewer' || role === 'editor';
/** The dimensions a person leads: [{ dimension, since }]. */
export const leadsOf = (person) => (Array.isArray(person?.leads) ? person.leads : []);
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export class Roster {
  constructor(doc) {
    this.doc = doc && Array.isArray(doc.people) ? doc : { note: '', people: [] };
  }

  static parse(text) {
    return new Roster(JSON.parse(text));
  }

  get people() {
    return this.doc.people;
  }

  /** The person with this login, compared without regard to case, or by GitHub account id when both are known. */
  find(login, id = null) {
    const l = String(login ?? '').toLowerCase();
    return this.people.find((p) => (id && p.id && p.id === id) || p.login.toLowerCase() === l) ?? null;
  }

  role(login, id = null) {
    return this.find(login, id)?.role ?? null;
  }

  /** Add or change a person, and make them the lead of a dimension when `lead` names one. Returns what changed: added, role, lead, or nothing. */
  admit({ login, id = null, name, affiliation = '', role, areas = [], since, issue = null, contribution = null, lead = null }) {
    if (!LOGIN.test(String(login))) throw new Error(`${login} is not a GitHub login.`);
    if (!ROLES.includes(role)) throw new Error(`The role must be one of ${ROLES.join(', ')}.`);
    if (lead && !canReview(role)) throw new Error('A dimension lead is a specialist reviewer or an editor.');
    const found = this.find(login, id);
    if (found) {
      const changed = found.role === role ? 'nothing' : 'role';
      found.role = role;
      const led = lead ? this.lead(found, lead, since) : false;
      return changed === 'nothing' && led ? 'lead' : changed;
    }
    const person = { login, ...(id ? { id } : {}), name: String(name || login).trim(), role };
    if (affiliation) person.affiliation = String(affiliation).trim();
    person.areas = areas;
    if (lead) person.leads = [{ dimension: lead, since }];
    person.since = since;
    if (issue) person.application = issue;
    if (contribution) person.contribution = contribution; // the first approved contribution, for a contributor
    this.people.push(person);
    return 'added';
  }

  /** Make a person the lead of a dimension, from `since`. False when they lead it already. */
  lead(person, dimension, since) {
    const leads = leadsOf(person);
    if (leads.some((l) => l.dimension === dimension)) return false;
    person.leads = [...leads, { dimension, since }];
    return true;
  }

  /** End every lead a person holds. Returns the dimensions they led. */
  endLeads(person) {
    const ended = leadsOf(person).map((l) => l.dimension);
    delete person.leads;
    return ended;
  }

  /** The people who lead a dimension. */
  leadsFor(dimension) {
    return this.people.filter((p) => leadsOf(p).some((l) => l.dimension === dimension));
  }

  remove(login) {
    const found = this.find(login);
    if (!found) return null;
    this.doc.people = this.people.filter((p) => p !== found);
    return found;
  }

  text() {
    return `${JSON.stringify(this.doc, null, 1)}\n`;
  }
}

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** PEOPLE.md: everyone on the list, editors first, then the dimension leads in the order of the dimensions, with their GitHub picture. */
export function peoplePage(roster, repo, dimensions = []) {
  const byName = (a, b) => a.name.localeCompare(b.name);
  const picture = (p) => `<img src="https://github.com/${p.login}.png?size=80" width="40" height="40" alt="">`;
  const who = (p) => `**${cell(p.name)}** ([@${p.login}](https://github.com/${p.login}))`;
  const L = [
    '# People',
    '',
    'The editors, dimension leads, specialist reviewers and contributors of [The Intelligence Radar](https://theintelligenceradar.com/). '
      + 'Contributors are listed once a contribution of theirs is approved, unless they chose not to be credited.',
    '',
    // through www.github.com: a full page load opens the form, where a link inside GitHub would open a blank issue
    `Anyone can contribute with the [forms](https://github.com/${repo}/issues/new/choose) or from an AI assistant. Specialist reviewers decide on `
      + `contributions alongside the editors: to become one, [apply to be a specialist reviewer](https://www.github.com/${repo}/issues/new?template=apply.yml). `
      + `Each dimension has one lead, who looks after its entries and its reviews: to become one, [apply to lead a dimension](https://www.github.com/${repo}/issues/new?template=apply-lead.yml).`,
    '',
  ];
  const table = (title, people) => {
    if (!people.length) return;
    L.push(`## ${title}`, '', '| | Name | Organisation | Since |', '|:-:|---|---|---|');
    for (const p of people) L.push(`| ${picture(p)} | ${who(p)} | ${cell(p.affiliation)} | ${cell(p.since)} |`);
    L.push('');
  };
  table(`${ROLE_NAMES.editor}s`, roster.people.filter((p) => p.role === 'editor').sort(byName));
  // one row for each dimension led, in the order of the dimensions; an editor who leads a dimension is listed in both
  const rank = (d) => (dimensions.includes(d) ? dimensions.indexOf(d) : dimensions.length);
  const leads = roster.people.flatMap((p) => leadsOf(p).map((l) => ({ p, ...l })))
    .sort((a, b) => rank(a.dimension) - rank(b.dimension) || a.dimension.localeCompare(b.dimension) || byName(a.p, b.p));
  if (leads.length) {
    L.push('## Dimension leads', '', '| | Dimension | Name | Organisation | Since |', '|:-:|---|---|---|---|');
    for (const l of leads) L.push(`| ${picture(l.p)} | ${cell(l.dimension)} | ${who(l.p)} | ${cell(l.p.affiliation)} | ${cell(l.since)} |`);
    L.push('');
  }
  table(`${ROLE_NAMES.reviewer}s`, roster.people.filter((p) => p.role === 'reviewer' && !leadsOf(p).length).sort(byName));
  table(`${ROLE_NAMES.contributor}s`, roster.people.filter((p) => p.role === 'contributor').sort(byName));
  L.push('This page is written by the review desk from [people.json](people.json). Editors change it with `/admit`, `/role` and `/remove`; see [CONTRIBUTING.md](CONTRIBUTING.md).', '');
  return L.join('\n');
}
