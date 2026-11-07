# What makes a contribution easy to review

The reviewers judge each contribution on its evidence. These points help them decide quickly and fairly.

## Before you start

- Make sure your GitHub account is on the [list of people](PEOPLE.md). If it is not, [apply to contribute](../../issues/new?template=apply.yml) first: contributions from other accounts wait until an editor approves the application.
- Read the entry on [TheIntelligenceRadar.com](https://theintelligenceradar.com/) as it stands now. Each entry page links to the forms with the entry filled in.
- One contribution, one change. Send separate issues for separate points.
- Declare any interest: a vendor, client, employer or product named in the entry or in your sources. Write None if there is nothing to declare.

## Proposing words

- Copy the words to change exactly from the entry, with enough of them to be unique.
- Write in British English, in plain, short sentences.
- Call the publication The Intelligence Radar, and use its labels as they are: Use, Trial, Evaluate, Wait or Prepare; Revisit, Test, Plan for or Watch.
- Date what you describe ("in September 2026"), rather than "this quarter" or "recently".
- Write about the subject, not about yourself: no "we" or "our".

## Evidence

- Prefer the primary source: the paper, the filing, the documentation, the dataset or the vendor's own statement, rather than a report about it.
- Give one source per line: `URL | title | publisher | date`.
- Say what the source shows, how it was measured, and its limits. Ten articles repeating one announcement count as one source.
- A narrow result is welcome. Say where it holds and where it may not.

## Labels

A label change needs the conditions under which the new label holds, and what would make it wrong. The intelligence label is how ready the capability or practice is under those conditions. The enterprise label is what an organisation should do about it now. The reviewers judge the two separately, and an editor approves every label change and new entry.

## After you send it

The review desk replies on the issue within a minute or so: it checks your account against the list of people and the form against the rules, then labels the issue `in-review`. Each decision is posted with its reason. To revise, edit the issue: the new version goes back to the reviewers automatically, and approvals of earlier versions no longer count. To withdraw it, comment `/withdraw`. Approved contributions are published with the next publication and credited on the website.

From an AI assistant, The Intelligence Radar's MCP server does the same: `sign_in_with_github` once, then `prepare_contribution` and `submit_contribution`.

## For editors and specialist reviewers

Decide by commenting on the issue. The command goes on the first line; the reason follows it, in your own words. The review desk applies the review policy and records every decision.

| Command | Who | What it does |
|---|---|---|
| `/approve <reason>` | Editors and specialist reviewers, not on their own contributions | Approves the current version |
| `/changes <what to change>` | The same | Asks the contributor for a revised version |
| `/decline <reason>` | The same | Declines it; final |
| `/edit <reason>` and the whole edited contribution in a ` ```json ` block | The same, while it is in review | Makes a new version, shown on the issue; counts as your approval of it |
| `/withdraw <reason>` | The contributor | Withdraws it before a final decision |
| `/published <release>` | Editors | Records that an approved contribution is published, and closes the issue |
| `/admit contributor`, `/admit reviewer` or `/admit editor` | Editors, on an application | Adds the applicant to the list of people |
| `/decline <reason>` | Editors, on an application | Declines the application |
| `/role @login <role>` and `/remove @login <reason>` | Editors, on any issue | Changes a person's role, or takes them off the list |

Reviews, corrections and evidence need one approval from an editor or a specialist reviewer. Label changes and new entries need an editor's approval. A command may carry the digest of the version you read (`/approve sha256:1a2b3c4d … <reason>`): the desk then refuses it if the contribution has changed since.
