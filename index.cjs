/**
 * dsh-service-probe — report what the Host this plugin is loaded into can actually do.
 *
 * Written to answer one question without guessing: *can a plugin that lives inside the desktop
 * application reach a person?* The desktop host is described in its own source as booting
 * "without a listening socket", so the bridge cannot use the Host's web server there — but a
 * plugin may still be able to open its own loopback listener. That is phase `listener` below.
 *
 * A finding from the first run of this probe, kept because it changes how the answer must be read:
 * **`ctx.get('name')` returns nothing for a service this plugin never declared.** Cordis isolates
 * services per fiber, so a plugin sees only what it `inject`s. A survey built on `get` therefore
 * reports every service absent — including ones that are mounted. So the real inventory comes from
 * one `inject([name])` per candidate: the callback firing *is* the evidence, and its absence is the
 * answer. Phase `service` carries the positive results, phase `survey` the summary of both.
 *
 * Three rules, in order of importance:
 *
 *  1. **Never throw.** `apply` is called while the Host boots. An exception here is not a failed
 *     probe, it is a person's application failing to start. Every step is wrapped, and a failure is
 *     recorded as a failed step rather than raised.
 *  2. **Never hold the port.** The listener is opened on port 0, checked with one real request to
 *     itself, then closed and unref'd, so the probe leaves no socket behind.
 *  3. **Never depend on anything.** No imports beyond Node builtins, no build step, no install
 *     scripts — the file the Host loads is the file in this package.
 *
 * Output is JSONL, one line per phase, at `%USERPROFILE%\.dsh\logs\dsh-service-probe.jsonl` and
 * `%TEMP%\dsh-service-probe.jsonl`, plus a copy on stdout (which the Host usually captures).
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const PLUGIN = 'dsh-service-probe';

/**
 * The services a bridge, a conversation listing, or a listener would need.
 *
 * `webServer` first because it is the one the desktop Host is known to disable; `sessionQuery`
 * because the conversation listing needs it; `connection` because it is what the desktop Host uses
 * instead of a web server.
 */
const SERVICES = [
  'webServer',
  'webStartup',
  'webRuntime',
  'connection',
  'credentials',
  'sessionQuery',
  'sessionPersistence',
  'sessions',
  'sessionProjections',
  'sessionTitle',
  'llm',
  'logger',
  'timer',
  'loader',
  'settings',
  'storage',
  'workspace',
  'attachments',
  'subagents',
  'jobs',
  'shell',
  'terminal',
  'cmdline',
  'launchEnvironment',
];

/** Names every plain object has; a service's real API is what is left after removing them. */
const OBJECT_PROTO = new Set(Object.getOwnPropertyNames(Object.prototype));

/** How far one record may go describing a service, so a probe cannot dump a whole object graph. */
const KEY_LIMIT = 12;

/** How long the inventory waits before writing its summary line. */
const SURVEY_MS = 4000;

/** Where a probe line is written: the DSH log directory, and a temp copy that survives a wipe. */
function destinations() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const list = [];
  if (home) list.push(path.join(home, '.dsh', 'logs', 'dsh-service-probe.jsonl'));
  if (process.env.TEMP) list.push(path.join(process.env.TEMP, 'dsh-service-probe.jsonl'));
  return list;
}

/** Appends one JSON line everywhere it can, and never lets a write failure reach the Host. */
function record(line) {
  const text = `${JSON.stringify(line)}\n`;
  for (const file of destinations()) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, text);
    } catch {
      // a Host that cannot write its own log directory still runs; the probe is a courtesy
    }
  }
  try {
    process.stdout.write(`[${PLUGIN}] ${text}`);
  } catch {
    // a closed stdout must not become an exception
  }
}

/** A short, safe description of one resolved service. */
function describe(value) {
  if (value === undefined) return { present: false };
  if (value === null) return { present: true, type: 'null' };
  const out = { present: true, type: typeof value };
  if (typeof value === 'object' || typeof value === 'function') {
    try {
      const ctor = value.constructor && value.constructor.name;
      if (typeof ctor === 'string' && ctor) out.constructor = ctor;
    } catch {
      // a proxy that refuses its constructor is still a present service
    }
    try {
      out.keys = Object.keys(value).slice(0, KEY_LIMIT);
    } catch {
      // ignore: the key list is a convenience
    }
    try {
      out.methods = Object.getOwnPropertyNames(Object.getPrototypeOf(value))
        .filter((name) => name !== 'constructor' && !OBJECT_PROTO.has(name))
        .slice(0, KEY_LIMIT);
    } catch {
      // a host object may have no usable prototype
    }
  }
  return out;
}

/** The cordis surface `apply` was handed, as far as it can be seen. */
function surface(root) {
  const out = {};
  for (const key of ['inject', 'effect', 'on', 'get', 'provide', 'plugin', 'logger']) {
    try {
      out[key] = typeof root[key];
    } catch {
      out[key] = 'throws';
    }
  }
  return out;
}

/**
 * Asks the Host which services it will hand over, one `inject` per candidate.
 *
 * This is the only way to see a cordis service: `get` reports what this plugin declared, and a
 * plugin that declares nothing sees nothing. A callback that fires is proof the service is mounted
 * and reachable from here; a callback that never fires is the answer for that name.
 */
function inventory(root, resolved) {
  for (const name of SERVICES) {
    try {
      root.inject([name], (scoped) => {
        if (resolved.has(name)) return;
        resolved.add(name);
        try {
          const value = scoped && typeof scoped.get === 'function' ? scoped.get(name) : scoped && scoped[name];
          record({ phase: 'service', at: new Date().toISOString(), name, ...describe(value) });
        } catch (err) {
          record({ phase: 'service', at: new Date().toISOString(), name, present: true, describeError: String((err && err.message) || err) });
        }
      });
    } catch (err) {
      record({ phase: 'service', at: new Date().toISOString(), name, present: false, injectError: String((err && err.message) || err) });
    }
  }
}

/**
 * Whether this process may open a loopback port at all.
 *
 * This is the question behind the probe: the desktop Host does not listen, but the plugin might.
 * The socket is opened on port 0 (the OS picks), asked one real request, then closed and unref'd.
 */
function probeListener() {
  return new Promise((resolve) => {
    let server = null;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        if (server) {
          server.close();
          if (typeof server.unref === 'function') server.unref();
        }
      } catch {
        // an already-failed listen leaves nothing to close
      }
      resolve(result);
    };
    try {
      server = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`${PLUGIN} ok`);
      });
      server.on('error', (err) => finish({ ok: false, error: String((err && err.message) || err) }));
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = address && address.port;
        const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => finish({ ok: true, port, roundTrip: body.includes('ok') }));
        });
        req.on('error', (err) => finish({ ok: true, port, roundTrip: false, requestError: String((err && err.message) || err) }));
        req.on('timeout', () => {
          req.destroy();
          finish({ ok: true, port, roundTrip: false, requestError: 'timeout' });
        });
      });
      // A Host that never calls back must not leave the probe hanging forever.
      const guard = setTimeout(() => finish({ ok: false, error: 'listen did not answer within 5s' }), 5000);
      if (typeof guard.unref === 'function') guard.unref();
    } catch (err) {
      finish({ ok: false, error: String((err && err.message) || err) });
    }
  });
}

/** The plugin row a bundle patch inserts. */
exports.name = PLUGIN;

/**
 * Records everything it can find out, and returns without raising whatever happens.
 *
 * @param root - the Host's plugin context.
 */
exports.apply = function apply(root) {
  const resolved = new Set();

  try {
    record({
      phase: 'load',
      at: new Date().toISOString(),
      pid: process.pid,
      execPath: process.execPath,
      argv: process.argv.slice(0, 8),
      cwd: process.cwd(),
      platform: `${process.platform}/${process.arch}`,
      node: process.versions.node,
      electron: process.versions.electron || null,
      dshHome: process.env.DSH_HOME || null,
      candidates: SERVICES.length,
    });
  } catch {
    // identity is convenience; the inventory below is the point
  }

  try {
    record({ phase: 'surface', at: new Date().toISOString(), handle: surface(root) });
  } catch (err) {
    record({ phase: 'surface', at: new Date().toISOString(), error: String((err && err.message) || err) });
  }

  try {
    inventory(root, resolved);
  } catch (err) {
    record({ phase: 'service', at: new Date().toISOString(), error: String((err && err.message) || err) });
  }

  try {
    const timer = setTimeout(() => {
      try {
        record({
          phase: 'survey',
          at: new Date().toISOString(),
          resolved: SERVICES.filter((name) => resolved.has(name)),
          missing: SERVICES.filter((name) => !resolved.has(name)),
        });
      } catch {
        // the summary is a courtesy
      }
    }, SURVEY_MS);
    if (typeof timer.unref === 'function') timer.unref();
  } catch {
    // a Host without timers still gets the per-service lines
  }

  try {
    probeListener()
      .then((result) => record({ phase: 'listener', at: new Date().toISOString(), ...result }))
      .catch((err) => record({ phase: 'listener', at: new Date().toISOString(), ok: false, error: String((err && err.message) || err) }));
  } catch (err) {
    record({ phase: 'listener', at: new Date().toISOString(), ok: false, error: String((err && err.message) || err) });
  }
};
