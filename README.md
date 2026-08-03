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
   owner/name and the PR's base/head refs.
2. Archynt clones both refs, runs the same static detectors used by the authenticated dashboard
   pipeline, and returns a verdict + Markdown summary.
3. This action posts that summary as a PR comment, using the workflow's own `GITHUB_TOKEN` — Archynt
   never receives or needs write access to your repository.

## Limits

Public repos only. Requests are rate-limited per IP and per repository to keep the service free for
everyone. For private repos, higher limits, and the full runtime + AI-insights platform, see
[archynt.com/pricing](https://archynt.com/pricing).
