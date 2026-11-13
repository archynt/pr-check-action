'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const run = require('./scan');

const BASE_SHA = '1111111111111111111111111111111111111111';
const HEAD_SHA = '2222222222222222222222222222222222222222';
const NEWER_SHA = '3333333333333333333333333333333333333333';
const HOSTILE_BRANCH = 'a";echo${IFS}pwned;#$(id)`id`';
const MARKER = '<!-- archynt:pr-check:v1 -->';
const BOT = { login: 'github-actions[bot]', type: 'Bot' };

/**
 * A GitHub with state for the workflow token: the PR's comments (with their author), the PR head,
 * and failures to inject per call (`{list, create, update, delete, pull}` → `{status, message}`).
 *
 * @param {{status?: number, json?: any, fetchError?: Error, headSha?: string, comments?: Array<{body: string, user: object}>, errors?: Record<string, {status: number, message: string}>}} options
 */
function harness(options = {}) {
  const calls = { requests: [], summary: [], notices: [], warnings: [], failures: [], annotations: [], listed: 0, created: 0 };
  const errors = options.errors ?? {};
  let nextId = 100;
  const comments = (options.comments ?? []).map((comment) => ({ id: ++nextId, ...comment }));
  const fail = (name) => {
    if (errors[name]) {
      throw Object.assign(new Error(errors[name].message), { status: errors[name].status });
    }
  };
  const summary = {
    addRaw(text) {
      calls.summary.push(text);
      return summary;
    },
    async write() {
      return summary;
    },
  };
  const annotated = (level, plain) => (message, properties) => {
    if (properties) {
      calls.annotations.push({ level, message, properties });
    } else {
      plain.push(message);
    }
  };
  const core = {
    summary,
    notice: annotated('notice', calls.notices),
    warning: annotated('warning', calls.warnings),
    error: annotated('error', calls.failures),
    setFailed: (message) => calls.failures.push(message),
  };
  const github = {
    rest: {
      pulls: {
        async get() {
          fail('pull');
          return { data: { head: { sha: options.headSha ?? HEAD_SHA } } };
        },
      },
      issues: {
        async listComments({ per_page: perPage, page }) {
          fail('list');
          calls.listed++;
          const sorted = [...comments].sort((a, b) => a.id - b.id);
          return { data: sorted.slice((page - 1) * perPage, page * perPage) };
        },
        async createComment({ body }) {
          fail('create');
          calls.created++;
          comments.push({ id: ++nextId, body, user: BOT });
        },
        async updateComment({ comment_id: id, body }) {
          fail('update');
          const comment = comments.find((candidate) => candidate.id === id);
          if (!comment) {
            throw Object.assign(new Error('Not Found'), { status: 404 });
          }
          comment.body = body;
        },
        async deleteComment({ comment_id: id }) {
          fail('delete');
          const index = comments.findIndex((candidate) => candidate.id === id);
          comments.splice(index, 1);
        },
      },
    },
  };
  const context = {
    repo: { owner: 'acme', repo: 'shop' },
    payload: {
      pull_request: {
        number: 7,
        base: { ref: 'main', sha: BASE_SHA },
        head: { ref: HOSTILE_BRANCH, sha: HEAD_SHA },
      },
    },
  };
  const fetchImpl = async (url, init) => {
    if (options.fetchError) {
      throw options.fetchError;
    }
    calls.requests.push({ url, init });
    const status = options.status ?? 200;
    return { status, ok: status >= 200 && status < 300, json: async () => options.json ?? {} };
  };
  const env = { ARCHYNT_API_BASE_URL: 'https://api.example.test/', ARCHYNT_LANGUAGE: 'java' };
  return { calls, comments, deps: { github, context, core, fetchImpl, env } };
}

const ANALYZED = { verdict: 'FAIL', summaryMarkdown: '## Archynt\nFAIL' };
const RESULT_BODY = `${MARKER}\n## Archynt\nFAIL`;

test('sends the exact commits of the PR as JSON, with the branch name passed through untouched', async () => {
  const { calls, deps } = harness({ json: ANALYZED });

  await run(deps);

  assert.equal(calls.requests.length, 1);
  assert.equal(calls.requests[0].url, 'https://api.example.test/api/v1/public/pr-scan');
  assert.deepEqual(JSON.parse(calls.requests[0].init.body), {
    owner: 'acme',
    repo: 'shop',
    baseRef: 'main',
    headRef: HOSTILE_BRANCH,
    language: 'java',
    prNumber: 7,
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
  });
});

test('action.yml runs no shell and interpolates nothing into the script', () => {
  const yml = fs.readFileSync(path.join(__dirname, 'action.yml'), 'utf8');
  const script = yml.slice(yml.indexOf('script: |'));

  assert.doesNotMatch(yml, /^\s*run:/m);
  assert.doesNotMatch(yml, /\$\{\{\s*github\.(head_ref|base_ref|event)/);
  assert.doesNotMatch(script, /\$\{\{/);
});

test('the first run creates the marked comment, later runs edit it, and a FAIL verdict does not fail the job', async () => {
  const first = harness({ json: ANALYZED });
  await run(first.deps);
  assert.deepEqual(first.comments.map((comment) => comment.body), [RESULT_BODY]);
  assert.deepEqual(first.calls.summary, ['## Archynt\nFAIL']);
  assert.deepEqual(first.calls.failures, []);

  const later = harness({ json: { verdict: 'PASS', summaryMarkdown: '## Archynt\nPASS' }, comments: [{ body: RESULT_BODY, user: BOT }] });
  await run(later.deps);
  assert.deepEqual(later.comments.map((comment) => comment.body), [`${MARKER}\n## Archynt\nPASS`]);
  assert.equal(later.calls.created, 0);
});

test('comments of people, other bots and pre-marker runs are never touched', async () => {
  const human = { body: `${MARKER}\npasted by a person`, user: { login: 'alice', type: 'User' } };
  const otherBot = { body: `${MARKER}\nother`, user: { login: 'archynt[bot]', type: 'Bot' } };
  const legacy = { body: '## Archynt\nold run', user: BOT };
  const { comments, deps } = harness({ json: ANALYZED, comments: [human, otherBot, legacy] });

  await run(deps);

  assert.deepEqual(comments.map((comment) => comment.body), [human.body, otherBot.body, legacy.body, RESULT_BODY]);
});

test('the comment is found on a later page and the search stops at ten pages', async () => {
  const chatter = Array.from({ length: 230 }, (_, i) => ({ body: `chatter ${i}`, user: { login: 'alice', type: 'User' } }));
  const found = harness({ json: ANALYZED, comments: [...chatter, { body: `${MARKER}\nold`, user: BOT }] });
  await run(found.deps);
  assert.equal(found.calls.listed, 3);
  assert.equal(found.calls.created, 0);
  assert.equal(found.comments.at(-1).body, RESULT_BODY);

  const crowded = harness({ json: ANALYZED, comments: Array.from({ length: 1_100 }, (_, i) => ({ body: `c ${i}`, user: { login: 'a', type: 'User' } })) });
  await run(crowded.deps);
  assert.equal(crowded.calls.listed, 10);
  assert.equal(crowded.calls.created, 1);
});

test('duplicates are deleted and the oldest own comment is kept', async () => {
  const { comments, deps } = harness({
    json: ANALYZED,
    comments: [{ body: `${MARKER}\na`, user: BOT }, { body: `${MARKER}\nb`, user: BOT }],
  });

  await run(deps);

  assert.deepEqual(comments.map((comment) => [comment.id, comment.body]), [[101, RESULT_BODY]]);
});

test('a comment that vanished before the edit is created again', async () => {
  const { calls, comments, deps } = harness({
    json: ANALYZED,
    comments: [{ body: `${MARKER}\nold`, user: BOT }],
    errors: { update: { status: 404, message: 'Not Found' } },
  });

  await run(deps);

  assert.equal(calls.created, 1);
  assert.equal(comments.at(-1).body, RESULT_BODY);
});

test('a run whose commit is no longer the PR head leaves the comment to the newer run', async () => {
  const { calls, comments, deps } = harness({ json: ANALYZED, headSha: NEWER_SHA, comments: [{ body: `${MARKER}\nnewer`, user: BOT }] });

  await run(deps);

  assert.deepEqual(comments.map((comment) => comment.body), [`${MARKER}\nnewer`]);
  assert.deepEqual(calls.summary, ['## Archynt\nFAIL']);
  assert.match(calls.notices[0], /newer commit/);
  assert.deepEqual(calls.failures, []);
});

test('a read-only token (fork PR) keeps the result in the job summary without failing, at any step', async () => {
  for (const step of ['create', 'list', 'pull']) {
    const { calls, deps } = harness({ json: ANALYZED, errors: { [step]: { status: 403, message: 'Resource not accessible by integration' } } });

    await run(deps);

    assert.equal(calls.summary[0], '## Archynt\nFAIL', step);
    assert.match(calls.summary[1], /read-only token/, step);
    assert.deepEqual(calls.failures, [], step);
    assert.equal(calls.notices.length, 1, step);
  }
});

test('any other comment failure fails the job', async () => {
  const { calls, deps } = harness({ json: ANALYZED, errors: { create: { status: 500, message: 'Server Error' } } });

  await run(deps);

  assert.match(calls.failures[0], /comment could not be posted/);
});

test('a superseded commit is reported without commenting or failing', async () => {
  const { calls, comments, deps } = harness({ json: { status: 'SUPERSEDED', currentSha: '3333333333333333' } });

  await run(deps);

  assert.deepEqual(comments, []);
  assert.equal(calls.listed, 0);
  assert.deepEqual(calls.failures, []);
  assert.match(calls.notices[0], /3333333/);
});

test('a full Archynt queue warns without failing and turns an existing comment into a not-scanned notice', async () => {
  const { calls, comments, deps } = harness({ status: 503, json: { status: 'UNAVAILABLE', reason: 'BUSY' }, comments: [{ body: RESULT_BODY, user: BOT }] });

  await run(deps);

  assert.equal(calls.warnings.length, 1);
  assert.deepEqual(calls.failures, []);
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /^<!-- archynt:pr-check:v1 -->/);
  assert.match(comments[0].body, /Commit `2222222` was not analyzed:\*\* Archynt is busy/);
  assert.match(comments[0].body, /no longer applies/);
});

test('a scan that could not run fails the job with its reason and never creates a comment', async () => {
  const { calls, comments, deps } = harness({ status: 422, json: { status: 'UNAVAILABLE', reason: 'COMMIT_NOT_FOUND' } });

  await run(deps);

  assert.deepEqual(calls.failures, ['Archynt could not scan this pull request (HTTP 422: COMMIT_NOT_FOUND).']);
  assert.deepEqual(comments, []);
});

test('a scan that could not run updates an existing comment', async () => {
  const { comments, deps } = harness({ status: 422, json: { status: 'UNAVAILABLE', reason: 'COMMIT_NOT_FOUND' }, comments: [{ body: RESULT_BODY, user: BOT }] });

  await run(deps);

  assert.match(comments[0].body, /commit not available/);
});

test('an unreachable API fails the job', async () => {
  const { calls, deps } = harness({ fetchError: new Error('getaddrinfo ENOTFOUND') });

  await run(deps);

  assert.match(calls.failures[0], /could not reach https:\/\/api\.example\.test/);
});

test('an event without a pull request scans nothing', async () => {
  const { calls, deps } = harness({ json: ANALYZED });
  deps.context.payload = {};

  await run(deps);

  assert.deepEqual(calls.requests, []);
  assert.equal(calls.notices.length, 1);
});

test('a successful status with an unexpected body fails the job instead of crashing', async () => {
  const notJson = harness({ json: null });
  notJson.deps.fetchImpl = async () => ({ status: 200, ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } });
  await run(notJson.deps);
  assert.deepEqual(notJson.calls.failures, ['Archynt returned an unexpected response (HTTP 200); nothing was published.']);

  const noSummary = harness({ json: { verdict: 'PASS' } });
  await run(noSummary.deps);
  assert.match(noSummary.calls.failures[0], /unexpected response/);
  assert.deepEqual(noSummary.comments, []);
});

/** @param {number} count @param {string} level */
function annotations(count, level, from = 0) {
  return Array.from({ length: count }, (_, index) => ({
    path: `src/${level}${from + index}.java`,
    startLine: 12,
    endLine: 12,
    level,
    title: `Finding ${level} ${from + index}`,
    message: `detail\nFingerprint: v1:X:${level}${from + index}`,
    inChangedFile: true,
  }));
}

test('annotations from the scan are written on their lines with core, by level, before the comment', async () => {
  const { calls, deps } = harness({ json: { ...ANALYZED, annotations: [...annotations(1, 'failure'), ...annotations(1, 'warning')], annotationsOmitted: 0 } });

  await run(deps);

  assert.deepEqual(calls.annotations, [
    { level: 'error', message: 'detail\nFingerprint: v1:X:failure0', properties: { title: 'Finding failure 0', file: 'src/failure0.java', startLine: 12, endLine: 12 } },
    { level: 'warning', message: 'detail\nFingerprint: v1:X:warning0', properties: { title: 'Finding warning 0', file: 'src/warning0.java', startLine: 12, endLine: 12 } },
  ]);
  assert.deepEqual(calls.failures, []);
  assert.deepEqual(calls.summary, ['## Archynt\nFAIL']);
});

test('a dead code candidate from the scan is written as a notice on its line with this version', async () => {
  const deadCode = {
    path: 'src/Unused.java',
    startLine: 2,
    endLine: 2,
    level: 'notice',
    title: 'Dead code candidate: Unused',
    message: "Nothing in the analyzed code references it, and it isn't a recognized entry point.\nFingerprint: v1:DEAD_CODE:Unused",
  };
  const { calls, deps } = harness({ json: { ...ANALYZED, annotations: [deadCode], annotationsOmitted: 0 } });

  await run(deps);

  assert.deepEqual(calls.annotations, [
    { level: 'notice', message: deadCode.message, properties: { title: deadCode.title, file: 'src/Unused.java', startLine: 2, endLine: 2 } },
  ]);
  assert.deepEqual(calls.failures, []);
});

test('at most eight annotations per level, and the job summary says how many were left out', async () => {
  const sent = [...annotations(10, 'failure'), ...annotations(10, 'warning'), ...annotations(10, 'notice')];
  const { calls, deps } = harness({ json: { ...ANALYZED, annotations: sent, annotationsOmitted: 4 } });

  await run(deps);

  for (const level of ['error', 'warning', 'notice']) {
    assert.equal(calls.annotations.filter((annotation) => annotation.level === level).length, 8, level);
  }
  assert.deepEqual(calls.annotations.filter((annotation) => annotation.level === 'error').map((annotation) => annotation.properties.file),
    annotations(8, 'failure').map((annotation) => annotation.path));
  assert.match(calls.summary[1], /_10 more locations are not annotated/);
});

test('a fork PR still gets its annotations and the read-only notice', async () => {
  const { calls, deps } = harness({
    json: { ...ANALYZED, annotations: annotations(8, 'notice'), annotationsOmitted: 0 },
    errors: { create: { status: 403, message: 'Resource not accessible by integration' } },
  });

  await run(deps);

  assert.equal(calls.annotations.length, 8);
  assert.equal(calls.notices.length, 1);
  assert.match(calls.summary.at(-1), /read-only token/);
  assert.deepEqual(calls.failures, []);
});

test('a scan from an Archynt without annotations, or with malformed ones, annotates nothing', async () => {
  const old = harness({ json: ANALYZED });
  await run(old.deps);
  assert.deepEqual(old.calls.annotations, []);

  const malformed = harness({ json: { ...ANALYZED, annotations: [
    { path: '', startLine: 1, endLine: 1, level: 'failure' },
    { path: 'a.java', startLine: 0, endLine: 1, level: 'failure' },
    { path: 'a.java', startLine: 3, endLine: 1, level: 'failure' },
    { path: 'a.java', startLine: 1, endLine: 1, level: 'debug' },
    null,
  ] } });
  await run(malformed.deps);
  assert.deepEqual(malformed.calls.annotations, []);
  assert.deepEqual(malformed.calls.failures, []);
});

test('a scan judged by archynt.yml reaches the job summary, the comment and Files changed with this version', async () => {
  const summaryMarkdown = '## Archynt\nConfig: `archynt.yml` @ `1111111` · 1 suppressed\n\n'
    + '_This PR changes `archynt.yml`; the change applies to checks after it is merged._\n\n'
    + '### Suppressed (1)\n- **[HIGH] Possible god class: Hub** — accepted in `archynt.yml`: `legacy facade`\n';
  const response = {
    verdict: 'PASS',
    summaryMarkdown,
    introduced: [],
    worsened: [],
    resolved: [],
    annotations: [{
      path: 'archynt.yml', startLine: 4, endLine: 4, level: 'warning', title: 'archynt.yml: CONFIG_RANGE',
      message: 'expected a whole number between 1 and 1000. Found `0`.', inChangedFile: true,
    }],
    annotationsOmitted: 0,
    config: {
      status: 'APPLIED', sha: BASE_SHA, errors: [], errorCount: 0, headChanged: true,
      headErrors: [{ code: 'CONFIG_RANGE', path: 'thresholds.coupling.highFanOut', line: 4, column: 17, message: 'expected a whole number between 1 and 1000. Found `0`.' }],
      headErrorCount: 1, misnamedFile: null,
    },
    suppressed: [{ type: 'HIGH_COUPLING', severity: 'HIGH', title: 'Possible god class: Hub', fingerprint: 'v1:HIGH_COUPLING:Hub', suppressionReason: 'legacy facade', locations: [] }],
    ignoredCount: 0,
  };
  const { calls, deps, comments } = harness({ json: response });

  await run(deps);

  assert.deepEqual(calls.summary, [summaryMarkdown]);
  assert.deepEqual(comments.map((comment) => comment.body), [`${MARKER}\n${summaryMarkdown}`]);
  assert.deepEqual(calls.annotations, [{
    level: 'warning',
    message: 'expected a whole number between 1 and 1000. Found `0`.',
    properties: { title: 'archynt.yml: CONFIG_RANGE', file: 'archynt.yml', startLine: 4, endLine: 4 },
  }]);
  assert.deepEqual(calls.failures, []);
});

test('scan.js never writes a workflow command by hand', () => {
  const source = fs.readFileSync(path.join(__dirname, 'scan.js'), 'utf8');

  assert.doesNotMatch(source, /['"`]::(error|warning|notice)/);
});
