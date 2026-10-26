/**
 * What the probe promises: it reports, it never throws, and it leaves no socket behind.
 *
 * The Host it will run inside is a person's desktop application, so the tests fake the Host rather
 * than trusting it — including the Host that refuses every declaration, which is the one that would
 * otherwise take the app down with it.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** A sandbox home so the probe writes its log where the test can read it, not into a real one. */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-test-'));
process.env.USERPROFILE = sandbox;
process.env.TEMP = sandbox;
const logFile = path.join(sandbox, '.dsh', 'logs', 'dsh-service-probe.jsonl');

const probe = require('../index.cjs');
const results = [];
const check = (name, condition, detail) => results.push({ name, ok: Boolean(condition), detail });

/** Reads every record written so far. */
function records() {
  if (!fs.existsSync(logFile)) return [];
  return fs
    .readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Waits until `condition` holds, so the async phases can be observed. */
async function until(condition, timeoutMs = 9000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((done) => setTimeout(done, 25));
  }
  return false;
}

/**
 * A Host that hands over most services but not `webServer` — the desktop Host's shape.
 *
 * `inject` fires only for names the Host actually has, which is how a cordis service becomes
 * visible at all; a plugin that merely calls `get` sees nothing.
 */
function workingHost() {
  const service = () => ({ ping: () => 'pong' });
  return {
    inject: (deps, callback) => {
      const name = deps[0];
      if (name === 'webServer') return () => {};
      callback({ get: () => service(), [name]: service() });
      return () => {};
    },
    effect: (callback) => {
      callback();
    },
    on: () => () => {},
    get: () => undefined,
    logger: { info() {}, warn() {} },
  };
}

(async () => {
  // 1) A Host with services: the inventory must name them, and the listener must work.
  probe.apply(workingHost());
  const sawListener = await until(() => records().some((line) => line.phase === 'listener'));
  const lines = records();
  check('写了 load 记录', lines.some((line) => line.phase === 'load'));
  check('写了 surface 记录', lines.some((line) => line.phase === 'surface'));

  const serviceLines = lines.filter((line) => line.phase === 'service');
  check('逐个服务都有记录', serviceLines.length >= 20, serviceLines.length);
  check('sessionQuery 被认出', serviceLines.some((line) => line.name === 'sessionQuery' && line.present === true));
  check('webServer 没被认出（Host 未提供）', !serviceLines.some((line) => line.name === 'webServer' && line.present === true));
  const queryLine = serviceLines.find((line) => line.name === 'sessionQuery');
  check('记下了服务的构造函数名', queryLine && queryLine.constructor === 'Object', queryLine);

  const listenerLine = lines.find((line) => line.phase === 'listener');
  check('监听阶段有结论', sawListener && Boolean(listenerLine));
  check('能开本地端口', listenerLine && listenerLine.ok === true, listenerLine);
  check('端口可自连', listenerLine && listenerLine.roundTrip === true, listenerLine);
  check('用的是临时端口', listenerLine && typeof listenerLine.port === 'number' && listenerLine.port > 0, listenerLine);

  // 2) The summary must make absence visible, not just presence.
  const sawSurvey = await until(() => records().some((line) => line.phase === 'survey'));
  const survey = records().find((line) => line.phase === 'survey');
  check('写了 survey 汇总', sawSurvey && Boolean(survey));
  check('汇总里点出缺失的 webServer', survey && survey.missing.includes('webServer'), survey && survey.missing.slice(0, 4));
  check('汇总里点出已解析的 sessionQuery', survey && survey.resolved.includes('sessionQuery'), survey && survey.resolved.slice(0, 4));

  // 3) A Host that refuses every declaration: the probe must survive it.
  let threw = null;
  try {
    probe.apply({
      inject: () => {
        throw new Error('declaration denied');
      },
      effect: (callback) => callback(),
      on: () => () => {},
      get: () => undefined,
    });
  } catch (err) {
    threw = err;
  }
  check('声明抛错时 apply 不抛', threw === null, threw && threw.message);
  check('把抛错写进了记录', records().some((line) => String(line.injectError).includes('denied')));

  // 4) A Host with no `inject` at all: still no throw.
  let threwBare = null;
  try {
    probe.apply({ effect: () => {}, on: () => () => {} });
  } catch (err) {
    threwBare = err;
  }
  check('没有 inject 也不抛', threwBare === null, threwBare && threwBare.message);

  // 5) Defensive against a Host that calls apply twice (reloads happen).
  let threwTwice = null;
  try {
    probe.apply(workingHost());
    probe.apply(workingHost());
  } catch (err) {
    threwTwice = err;
  }
  check('重复 apply 不抛', threwTwice === null, threwTwice && threwTwice.message);

  // 6) Every line is one JSON object — the log must stay machine-readable even when steps fail.
  const finalLines = records();
  check('日志每行都是合法 JSON', finalLines.length > 0 && finalLines.every((line) => typeof line === 'object' && line !== null));
  check('每次都带 timestamp', finalLines.every((line) => typeof line.at === 'string'));

  // 7) The temp copy is written too, so a wiped log directory does not lose the answer.
  check('同时写了 TEMP 副本', fs.existsSync(path.join(sandbox, 'dsh-service-probe.jsonl')));

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  -> ' + JSON.stringify(r.detail)}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} 通过`);
  console.log(`日志: ${logFile}`);
  process.exit(failed === 0 ? 0 : 1);
})();
