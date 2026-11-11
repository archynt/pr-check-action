'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const run = require('./scan');

const BASE_SHA = '1111111111111111111111111111111111111111';
const HEAD_SHA = '2222222222222222222222222222222222222222';
const HOSTILE_BRANCH = 'a";echo${IFS}pwned;#$(id)`id`';

/**
 * @param {{status?: number, json?: any, commentError?: {status: number, message: string}, fetchError?: Error}} options
 */
function harness(options = {}) {
  const calls = { requests: [], comments: [], summary: [], notices: [], warnings: [], failures: [] };
  const summary = {
    addRaw(text) {
      calls.summary.push(text);
      return summary;
    },
    async write() {
      return summary;
    },
  };
  const core = {
    summary,
    notice: (message) => calls.notices.push(message),
    warning: (message) => calls.warnings.push(message),
    setFailed: (message) => calls.failures.push(message),
  };
  const github = {
    rest: {
      issues: {
        async createComment(comment) {
          if (options.commentError) {
            throw Object.assign(new Error(options.commentError.message), { status: options.commentError.status });
          }
          calls.comments.push(comment);
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
  return { calls, deps: { github, context, core, fetchImpl, env } };
}

const ANALYZED = { verdict: 'FAIL', summaryMarkdown: '## Archynt\nFAIL' };

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

test('posts the summary as a comment and in the job summary, and a FAIL verdict does not fail the job', async () => {
  const { calls, deps } = harness({ json: ANALYZED });

  await run(deps);

  assert.deepEqual(calls.comments, [{ owner: 'acme', repo: 'shop', issue_number: 7, body: '## Archynt\nFAIL' }]);
  assert.deepEqual(calls.summary, ['## Archynt\nFAIL']);
  assert.deepEqual(calls.failures, []);
});

test('a read-only token (fork PR) keeps the result in the job summary without failing', async () => {
  const { calls, deps } = harness({ json: ANALYZED, commentError: { status: 403, message: 'Resource not accessible by integration' } });

  await run(deps);

  assert.equal(calls.summary[0], '## Archynt\nFAIL');
  assert.match(calls.summary[1], /read-only token/);
  assert.deepEqual(calls.failures, []);
  assert.equal(calls.notices.length, 1);
});

test('any other comment failure fails the job', async () => {
  const { calls, deps } = harness({ json: ANALYZED, commentError: { status: 500, message: 'Server Error' } });

  await run(deps);

  assert.match(calls.failures[0], /comment could not be posted/);
});

test('a superseded commit is reported without commenting or failing', async () => {
  const { calls, deps } = harness({ json: { status: 'SUPERSEDED', currentSha: '3333333333333333' } });

  await run(deps);

  assert.deepEqual(calls.comments, []);
  assert.deepEqual(calls.failures, []);
  assert.match(calls.notices[0], /3333333/);
});

test('a full Archynt queue warns without failing', async () => {
  const { calls, deps } = harness({ status: 503, json: { status: 'UNAVAILABLE', reason: 'BUSY' } });

  await run(deps);

  assert.equal(calls.warnings.length, 1);
  assert.deepEqual(calls.failures, []);
  assert.deepEqual(calls.comments, []);
});

test('a scan that could not run fails the job with its reason', async () => {
  const { calls, deps } = harness({ status: 422, json: { status: 'UNAVAILABLE', reason: 'COMMIT_NOT_FOUND' } });

  await run(deps);

  assert.deepEqual(calls.failures, ['Archynt could not scan this pull request (HTTP 422: COMMIT_NOT_FOUND).']);
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
  assert.deepEqual(noSummary.calls.comments, []);
});
