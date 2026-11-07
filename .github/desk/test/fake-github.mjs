// A small in-memory GitHub for the review desk's tests: issues, comments, labels, files and users,
// behind a fetch() that answers the REST paths the desk uses.
import { createHash } from 'node:crypto';

const sha = (text) => createHash('sha1').update(text).digest('hex');

export class FakeGitHub {
  constructor(repo, { bot = 'github-actions[bot]' } = {}) {
    this.repo = repo;
    this.bot = bot;
    this.issues = new Map();
    this.comments = [];
    this.labels = new Map();
    this.files = new Map();
    this.users = new Map();
    this.nextComment = 1000;
    this.clock = Date.parse('2026-11-08T09:00:00Z');
    this.fetch = this.fetch.bind(this);
  }

  tick() {
    this.clock += 60_000;
    return new Date(this.clock).toISOString();
  }

  user(login, id) {
    const u = { login, id, type: login.endsWith('[bot]') ? 'Bot' : 'User' };
    this.users.set(login.toLowerCase(), u);
    return u;
  }

  setFile(path, text) {
    this.files.set(path, { text, sha: sha(text) });
  }

  openIssue(login, { title, body, labels = [] }) {
    const n = this.issues.size + 1;
    const issue = { number: n, title, body, labels: labels.map((name) => ({ name })), state: 'open', state_reason: null, user: this.users.get(login.toLowerCase()), created_at: this.tick() };
    this.issues.set(n, issue);
    return structuredClone(issue);
  }

  editIssue(n, changes) {
    Object.assign(this.issues.get(n), changes);
    return structuredClone(this.issues.get(n));
  }

  addComment(n, login, body) {
    const c = { id: this.nextComment++, body, user: this.users.get(login.toLowerCase()) ?? this.user(login, 1), created_at: this.tick() };
    this.comments.push({ ...c, issue: n });
    return structuredClone(c);
  }

  commentsOn(n) {
    return this.comments.filter((c) => c.issue === n);
  }

  labelsOf(n) {
    return this.issues.get(n).labels.map((l) => l.name).sort();
  }

  async fetch(url, { method = 'GET', body } = {}) {
    const u = new URL(url);
    const path = u.pathname;
    const data = body ? JSON.parse(body) : undefined;
    const ok = (json, status = 200) => ({ ok: true, status, json: async () => json, text: async () => JSON.stringify(json) });
    const fail = (status, message = '') => ({ ok: false, status, json: async () => ({ message }), text: async () => message });
    const base = `/repos/${this.repo}`;
    let m;
    if ((m = path.match(/^\/users\/([^/]+)$/))) {
      const user = this.users.get(decodeURIComponent(m[1]).toLowerCase());
      return user ? ok(user) : fail(404);
    }
    if (!path.startsWith(base)) return fail(404);
    const rest = path.slice(base.length);
    const page = Number(u.searchParams.get('page') ?? 1);
    const per = Number(u.searchParams.get('per_page') ?? 30);
    const paged = (list) => ok(list.slice((page - 1) * per, page * per));
    if ((m = rest.match(/^\/contents\/(.+)$/))) {
      const name = decodeURIComponent(m[1]);
      const f = this.files.get(name);
      if (method === 'GET') return f ? ok({ sha: f.sha, content: Buffer.from(f.text).toString('base64') }) : fail(404);
      if (method === 'PUT') {
        if ((f && data.sha !== f.sha) || (!f && data.sha)) return fail(409, 'sha mismatch');
        this.setFile(name, Buffer.from(data.content, 'base64').toString('utf8'));
        return ok({ content: { sha: this.files.get(name).sha } }, f ? 200 : 201);
      }
    }
    if (rest === '/labels') {
      if (method === 'GET') return paged([...this.labels.keys()].map((name) => ({ name })));
      this.labels.set(data.name, data.color);
      return ok({ name: data.name }, 201);
    }
    if (rest === '/issues' && method === 'GET') {
      const state = u.searchParams.get('state') ?? 'open';
      let list = [...this.issues.values()].filter((i) => state === 'all' || i.state === state);
      const creator = u.searchParams.get('creator');
      if (creator) list = list.filter((i) => i.user.login.toLowerCase() === creator.toLowerCase());
      return paged(structuredClone(list));
    }
    if ((m = rest.match(/^\/issues\/(\d+)(\/.*)?$/))) {
      const issue = this.issues.get(Number(m[1]));
      if (!issue) return fail(404);
      const sub = m[2] ?? '';
      if (sub === '' && method === 'GET') return ok(structuredClone(issue));
      if (sub === '' && method === 'PATCH') {
        Object.assign(issue, data);
        return ok(structuredClone(issue));
      }
      if (sub === '/comments' && method === 'GET') return paged(structuredClone(this.commentsOn(issue.number)));
      if (sub === '/comments' && method === 'POST') return ok(this.addComment(issue.number, this.bot, data.body), 201);
      if (sub === '/labels' && method === 'POST') {
        for (const name of data.labels) {
          if (!this.labels.has(name)) return fail(422, `label ${name} does not exist`);
          if (!issue.labels.some((l) => l.name === name)) issue.labels.push({ name });
        }
        return ok(issue.labels);
      }
      if ((m = sub.match(/^\/labels\/(.+)$/)) && method === 'DELETE') {
        const name = decodeURIComponent(m[1]);
        const had = issue.labels.length;
        issue.labels = issue.labels.filter((l) => l.name !== name);
        return had === issue.labels.length ? fail(404) : ok(issue.labels);
      }
    }
    return fail(404, `${method} ${path}`);
  }
}
