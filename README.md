# Archynt Architecture Scan

Free, no-signup architecture check for public GitHub repos. Runs Archynt's static detectors
(cyclic dependencies, coupling, single points of failure, dead code) on every PR and keeps one
summary comment per PR up to date — no account, no token shared with Archynt.

## Usage

Add `.github/workflows/archynt.yml` to your repo:

```yaml
name: Archynt architecture scan
on: pull_request

jobs:
  archynt-scan:
    runs-on: ubuntu-latest
    concurrency:
      group: archynt-${{ github.event.pull_request.number }}
      cancel-in-progress: true
    permissions:
      pull-requests: write
    steps:
      - uses: archynt/pr-check-action@v1
        with:
          language: java # java | go | node | python
```

That's it — no `checkout` step needed, the scan runs against your repo directly from Archynt's
servers. The `concurrency` block is optional: when you push twice in a row it cancels the run for the
older commit, so only the newest one scans.

## Badge

Add to your README:

```markdown
[![Architecture Score](https://img.shields.io/endpoint?url=https://api.archynt.com/api/v1/public/badge/OWNER/REPO)](https://archynt.com)
```

Replace `OWNER/REPO` with your GitHub owner and repo name. The badge shows the verdict from the
most recent scan (`PASS` / `WARN` / `FAIL`) and never triggers a scan itself — only opening a PR does.

## How it works

1. On every `pull_request` event, this action calls Archynt's public scan endpoint with your repo's
   owner/name, the PR number and the PR's exact base and head commits.
2. Archynt fetches those exact commits from your repository (a PR from a fork is reached through the
   PR itself, so the fork is never read), runs the same static detectors used by the authenticated
   dashboard pipeline on both, and returns a verdict + Markdown summary. The head is compared against
   the commit the PR branched from, so changes that landed on the base branch afterwards are not
   blamed on the PR.
3. This action writes that summary to the job summary and to the PR's Archynt comment, using the
   workflow's own `GITHUB_TOKEN` — Archynt never receives or needs write access to your repository.

## One comment per pull request

The first scan of a PR creates a comment; every later push **edits that same comment**, so the
conversation is not filled with one comment per push. The comment always describes the PR's newest
commit:

- A run for a commit that is no longer the PR head leaves the comment alone; the newer run writes it.
- When a commit could not be scanned (Archynt busy, commit not available), the comment says so and
  that the earlier result no longer applies. If the PR has no comment yet, none is created for that.
- If someone deletes the comment, the next scan creates it again. If someone edits it, the next scan
  replaces its text.

The action only edits comments that start with its hidden `<!-- archynt:pr-check:v1 -->` marker and
were written by `github-actions[bot]`. Comments by people or other bots are never edited or deleted,
and neither are comments from action versions older than `v1.2.0`.

A `FAIL` verdict does not fail the job. The job fails only when the scan itself could not run.

## Findings on their lines

New and worsened findings are also marked as **annotations in "Files changed"**, on the line where the
class is declared. In the comment, each new or worsened finding links to that line in the exact commit
that was scanned.

- GitHub shows up to 10 annotations per level in a workflow step, so the action writes at most `8`
  per level (errors, warnings, notices) and keeps the rest for its own messages. The job summary says
  how many locations were left out; every finding is still listed in the summary and the comment.
- Dead code candidates are listed but not annotated yet.
- Annotations need no token, so they also appear on PRs from forks.

## Pull requests from forks

Keep the trigger as `on: pull_request`. For a PR from a fork, GitHub gives the workflow a
**read-only** token whatever `permissions` says, so the action cannot comment. The scan still runs:
the result is in the job summary of the run, the findings are still annotated in "Files changed", and
the job does not fail because of the missing comment.

Do **not** switch to `pull_request_target` to get the comment: that trigger runs with your
repository's secrets and a write token on events a fork author controls. If you want the comment on
fork PRs too, install the Archynt GitHub App, which posts the check from Archynt's side.

## Limits

Public repos only. Requests are rate-limited per IP and per repository to keep the service free for
everyone. For private repos, higher limits, and the full runtime + AI-insights platform, see
[archynt.com/pricing](https://archynt.com/pricing).
