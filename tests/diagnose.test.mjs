import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnoseTrace } from '../scripts/diagnose.mjs';

const script = fileURLToPath(new URL('../scripts/diagnose.mjs', import.meta.url));
const secret = 'PRIVATE_COOKIE_CSRF_WEBHOOK_TOKEN_DO_NOT_ECHO';
const api = 'https://one.alimama.com/campaign/horizontal/findPage.json';
const date = { startTime: '2026-09-21', endTime: '2026-09-21' };
const request = conditions => ({ stream: 'network', url: api, status: 200,
  requestBody: JSON.stringify({ csrfId: secret, rptQuery: { conditionList: conditions } }) });

async function fixture(t, events = [], receipt) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qianniu-diagnose-test-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('qianniu-diagnose-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  const trace = path.join(directory, '20260921120000-test');
  await mkdir(path.join(trace, 'state'), { recursive: true });
  await writeFile(path.join(trace, 'trace.jsonl'), events.map(event => JSON.stringify(event)).join('\n'));
  if (receipt !== undefined) await writeFile(path.join(trace, 'receipt.json'), JSON.stringify(receipt));
  return { directory, trace };
}

test('all output fields are allowlisted and the CLI never prints trace secrets', async t => {
  const f = await fixture(t, [
    { stream: 'action', name: 'command', phase: 'start', ts: 1000, data: { args: { cookie: secret } } },
    { ...request([{ ...date, extra: secret }]), url: `${api}?csrf=${secret}`, requestHeaders: { Cookie: secret }, responseBody: secret },
    { stream: 'network', url: `https://one.alimama.com/campaign/updatePart.json?csrf=${secret}`, method: 'POST', requestBody: secret },
    { stream: 'network', url: `https://${secret}.invalid/pause-campaign?secret=${secret}`, method: 'POST', status: secret },
    { stream: 'action', name: secret, phase: secret, data: secret },
    { stream: 'action', name: 'command', phase: 'error', ts: 1300, data: { error: `Browser evaluate timeout ${secret}` } },
    { stream: 'error', message: `Browser evaluate timeout ${secret}`, stack: secret },
    { stream: 'state', url: secret, snapshotPath: 'state/0001.json' },
  ], { error: { message: `Browser evaluate timeout ${secret}`, hint: secret }, durationMs: 350, traceId: secret });
  await writeFile(path.join(f.trace, 'state/0001.json'), JSON.stringify(`URL: https://one.alimama.com/index.html#!/manage/search?startTime=2026-09-21&endTime=2026-09-21&csrf=${secret}\n${secret}`));
  const before = await readFile(path.join(f.trace, 'trace.jsonl'), 'utf8');
  const summary = await diagnoseTrace(f.trace);
  assert.equal(summary.traceId, path.basename(f.trace));
  assert.equal(summary.errorKind, 'browser-evaluate-timeout');
  assert.deepEqual(summary.phases, ['start', 'error']);
  assert.equal(summary.durationMs, 350);
  assert.equal(summary.durationSource, 'receipt');
  assert.deepEqual(summary.network, { observed: true, readRequests: 1, writeRequests: 1, otherRequests: 1, writeEvidence: 'observed' });
  assert.deepEqual(summary.targetReads, [{ endpoint: 'targetRead', status: 200, reportDates: [date] }]);
  assert.equal(summary.reportDateComparison, 'match');
  const child = spawnSync(process.execPath, [script, '--trace-dir', f.trace], { encoding: 'utf8' });
  assert.equal(child.status, 0);
  assert.deepEqual(JSON.parse(child.stdout), summary);
  for (const forbidden of [secret, 'https://', 'requestBody', 'requestHeaders', 'responseBody', 'csrfId', 'stack']) {
    assert.ok(!`${child.stdout}${child.stderr}`.includes(forbidden));
  }
  assert.equal(await readFile(path.join(f.trace, 'trace.jsonl'), 'utf8'), before);
});

test('absent start and network evidence stay unknown instead of proving no write', async t => {
  const f = await fixture(t, [
    { stream: 'action', name: 'command', phase: 'error', ts: 1000, data: { error: 'Browser evaluate timed out' } },
    { stream: 'error', message: 'Browser evaluate timed out', ts: 1400 },
  ]);
  const result = await diagnoseTrace(f.trace);
  assert.equal(result.commandStartedObserved, false);
  assert.deepEqual(result.phases, ['error']);
  assert.equal(result.network.observed, false);
  assert.equal(result.network.writeEvidence, 'unknown');
  assert.equal(result.durationMs, 400);
  assert.equal(result.durationSource, 'observed-events-only');
  assert.equal(result.defaultTraceWindowSeconds, 120);
  assert.match(result.observationNote, /cannot prove that no write occurred/);
  assert.match(result.observationNote, /cannot prove that browser work has settled/);
});

test('only exact known endpoints count as reads or writes, regardless of POST', async t => {
  const f = await fixture(t, [
    { ...request([date]), method: 'POST' },
    { stream: 'network', url: 'https://example.invalid/campaign/updatePart.json', method: 'POST' },
    { stream: 'network', url: 'https://one.alimama.com/unrelated?url=/campaign/updatePart.json', method: 'POST' },
    { stream: 'network', url: `${api}/suffix`, method: 'GET' },
  ]);
  const result = await diagnoseTrace(f.trace);
  assert.deepEqual(result.network, { observed: true, readRequests: 1, writeRequests: 0, otherRequests: 3, writeEvidence: 'unknown' });
});

test('request and first-line page dates reveal mismatch without leaking other fields', async t => {
  const f = await fixture(t, [request([date]), { stream: 'state', snapshotPath: 'state/0001.json' }]);
  await writeFile(path.join(f.trace, 'state/0001.json'), JSON.stringify('URL: https://one.alimama.com/index.html#!/manage/search?startTime=2026-09-20&endTime=2026-09-20\nprivate content'));
  const result = await diagnoseTrace(f.trace);
  assert.deepEqual(result.pageReportDates, [{ startTime: '2026-09-20', endTime: '2026-09-20' }]);
  assert.equal(result.reportDateComparison, 'mismatch');
  assert.equal(result.errorKind, 'none');
});

test('invalid dates, bodies and status values cannot carry untrusted text into output', async t => {
  const f = await fixture(t, [
    request([{ startTime: secret, endTime: secret }, { startTime: '2026-02-30', endTime: '2026-09-21' }]),
    { ...request([]), status: secret, requestBody: secret },
    { stream: 'state', snapshotPath: 'state/0001.json' },
  ]);
  await writeFile(path.join(f.trace, 'state/0001.json'), JSON.stringify(`URL: https://one.alimama.com/index.html#!/manage/search?startTime=${secret}&endTime=${secret}`));
  const result = await diagnoseTrace(f.trace);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.deepEqual(result.targetReads.map(item => item.reportDates), [[], []]);
  assert.equal(result.targetReads[1].status, null);
  assert.deepEqual(result.pageReportDates, []);
  assert.equal(result.reportDateComparison, 'unknown');
});

test('state path traversal, absolute paths and unreferenced files are ignored', async t => {
  const f = await fixture(t);
  const snapshot = JSON.stringify('URL: https://one.alimama.com/index.html#!/manage/search?startTime=2026-09-20&endTime=2026-09-20');
  await writeFile(path.join(f.directory, 'outside.json'), snapshot);
  await writeFile(path.join(f.trace, 'state/unreferenced.json'), snapshot);
  await writeFile(path.join(f.trace, 'trace.jsonl'), [
    '../outside.json', 'state/../../outside.json', path.join(f.directory, 'outside.json'),
  ].map(snapshotPath => JSON.stringify({ stream: 'state', snapshotPath })).join('\n'));
  const result = await diagnoseTrace(f.trace);
  assert.deepEqual(result.pageReportDates, []);
  assert.equal(result.evidence.unreadableSnapshots, 3);
});

test('state directory symlinks cannot escape the trace directory', async t => {
  const f = await fixture(t, [{ stream: 'state', snapshotPath: 'state/0001.json' }]);
  const outside = path.join(f.directory, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, '0001.json'), JSON.stringify('URL: https://one.alimama.com/index.html#!/manage/search?startTime=2026-09-20&endTime=2026-09-20'));
  await rm(path.join(f.trace, 'state'), { recursive: true });
  await symlink(outside, path.join(f.trace, 'state'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await diagnoseTrace(f.trace);
  assert.deepEqual(result.pageReportDates, []);
  assert.equal(result.evidence.unreadableSnapshots, 1);
});

test('fixed error categories and command timing are preserved', async t => {
  for (const [message, expected] of [
    ['[PAUSE_PRECHECK:METRICS_CHANGED]', 'metrics-changed'],
    ['[PAUSE_PRECHECK:TARGET_NOT_ACTIVE]', 'target-not-active'],
    ['[PAUSE_PRECHECK:REPORT_CONTEXT_MISMATCH]', 'report-context-mismatch'],
    ['Authentication required: login page is active', 'auth-required'],
    ['Session expired', 'auth-required'],
    [secret, 'other'],
  ]) {
    const f = await fixture(t, [
      { stream: 'action', name: 'command', phase: 'start', ts: 1000 },
      { stream: 'action', name: 'command', phase: 'error', ts: 1900, data: { error: message } },
    ]);
    const result = await diagnoseTrace(f.trace);
    assert.equal(result.errorKind, expected);
    assert.equal(result.durationMs, 900);
    assert.equal(result.durationSource, 'command-events');
    assert.ok(!JSON.stringify(result).includes(secret));
  }
});

test('legacy fixed signatures classify CDP evaluate timeouts and metric prechecks without disclosing text', async t => {
  for (const [message, expected] of [
    [`CDP command Runtime.evaluate timed out after 175s. ${secret}`, 'browser-evaluate-timeout'],
    [`Latest campaign metrics no longer satisfy ROI < max-roi and charge > min-charge ${secret}`, 'metrics-changed'],
    [`CDP command Page.navigate timed out after 175s. ${secret}`, 'other'],
    [`Evaluate report metrics: command timeout ${secret}`, 'other'],
    [`Latest campaign metrics are unavailable ${secret}`, 'other'],
  ]) {
    const f = await fixture(t, [], { status: 'failure', error: { message } });
    const result = await diagnoseTrace(f.trace);
    assert.equal(result.errorKind, expected);
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.ok(!JSON.stringify(result).includes(message));
    assert.equal(result.network.writeEvidence, 'unknown');
  }
});

test('post-write uncertainty takes priority over nested current and legacy precheck signatures', async t => {
  for (const prefix of ['Pause outcome uncertain', 'Pause was requested but verification failed']) {
    for (const nested of [
      '[PAUSE_PRECHECK:METRICS_CHANGED]',
      'Latest campaign metrics no longer satisfy ROI < max-roi and charge > min-charge',
    ]) {
      const message = `${prefix}; do not retry write before reading current status: ${nested} ${secret}`;
      const f = await fixture(t, [
        { stream: 'action', name: 'command', phase: 'error', data: { error: message } },
        { stream: 'error', message: nested },
      ], { status: 'failure', error: { message } });
      const result = await diagnoseTrace(f.trace);
      assert.equal(result.errorKind, 'pause-outcome-uncertain');
      assert.equal(result.network.writeEvidence, 'unknown');
      assert.ok(!JSON.stringify(result).includes(secret));
      assert.ok(!JSON.stringify(result).includes(message));
    }
  }
  const f = await fixture(t, [], { status: 'failure', error: {
    message: 'Pause was requested but verification failed: Authentication required',
  } });
  assert.equal((await diagnoseTrace(f.trace)).errorKind, 'auth-required');
});

test('malformed evidence and CLI failures never echo private parser input or paths', async t => {
  const f = await fixture(t, [], { durationMs: secret, error: { hint: secret } });
  await writeFile(path.join(f.trace, 'trace.jsonl'), `${secret}\nnull\n`);
  const result = await diagnoseTrace(f.trace);
  assert.equal(result.evidence.invalidLines, 2);
  assert.equal(result.durationMs, null);
  assert.ok(!JSON.stringify(result).includes(secret));
  for (const args of [[], ['--unknown', secret], ['--trace-dir'], ['--trace-dir', path.join(f.directory, secret)]]) {
    const child = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(child.status, 1);
    assert.ok(!`${child.stdout}${child.stderr}`.includes(secret));
    assert.equal(JSON.parse(child.stderr).errorKind, 'other');
  }
});
