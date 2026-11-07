// The publish queue: every approved contribution, in the approved version, read from GitHub.
//   node .github/desk/queue.mjs [--repo owner/name]  > queue.json
// The editors' publisher (build/community_publish.py in the editorial package) reads this. GITHUB_TOKEN, when set,
// only raises GitHub's rate limit: everything read here is public.
import { readFileSync } from 'node:fs';
import { GitHub } from './api.mjs';
import { Roster } from './roster.mjs';
import { contributionState, eventsOf } from './state.mjs';

const read = (name) => JSON.parse(readFileSync(new URL(`./lib/${name}`, import.meta.url), 'utf8'));
const KIND_LABELS = ['review', 'correction', 'evidence', 'label-change', 'new-entry'];

export async function publishQueue({ gh, config }) {
  const bot = config.desk_bot || 'github-actions[bot]';
  const f = await gh.file('people.json');
  const roster = f ? Roster.parse(f.text) : new Roster(null);
  const issues = await gh.openIssues('&labels=approved');
  const items = [];
  for (const issue of issues.sort((a, b) => a.number - b.number)) {
    if (issue.pull_request) continue;
    const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
    const kind = KIND_LABELS.find((k) => labels.includes(k));
    if (!kind) continue;
    const st = contributionState(eventsOf(await gh.comments(issue.number), bot), config, kind);
    if (st.status !== 'approved') continue;
    const p = st.current.payload;
    const author = roster.find(issue.user?.login, issue.user?.id);
    items.push({
      id: `C-${String(issue.number).padStart(4, '0')}`,
      github_issue: issue.number,
      url: issue.html_url ?? `https://github.com/${gh.repo}/issues/${issue.number}`,
      route: 'github',
      kind, target: p.target, title: p.title, payload: p,
      version: st.current.n, artefact_digest: st.current.digest,
      contributor: {
        name: p.credit?.name || author?.name || issue.user?.login,
        affiliation: p.credit?.affiliation || author?.affiliation || null,
        public: p.credit?.public !== false,
      },
      approvals: st.assessment.counted.map((d) => ({ name: roster.find(d.person)?.name ?? d.person, role: d.role, date: d.at })),
      approved_at: st.approvedAt,
    });
  }
  return { repo: gh.repo, items };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const config = read('config.json');
  const i = process.argv.indexOf('--repo');
  const repo = i > 0 ? process.argv[i + 1] : config.github_repo;
  const out = await publishQueue({ gh: new GitHub({ repo, token: process.env.GITHUB_TOKEN || null }), config });
  process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
}
