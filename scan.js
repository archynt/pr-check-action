'use strict';

const SCAN_PATH = '/api/v1/public/pr-scan';
const SHORT_SHA = 7;
const FORBIDDEN = 403;
const BUSY = 503;

const READ_ONLY_NOTE =
  '\n\n> **Not posted as a PR comment.** GitHub gives workflows triggered by a pull request from a fork a ' +
  'read-only token, so this action cannot comment. The check still ran: this summary is its result. ' +
  'To get the comment on fork PRs too, install the Archynt GitHub App, which comments from Archynt\'s side.';

/**
 * Runs Archynt's public scan for the pull request in `context` and reports it: always in the job
 * summary, and as a PR comment when the workflow token can write. Everything the PR author controls
 * (branch names, titles) travels as JSON built here, never through a shell.
 *
 * A FAIL verdict does not fail the job, as in v1.0. The job fails only when the scan itself could
 * not run (network error, rejected request, commits not available). A full Archynt queue and a
 * superseded commit are reported without failing.
 *
 * @param {{github: object, context: object, core: object, fetchImpl?: typeof fetch, env?: Record<string, string | undefined>}} deps
 * @returns {Promise<void>}
 */
async function run({ github, context, core, fetchImpl = fetch, env = process.env }) {
  const pr = context.payload.pull_request;
  if (!pr) {
    core.notice('Archynt scans pull requests only; this event has none, so nothing was scanned.');
    return;
  }
  const apiBase = (env.ARCHYNT_API_BASE_URL || 'https://api.archynt.com').replace(/\/+$/, '');
  const request = {
    owner: context.repo.owner,
    repo: context.repo.repo,
    baseRef: pr.base.ref,
    headRef: pr.head.ref,
    language: env.ARCHYNT_LANGUAGE,
    prNumber: pr.number,
    baseSha: pr.base.sha,
    headSha: pr.head.sha,
  };

  let response;
  try {
    response = await fetchImpl(apiBase + SCAN_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
  } catch (error) {
    core.setFailed(`Archynt scan could not reach ${apiBase}: ${error.message}`);
    return;
  }
  const result = await readJson(response);

  if (response.status === BUSY) {
    core.warning('Archynt has too many scans queued and did not scan this commit. Re-run this job in a few minutes.');
    return;
  }
  if (!response.ok) {
    const reason = result && result.reason ? `: ${result.reason}` : '';
    core.setFailed(`Archynt could not scan this pull request (HTTP ${response.status}${reason}).`);
    return;
  }
  if (!result || (result.status !== 'SUPERSEDED' && typeof result.summaryMarkdown !== 'string')) {
    core.setFailed(`Archynt returned an unexpected response (HTTP ${response.status}); nothing was published.`);
    return;
  }
  if (result.status === 'SUPERSEDED') {
    const current = String(result.currentSha || '').slice(0, SHORT_SHA);
    core.notice(`A newer commit (${current}) was pushed to this pull request; the run for that commit reports the result.`);
    return;
  }

  await core.summary.addRaw(result.summaryMarkdown).write();
  try {
    await github.rest.issues.createComment({ ...context.repo, issue_number: pr.number, body: result.summaryMarkdown });
  } catch (error) {
    if (error.status === FORBIDDEN) {
      await core.summary.addRaw(READ_ONLY_NOTE).write();
      core.notice('The result is in the job summary: the workflow token is read-only for this pull request, so no comment was posted.');
      return;
    }
    core.setFailed(`Archynt scanned the pull request but the comment could not be posted: ${error.message}`);
  }
}

/**
 * @param {Response} response
 * @returns {Promise<any>}
 */
async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

module.exports = run;
