// GitHub's REST API, the few calls the review desk makes. Node 20 or later (built-in fetch); no dependencies.

export class GitHub {
  constructor({ repo, token, base = 'https://api.github.com', fetchImpl = globalThis.fetch }) {
    if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(String(repo))) throw new Error(`The repository must look like owner/name, not ${repo}.`);
    this.repo = repo;
    this.token = token;
    this.base = base.replace(/\/+$/, '');
    this.fetch = fetchImpl;
    this.labelsReady = null;
  }

  async call(method, path, body) {
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'intelligence-radar-review-desk' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await this.fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (method === 'DELETE' && res.status === 404) return null;
    if (res.status === 404 && method === 'GET') return null;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`GitHub answered ${method} ${path.split('?')[0]} with ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }

  async pages(path) {
    const all = [];
    const join = path.includes('?') ? '&' : '?';
    for (let page = 1; page <= 50; page += 1) {
      const batch = await this.call('GET', `${path}${join}per_page=100&page=${page}`);
      if (!Array.isArray(batch)) break;
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all;
  }

  r(path) {
    return `/repos/${this.repo}${path}`;
  }

  issue(n) {
    return this.call('GET', this.r(`/issues/${n}`));
  }

  comments(n) {
    return this.pages(this.r(`/issues/${n}/comments`));
  }

  openIssues(query = '') {
    return this.pages(this.r(`/issues?state=open${query}`));
  }

  comment(n, body) {
    return this.call('POST', this.r(`/issues/${n}/comments`), { body });
  }

  updateIssue(n, fields) {
    return this.call('PATCH', this.r(`/issues/${n}`), fields);
  }

  close(n, reason) {
    return this.call('PATCH', this.r(`/issues/${n}`), { state: 'closed', state_reason: reason });
  }

  async ensureLabels(colours) {
    if (!this.labelsReady) {
      this.labelsReady = (async () => {
        const have = new Set((await this.pages(this.r('/labels'))).map((l) => l.name.toLowerCase()));
        for (const [name, color] of Object.entries(colours)) {
          if (!have.has(name.toLowerCase())) await this.call('POST', this.r('/labels'), { name, color });
        }
      })();
    }
    return this.labelsReady;
  }

  /** Make the issue carry exactly `want` among the labels in `managed`, leaving other labels alone. */
  async setLabels(issue, want, managed, colours) {
    const have = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
    const add = want.filter((l) => !have.includes(l));
    const drop = have.filter((l) => managed.includes(l) && !want.includes(l));
    if (!add.length && !drop.length) return have;
    await this.ensureLabels(colours);
    for (const l of drop) await this.call('DELETE', this.r(`/issues/${issue.number}/labels/${encodeURIComponent(l)}`));
    if (add.length) await this.call('POST', this.r(`/issues/${issue.number}/labels`), { labels: add });
    return [...have.filter((l) => !drop.includes(l)), ...add];
  }

  async file(path) {
    const f = await this.call('GET', this.r(`/contents/${path}`));
    return f ? { sha: f.sha, text: Buffer.from(f.content, 'base64').toString('utf8') } : null;
  }

  putFile(path, text, message, sha) {
    return this.call('PUT', this.r(`/contents/${path}`), { message, content: Buffer.from(text, 'utf8').toString('base64'), ...(sha ? { sha } : {}) });
  }

  user(login) {
    return this.call('GET', `/users/${encodeURIComponent(login)}`);
  }
}
