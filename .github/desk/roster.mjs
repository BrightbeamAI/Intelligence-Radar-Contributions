// The list of people approved to contribute (people.json) and its public page (PEOPLE.md).
// Roles: contributor, reviewer (specialist reviewer) and editor. Reviewers and editors review.

export const ROLES = ['contributor', 'reviewer', 'editor'];
export const ROLE_NAMES = { contributor: 'Contributor', reviewer: 'Specialist reviewer', editor: 'Editor' };
export const canReview = (role) => role === 'reviewer' || role === 'editor';
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

  /** Add or change a person. Returns what changed: added, role, or nothing. */
  admit({ login, id = null, name, affiliation = '', role, areas = [], since, issue = null }) {
    if (!LOGIN.test(String(login))) throw new Error(`${login} is not a GitHub login.`);
    if (!ROLES.includes(role)) throw new Error(`The role must be one of ${ROLES.join(', ')}.`);
    const found = this.find(login, id);
    if (found) {
      if (found.role === role) return 'nothing';
      found.role = role;
      return 'role';
    }
    const person = { login, ...(id ? { id } : {}), name: String(name || login).trim(), role };
    if (affiliation) person.affiliation = String(affiliation).trim();
    person.areas = areas;
    person.since = since;
    if (issue) person.application = issue;
    this.people.push(person);
    return 'added';
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

/** PEOPLE.md: everyone on the list, editors first, with their GitHub picture. */
export function peoplePage(roster, repo) {
  const order = ['editor', 'reviewer', 'contributor'];
  const people = [...roster.people].sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role) || a.name.localeCompare(b.name));
  const L = [
    '# People',
    '',
    'The editors, specialist reviewers and contributors approved to contribute to [The Intelligence Radar](https://theintelligenceradar.com/).',
    `Contributions from these GitHub accounts go to review automatically. To join them, [apply to contribute](https://github.com/${repo}/issues/new?template=apply.yml).`,
    '',
  ];
  for (const role of order) {
    const group = people.filter((p) => p.role === role);
    if (!group.length) continue;
    L.push(`## ${ROLE_NAMES[role]}s`, '', '| | Name | Organisation | Since |', '|:-:|---|---|---|');
    for (const p of group) {
      L.push(`| <img src="https://github.com/${p.login}.png?size=80" width="40" height="40" alt=""> | **${cell(p.name)}** ([@${p.login}](https://github.com/${p.login})) | ${cell(p.affiliation)} | ${cell(p.since)} |`);
    }
    L.push('');
  }
  L.push('This page is written by the review desk from [people.json](people.json). Editors change it with `/admit`, `/role` and `/remove`; see [CONTRIBUTING.md](CONTRIBUTING.md).', '');
  return L.join('\n');
}
