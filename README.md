# Archynt Architecture Scan

Free, no-signup architecture check for public GitHub repos. Runs Archynt's static detectors
(cyclic dependencies, coupling, single points of failure, dead code) on every PR and posts a
summary comment — no account, no token shared with Archynt.

## Usage

Add `.github/workflows/archynt.yml` to your repo:

```yaml
name: Archynt architecture scan
on: pull_request

jobs:
  archynt-scan:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
    steps:
      - uses: archynt/pr-check-action@v1
        with:
          language: java # java | go | node | python
```

That's it — no `checkout` step needed, the scan runs against your repo directly from Archynt's
servers.

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
3. This action writes that summary to the job summary and posts it as a PR comment, using the
   workflow's own `GITHUB_TOKEN` — Archynt never receives or needs write access to your repository.

A `FAIL` verdict does not fail the job. The job fails only when the scan itself could not run.

## Pull requests from forks

Keep the trigger as `on: pull_request`. For a PR from a fork, GitHub gives the workflow a
**read-only** token whatever `permissions` says, so the action cannot comment. The scan still runs:
the result is in the job summary of the run, and the job does not fail because of the missing comment.

Do **not** switch to `pull_request_target` to get the comment: that trigger runs with your
repository's secrets and a write token on events a fork author controls. If you want the comment on
fork PRs too, install the Archynt GitHub App, which posts the check from Archynt's side.

## Limits

Public repos only. Requests are rate-limited per IP and per repository to keep the service free for
everyone. For private repos, higher limits, and the full runtime + AI-insights platform, see
[archynt.com/pricing](https://archynt.com/pricing).
