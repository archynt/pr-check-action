'use strict';

const SCAN_PATH = '/api/v1/public/pr-scan';
const SHORT_SHA = 7;
const FORBIDDEN = 403;
const NOT_FOUND = 404;
const BUSY = 503;
const UNPROCESSABLE = 422;
const MARKER = '<!-- archynt:pr-check:v1 -->';
const BOT_LOGIN = 'github-actions[bot]';
const BOT_TYPE = 'Bot';
const MAX_PAGES = 10;
const PER_PAGE = 100;
const CREATE_OR_UPDATE = 'create-or-update';
/**
 * GitHub shows at most 10 annotations per level for each workflow step. Two are left for this
 * action's own messages: the read-only notice on fork PRs and the warning when the comment fails.
 */
const MAX_ANNOTATIONS_PER_LEVEL = 8;
/** Annotation level from the Checks API to the `@actions/core` function that writes it. */
const LEVEL_TO_CORE = { failure: 'error', warning: 'warning', notice: 'notice' };
/**
 * Annotate only files the PR changed. A `pull_request` workflow runs on the PR's merge commit while
 * Archynt analyzes the head; on a file the base also changed, a line could be off. Set from the
 * manual check before release.
 */
const ONLY_CHANGED_FILES = false;
const UPDATE_ONLY = 'update-only';

const READ_ONLY_NOTE =
  '\n\n> **Not posted as a PR comment.** GitHub gives workflows triggered by a pull request from a fork a ' +
  'read-only token, so this action cannot comment. The check still ran: this summary is its result. ' +
  'To get the comment on fork PRs too, install the Archynt GitHub App, which comments from Archynt\'s side.';

const STALE_NOTE = 'The result previously shown here was for an earlier commit and no longer applies.';

/** Short reason and next step for each reason the public scan can answer with. */
const UNAVAILABLE = {
  BUSY: ['Archynt is busy', 'Too many scans are queued right now. **Re-run this job** in a few minutes.'],
  COMMIT_NOT_FOUND: ['commit not available', 'GitHub no longer serves this commit, usually after a force-push. Push again to scan the current head.'],
  NO_ACCESS: ['no access to the repository', 'The free scan reads public repositories only.'],
  TIMEOUT: ['timed out', 'Re-run this job; if it keeps happening, contact Archynt support.'],
  FETCH_ERROR: ['could not fetch the repository', 'Re-run this job.'],
  ANALYSIS_FAILED: ['analysis failed', 'If it keeps happening, contact Archynt support with the commit SHA.'],
};

/** Raised when the workflow token cannot write to the pull request (fork PR under `pull_request`). */
class ReadOnlyToken extends Error {}

/** Raised when the pull request moved to a newer commit before this run could write. */
class NewerCommit extends Error {}

/**
 * Runs Archynt's public scan for the pull request in `context` and reports it: always in the job
 * summary, as line annotations in "Files changed", and in a single PR comment that every later run
 * edits. Everything the PR author controls
 * (branch names, titles) travels as JSON built here, never through a shell.
 *
 * The comment is Archynt's own only if it starts with the marker and was written by
 * `github-actions[bot]`; nothing else is edited or deleted. A run whose commit is no longer the PR head
 * leaves the comment to the newer run. When a commit could not be scanned, an existing comment says
 * so instead of showing an older result, but no comment is created for it.
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
  const comments = { github, context, core, pr };

  if (response.status === BUSY || response.status === UNPROCESSABLE) {
    const reason = result && result.reason ? String(result.reason) : '';
    await publishComment(comments, unavailableBody(reason, pr.head.sha), UPDATE_ONLY, false);
    if (response.status === BUSY) {
      core.warning('Archynt has too many scans queued and did not scan this commit. Re-run this job in a few minutes.');
    } else {
      core.setFailed(`Archynt could not scan this pull request (HTTP ${response.status}${reason ? `: ${reason}` : ''}).`);
    }
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

  core.summary.addRaw(result.summaryMarkdown);
  annotate(core, result);
  await core.summary.write();
  await publishComment(comments, `${MARKER}\n${result.summaryMarkdown}`, CREATE_OR_UPDATE, true);
}

/**
 * Marks the findings on their lines in "Files changed" with the annotations Archynt chose, most
 * important first, through `@actions/core`, which escapes every value: paths come from the scanned
 * repository. Needs no token, so it also works on fork PRs. A response from an Archynt version without
 * annotations leaves nothing to do.
 *
 * @param {object} core
 * @param {{annotations?: unknown, annotationsOmitted?: unknown}} result
 */
function annotate(core, result) {
  if (!Array.isArray(result.annotations)) {
    return;
  }
  const perLevel = { failure: 0, warning: 0, notice: 0 };
  let dropped = 0;
  for (const annotation of result.annotations.filter(isValidAnnotation)) {
    if (ONLY_CHANGED_FILES && annotation.inChangedFile !== true) {
      continue;
    }
    if (perLevel[annotation.level] >= MAX_ANNOTATIONS_PER_LEVEL) {
      dropped++;
      continue;
    }
    perLevel[annotation.level]++;
    core[LEVEL_TO_CORE[annotation.level]](String(annotation.message ?? ''), {
      title: String(annotation.title ?? ''),
      file: annotation.path,
      startLine: annotation.startLine,
      endLine: annotation.endLine,
    });
  }
  const omitted = (Number.isInteger(result.annotationsOmitted) ? result.annotationsOmitted : 0) + dropped;
  if (omitted > 0) {
    core.summary.addRaw(`\n\n_${omitted} more locations are not annotated: GitHub shows up to 10 per level in a ` +
      'workflow step. All findings are listed above._');
  }
}

/** @param {unknown} annotation */
function isValidAnnotation(annotation) {
  return annotation !== null && typeof annotation === 'object'
    && typeof annotation.path === 'string' && annotation.path.length > 0
    && Number.isInteger(annotation.startLine) && annotation.startLine >= 1
    && Number.isInteger(annotation.endLine) && annotation.endLine >= annotation.startLine
    && Object.prototype.hasOwnProperty.call(LEVEL_TO_CORE, annotation.level);
}

/**
 * Writes `body` to the PR's Archynt comment. For a scan result (`isResult`), a read-only token is
 * explained in the job summary and any other failure fails the job. For a not-scanned notice, the job
 * already reports the scan problem, so a comment that cannot be updated only warns.
 */
async function publishComment({ github, context, core, pr }, body, mode, isResult) {
  try {
    await upsertComment({ github, context, pr }, body, mode);
  } catch (error) {
    if (error instanceof NewerCommit) {
      core.notice('A newer commit was pushed to this pull request; its run updates the comment. This run\'s result is in the job summary.');
      return;
    }
    if (!isResult) {
      core.warning(`The Archynt comment could not be updated: ${error.message}`);
      return;
    }
    if (error instanceof ReadOnlyToken) {
      await core.summary.addRaw(READ_ONLY_NOTE).write();
      core.notice('The result is in the job summary: the workflow token is read-only for this pull request, so no comment was posted.');
      return;
    }
    core.setFailed(`Archynt scanned the pull request but the comment could not be posted: ${error.message}`);
  }
}

/**
 * Finds the oldest own comment (marker + `github-actions[bot]`) in at most 10 pages, then edits it,
 * creates it when missing (only in create-or-update mode) and deletes own duplicates. Nothing is
 * written when the PR head is no longer this run's commit. A duplicate that cannot be deleted is left
 * for the next run, unless the token is read-only.
 */
async function upsertComment({ github, context, pr }, body, mode) {
  const issue = { ...context.repo, issue_number: pr.number };
  const current = await call(() => github.rest.pulls.get({ ...context.repo, pull_number: pr.number }));
  if (current.data.head.sha !== pr.head.sha) {
    throw new NewerCommit();
  }
  const own = await findOwnComments(github, issue);
  if (own.length === 0) {
    if (mode === CREATE_OR_UPDATE) {
      await call(() => github.rest.issues.createComment({ ...issue, body }));
    }
    return;
  }
  const [kept, ...duplicates] = own;
  if (kept.body !== body) {
    try {
      await call(() => github.rest.issues.updateComment({ ...context.repo, comment_id: kept.id, body }));
    } catch (error) {
      if (error.status !== NOT_FOUND) {
        throw error;
      }
      if (mode === CREATE_OR_UPDATE) {
        await call(() => github.rest.issues.createComment({ ...issue, body }));
      }
    }
  }
  for (const duplicate of duplicates) {
    try {
      await call(() => github.rest.issues.deleteComment({ ...context.repo, comment_id: duplicate.id }));
    } catch (error) {
      if (error instanceof ReadOnlyToken) {
        throw error;
      }
    }
  }
}

/** Own comments among the first 10 pages of the PR's comments, oldest first. */
async function findOwnComments(github, issue) {
  const own = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data } = await call(() => github.rest.issues.listComments({ ...issue, per_page: PER_PAGE, page }));
    own.push(...data.filter(isOwn));
    if (data.length < PER_PAGE) {
      break;
    }
  }
  return own.sort((a, b) => a.id - b.id);
}

function isOwn(comment) {
  return typeof comment.body === 'string'
    && comment.body.startsWith(MARKER)
    && comment.user != null
    && comment.user.login === BOT_LOGIN
    && comment.user.type === BOT_TYPE;
}

/** Runs a GitHub call and turns a 403 into {@link ReadOnlyToken}. */
async function call(request) {
  try {
    return await request();
  } catch (error) {
    if (error.status === FORBIDDEN) {
      throw new ReadOnlyToken(error.message);
    }
    throw error;
  }
}

function unavailableBody(reason, headSha) {
  const [title, next] = UNAVAILABLE[reason] || [reason ? `\`${reason}\`` : 'unknown reason', 'Re-run this job.'];
  return `${MARKER}\n## Archynt — architecture check\n\n`
    + `**Commit \`${String(headSha).slice(0, SHORT_SHA)}\` was not analyzed:** ${title}.\n\n`
    + `${next}\n\n${STALE_NOTE}`;
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
