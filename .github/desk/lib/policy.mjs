// The review policy (community/SPEC.md section 4) as pure functions of a contribution record, the
// community configuration and the panel (active reviewers and editors other than the contributor).

// The statuses of section 3. Only open contributions take review decisions.
export const STATUSES = ['submitted', 'in_review', 'changes_requested', 'declined', 'approved', 'published', 'withdrawn'];
export const OPEN = ['submitted', 'in_review'];

/** The round still waiting for decisions, if any. */
export function openRoundOf(c) {
  const last = c.rounds.at(-1);
  return last && !last.closed_at ? last : null;
}

export function rulesFor(config, kind) {
  const rule = config.kinds?.[kind] ?? {};
  const needed = Number.isInteger(rule.approvals) && rule.approvals > 0 ? rule.approvals : 1;
  return { needed, editorRequired: rule.editor_required === true };
}

/** Approvals that count: on the current artefact digest, one per person. An edit is its author's approval of the version it made. */
export function approvals(c) {
  const byPerson = new Map();
  for (const round of c.rounds) {
    for (const d of round.decisions) {
      const on = d.decision === 'approve' ? d.artefact_digest : d.decision === 'edit' ? d.new_digest : null;
      if (on === c.artefact_digest && !byPerson.has(d.person)) byPerson.set(d.person, d);
    }
  }
  return [...byPerson.values()];
}

export function assess(c, config) {
  const { needed, editorRequired } = rulesFor(config, c.kind);
  const counted = approvals(c);
  const editorHave = counted.some((d) => d.role === 'editor');
  const editorMissing = editorRequired && !editorHave;
  const missing = Math.max(needed - counted.length, editorMissing ? 1 : 0);
  return { needed, editor_required: editorRequired, have: counted.length, editor_have: editorHave, editorMissing, missing, met: missing === 0, counted };
}

export const ruleFor = (missing) => (missing === 1 ? 'any_one_approves' : `quorum:${missing}`);
export const ruleSize = (rule) => (rule.startsWith('quorum:') ? Number(rule.slice(7)) : 1);

/**
 * The next round on the current version. A first round (a submission or a revision) goes to the whole
 * panel; a further round goes to the panel members who have not approved this version, or to editors
 * only when an editor's approval is the one missing. Not feasible when the panel cannot meet the policy.
 */
export function planRound(c, config, panel, { first = false } = {}) {
  const a = assess(c, config);
  const approved = new Set(a.counted.map((d) => d.person));
  const open = panel.filter((p) => !approved.has(p.id));
  const editorsOnly = !first && a.editorMissing && a.missing === 1;
  const to = editorsOnly ? open.filter((p) => p.role === 'editor') : open;
  const hasEditor = to.some((p) => p.role === 'editor');
  const feasible = !a.met && to.length >= a.missing && (!a.editorMissing || hasEditor);
  return { to: to.map((p) => p.id), rule: ruleFor(a.missing), purpose: editorsOnly ? 'editor sign-off' : 'review', feasible, hasEditor, assessment: a };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Why the panel cannot meet the policy: the contribution waits until editors add people. */
export function blockedReason(plan) {
  const a = plan.assessment;
  if (a.editorMissing && !plan.hasEditor) {
    return "More reviewers: it needs an editor's approval, and no editor other than the contributor is available.";
  }
  return `More reviewers: it needs ${plural(a.missing, 'more approval')} from different reviewers, and ${plan.to.length} can give one.`;
}

/** What an open round waits on. `active` is the set of active panel members' ids; `a` is the assessment. */
export function roundNeeds(round, active, a) {
  const approvedHere = new Set(round.decisions.filter((d) => d.decision === 'approve').map((d) => d.person));
  const remaining = Math.max(ruleSize(round.rule) - approvedHere.size, 0);
  const able = round.to.filter((id) => active.has(id) && !approvedHere.has(id)).length;
  if (able < remaining) return `More reviewers: this round needs ${plural(remaining, 'approval')}, and ${able} of the people it asks can still give one.`;
  if (round.purpose === 'editor sign-off') return "An editor's approval.";
  const editor = a.editorMissing ? ", including an editor's" : '';
  return remaining === 1 ? `An approval from the panel${editor}.` : `${plural(remaining, 'approval')} from the panel${editor}.`;
}
