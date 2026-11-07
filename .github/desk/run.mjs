// Entry point for the review desk workflow (.github/workflows/review-desk.yml).
// Reads the GitHub event and hands it to the desk. Needs GITHUB_TOKEN, GITHUB_REPOSITORY,
// GITHUB_EVENT_NAME and GITHUB_EVENT_PATH, all set by GitHub Actions.
import { appendFileSync, readFileSync } from 'node:fs';
import { GitHub } from './api.mjs';
import { Desk } from './desk.mjs';

const read = (name) => JSON.parse(readFileSync(new URL(`./lib/${name}`, import.meta.url), 'utf8'));
const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_STEP_SUMMARY } = process.env;
if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !GITHUB_EVENT_NAME) {
  console.error('The review desk runs in GitHub Actions: GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_EVENT_NAME are needed.');
  process.exit(2);
}
const event = GITHUB_EVENT_PATH ? JSON.parse(readFileSync(GITHUB_EVENT_PATH, 'utf8')) : {};
const desk = new Desk({ gh: new GitHub({ repo: GITHUB_REPOSITORY, token: GITHUB_TOKEN }), config: read('config.json'), forms: read('forms.json'), log: console.log });
const where = event.issue ? `#${event.issue.number}` : GITHUB_EVENT_NAME;
try {
  const outcome = await desk.handle(GITHUB_EVENT_NAME, event);
  const line = `Review desk, ${where}: ${outcome}`;
  console.log(line);
  if (GITHUB_STEP_SUMMARY) appendFileSync(GITHUB_STEP_SUMMARY, `${line}\n`);
} catch (err) {
  console.error(`Review desk, ${where}: ${err.stack ?? err.message}`);
  process.exit(1);
}
