// The state of a contribution, read from the review desk's own comments on its issue. Every event the
// desk accepts (a version, a decision, a withdrawal, a publication, an admission) is posted as a comment
// carrying a marker: an HTML comment with the event as JSON. Only markers in comments written by the desk's
// own account count, so nobody can forge one by typing it. The CHAP recorder reads the same markers.
import { assess } from './lib/policy.mjs';

export const MARK = 'radar-desk';
const MARKER = /<!-- radar-desk (\{[\s\S]*?\}) -->/g;

/** An event as a marker. `<` and `>` are escaped so the JSON can never close the HTML comment. */
export function marker(event) {
  return `<!-- ${MARK} ${JSON.stringify(event).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')} -->`;
}

export function readMarkers(body) {
  const out = [];
  for (const m of String(body ?? '').matchAll(MARKER)) {
    try {
      out.push(JSON.parse(m[1]));
    } catch { /* not ours */ }
  }
  return out;
}

/** The desk's events on one issue, in order, each with the comment it came in. */
export function eventsOf(comments, bot) {
  const out = [];
  for (const c of comments) {
    if (c.user?.login !== bot) continue;
    for (const ev of readMarkers(c.body)) out.push({ ...ev, at: c.created_at, comment_id: c.id });
  }
  return out;
}

export const FINAL = ['declined', 'withdrawn', 'published'];
export const OPEN = ['in-review', 'changes-requested'];

/**
 * Replay a contribution's events. Status is one of: new (no version accepted yet), in-review,
 * changes-requested, approved, declined, withdrawn, published. Approvals count only on the current
 * version, one per person; an edit by a reviewer counts as their approval of the version it made.
 */
export function contributionState(events, config, kind) {
  const versions = [];
  const decisions = [];
  let status = 'new';
  let approvedAt = null;
  let current = null;
  const settle = (at) => {
    if (status !== 'in-review' || !current) return;
    const a = assess({ kind, artefact_digest: current.digest, rounds: [{ decisions }] }, config);
    if (a.met) {
      status = 'approved';
      approvedAt = at;
    }
  };
  for (const ev of events) {
    if (ev.e === 'version') {
      const before = current;
      current = ev;
      versions.push(ev);
      if (ev.cause === 'edited') {
        decisions.push({ person: ev.by, role: ev.role, decision: 'edit', artefact_digest: before?.digest ?? null, new_digest: ev.digest, at: ev.at });
      }
      status = 'in-review';
      settle(ev.at);
    } else if (ev.e === 'decision') {
      const decision = { approve: 'approve', changes: 'request_changes', decline: 'decline' }[ev.d];
      decisions.push({ person: ev.by, role: ev.role, decision, artefact_digest: ev.digest, reason: ev.reason ?? '', at: ev.at });
      if (ev.d === 'changes') status = 'changes-requested';
      else if (ev.d === 'decline') status = 'declined';
      else settle(ev.at);
    } else if (ev.e === 'withdrawn') status = 'withdrawn';
    else if (ev.e === 'published') status = 'published';
  }
  const assessment = current ? assess({ kind, artefact_digest: current.digest, rounds: [{ decisions }] }, config) : null;
  return { status, current, versions, decisions, assessment, approvedAt, events };
}

/** True when this person has approved (or made by an edit) the current version. */
export function hasApproved(state, login) {
  return (state.assessment?.counted ?? []).some((d) => d.person.toLowerCase() === String(login).toLowerCase());
}

/** What an open contribution waits for, in one sentence. */
export function waitingFor(state) {
  const a = state.assessment;
  if (!a || state.status !== 'in-review') return '';
  if (a.editorMissing && a.missing === 1) return "an editor's approval";
  const n = a.missing;
  const what = `${n} ${n === 1 ? 'approval' : 'approvals'} from the editors or specialist reviewers`;
  return a.editorMissing ? `${what}, one of them an editor's` : what;
}

/** Notices already given on an issue, so each is given once. */
export function noticesOf(events) {
  return new Set(events.filter((e) => e.e === 'notice').map((e) => e.key));
}
