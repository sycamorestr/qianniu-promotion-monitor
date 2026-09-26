#!/usr/bin/env node
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const help = 'Usage: node scripts/diagnose.mjs --trace-dir DIR\nRead-only, allowlisted JSON summary; never prints raw trace contents.';
const observationNote = 'OpenCLI trace window defaults to 120 seconds. Missing command start or network events cannot prove that no write occurred; a command end/error cannot prove that browser work has settled.';
const detailLimit = 20;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function readContained(root, relative) {
  const file = path.resolve(root, relative);
  if (!inside(root, file)) throw new Error('unavailable');
  const resolved = await realpath(file);
  if (!inside(root, resolved)) throw new Error('unavailable');
  return readFile(resolved, 'utf8');
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function reportDate(value) {
  return object(value) && validDate(value.startTime) && validDate(value.endTime)
    ? { startTime: value.startTime, endTime: value.endTime } : null;
}

function requestDates(body) {
  let parsed = body;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return []; }
  }
  const conditions = parsed?.rptQuery?.conditionList;
  return Array.isArray(conditions) ? conditions.map(reportDate).filter(Boolean) : [];
}

function snapshotDate(snapshot) {
  if (typeof snapshot !== 'string') return null;
  // The page snapshot is a JSON string whose first line contains its URL.
  const firstLine = snapshot.split(/\r?\n/, 1)[0];
  const match = firstLine.match(/https:\/\/[^\s<>"']+/);
  if (!match) return null;
  try {
    const url = new URL(match[0]);
    if (url.origin !== 'https://one.alimama.com' || !url.hash.startsWith('#!')) return null;
    const virtual = new URL(url.hash.slice(2), url.origin);
    return reportDate({ startTime: virtual.searchParams.get('startTime'), endTime: virtual.searchParams.get('endTime') });
  } catch { return null; }
}

function endpoint(url) {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://one.alimama.com') return 'other';
    // These are the two existing adapter methods, not guessed from HTTP verbs.
    if (parsed.pathname === '/campaign/horizontal/findPage.json') return 'targetRead';
    if (parsed.pathname === '/campaign/updatePart.json') return 'campaignUpdate';
  } catch { /* Unrecognized URLs count only as other. */ }
  return 'other';
}

function errorText(value) {
  if (typeof value === 'string') return value;
  if (!object(value)) return '';
  return [value.code, value.message].filter(part => typeof part === 'string').join(' ');
}

function classifyError(errors, hasError) {
  const text = errors.join('\n');
  if (/AUTH_REQUIRED|(?:authentication|authorization|login|sign[- ]?in) required|not logged[- ]?in|logged[- ]?in shop identity is unavailable|(?:login|session|cookie).*(?:expired|invalid)|未登录|登录(?:态)?(?:已)?(?:过期|失效)|会话(?:已)?(?:过期|失效)/i.test(text)) return 'auth-required';
  // A nested precheck message cannot undo an already attempted write.
  if (/Pause outcome uncertain|Pause was requested but verification failed/.test(text)) return 'pause-outcome-uncertain';
  if (/\[PAUSE_PRECHECK:REPORT_CONTEXT_MISMATCH\]/.test(text)) return 'report-context-mismatch';
  if (/\[PAUSE_PRECHECK:METRICS_CHANGED\]/.test(text)
      || text.includes('Latest campaign metrics no longer satisfy ROI < max-roi and charge > min-charge')) return 'metrics-changed';
  if (/\[PAUSE_PRECHECK:TARGET_NOT_ACTIVE\]/.test(text)) return 'target-not-active';
  if (/\bCDP command Runtime\.evaluate timed out after \d+(?:\.\d+)?s\b/.test(text)) return 'browser-evaluate-timeout';
  if (/(?:browser[^\n]*evaluate|evaluate[^\n]*browser)[^\n]*(?:timed?\s*out|timeout)|(?:timed?\s*out|timeout)[^\n]*(?:browser[^\n]*evaluate|evaluate[^\n]*browser)/i.test(text)) return 'browser-evaluate-timeout';
  return hasError || text ? 'other' : 'none';
}

/** Read local evidence only. Every returned field is constructed from a fixed allowlist. */
export async function diagnoseTrace(traceDir) {
  if (typeof traceDir !== 'string' || !traceDir.trim()) throw new Error('invalid-arguments');
  let root, source;
  try {
    root = await realpath(path.resolve(traceDir));
    source = await readContained(root, 'trace.jsonl');
  } catch { throw new Error('trace-unavailable'); }
  const events = [];
  let invalidLines = 0;
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (object(event)) events.push(event);
      else invalidLines++;
    } catch { invalidLines++; }
  }
  let receipt = null;
  try { receipt = JSON.parse(await readContained(root, 'receipt.json')); } catch { /* Optional evidence. */ }
  const commands = events.filter(event => event.stream === 'action' && event.name === 'command'
    && ['start', 'end', 'error'].includes(event.phase));
  const phases = [...new Set(commands.map(event => event.phase))];
  const errors = [errorText(receipt?.error), ...events.filter(event => event.stream === 'error').map(errorText),
    ...commands.filter(event => event.phase === 'error').map(event => errorText(event.data?.error))].filter(Boolean);
  const hasError = receipt?.status === 'failure' || phases.includes('error') || events.some(event => event.stream === 'error');
  let durationMs = finite(receipt?.durationMs) ? receipt.durationMs : null;
  let durationSource = durationMs === null ? 'unknown' : 'receipt';
  if (durationMs === null) {
    const start = commands.find(event => event.phase === 'start' && finite(event.ts));
    const end = commands.findLast(event => event.phase !== 'start' && finite(event.ts));
    if (start && end && end.ts >= start.ts) {
      durationMs = end.ts - start.ts;
      durationSource = 'command-events';
    } else {
      const times = events.map(event => event.ts).filter(finite);
      if (times.length > 1) {
        durationMs = Math.max(...times) - Math.min(...times);
        durationSource = 'observed-events-only';
      }
    }
  }
  const networkEvents = events.filter(event => event.stream === 'network');
  const network = { observed: networkEvents.length > 0, readRequests: 0, writeRequests: 0, otherRequests: 0,
    writeEvidence: 'unknown' };
  const targetReads = [];
  const allRequestDates = [];
  for (const event of networkEvents) {
    const kind = endpoint(event.url);
    if (kind === 'targetRead') {
      network.readRequests++;
      const dates = requestDates(event.requestBody);
      allRequestDates.push(...dates);
      if (targetReads.length < detailLimit) targetReads.push({
        endpoint: 'targetRead',
        status: Number.isInteger(event.status) && event.status >= 100 && event.status <= 599 ? event.status : null,
        reportDates: dates.slice(0, detailLimit),
      });
    } else if (kind === 'campaignUpdate') network.writeRequests++;
    else network.otherRequests++;
  }
  if (network.writeRequests) network.writeEvidence = 'observed';
  const pageReportDates = [];
  const allPageDates = [];
  let unreadableSnapshots = 0;
  for (const event of events.filter(event => event.stream === 'state' && event.snapshotPath !== undefined)) {
    try {
      // Accept only a directly referenced state/*.json, never arbitrary paths or globs.
      if (typeof event.snapshotPath !== 'string' || !/^state[\\/][^\\/:]+\.json$/.test(event.snapshotPath)) throw new Error('unavailable');
      const snapshot = JSON.parse(await readContained(root, event.snapshotPath.replaceAll('\\', '/')));
      const date = snapshotDate(snapshot);
      if (date) {
        allPageDates.push(date);
        if (pageReportDates.length < detailLimit) pageReportDates.push(date);
      }
    } catch { unreadableSnapshots++; }
  }
  const key = date => `${date.startTime}/${date.endTime}`;
  let reportDateComparison = 'unknown';
  if (allRequestDates.length && allPageDates.length) {
    const dates = new Set([...allRequestDates, ...allPageDates].map(key));
    reportDateComparison = dates.size === 1 ? 'match' : 'mismatch';
  }
  return {
    traceId: path.basename(path.resolve(traceDir)),
    errorKind: classifyError(errors, hasError),
    phases,
    commandStartedObserved: phases.includes('start'),
    durationMs,
    durationSource,
    defaultTraceWindowSeconds: 120,
    observationNote,
    network,
    targetReads,
    pageReportDates,
    reportDateComparison,
    evidence: { invalidLines, unreadableSnapshots, detailsTruncated: network.readRequests > detailLimit
      || allRequestDates.length > detailLimit || allPageDates.length > detailLimit },
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log(help); return; }
  if (args.length !== 2 || args[0] !== '--trace-dir' || !args[1] || args[1].startsWith('--')) throw new Error('invalid-arguments');
  console.log(JSON.stringify(await diagnoseTrace(args[1]), null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Parser and filesystem errors can contain private input. Never print them.
    const diagnosticError = ['invalid-arguments', 'trace-unavailable'].includes(error?.message) ? error.message : 'diagnostic-failed';
    console.error(JSON.stringify({ errorKind: 'other', diagnosticError }));
    process.exitCode = 1;
  });
}
