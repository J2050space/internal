// Runs tests/webmcp.html in a headless Chromium with the WebMCP feature enabled
// and prints the assertions. No dependencies: Node 22+ and a Chrome/Chromium binary.
//
//   node tests/run-webmcp.mjs
//   CHROME=/path/to/chrome node tests/run-webmcp.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let file = normalize(join(ROOT, path));
    if (file !== ROOT && !file.startsWith(ROOT + sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const info = await stat(file).catch(() => null);
    if (info?.isDirectory()) file = join(file, 'index.html');
    const body = await stat(file).catch(() => null);
    if (!body?.isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(await readFile(file));
  } catch (error) {
    res.writeHead(500).end(String(error));
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}: ${error.message}`);
      await sleep(100);
    }
  }
}

function cdp(webSocketUrl) {
  const ws = new WebSocket(webSocketUrl);
  const pending = new Map();
  let nextId = 0;
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('CDP connection failed'));
  });
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  };
  return {
    ready,
    send(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { ws.close(); },
  };
}

let browser = null;
let profileDir = null;

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  profileDir = await mkdtemp(join(tmpdir(), 'webmcp-'));
  const chrome = process.env.CHROME || process.env.CHROMIUM || 'chromium';
  browser = spawn(chrome, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--enable-features=WebMCP',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  browser.stderr.on('data', (chunk) => { stderr += chunk; });

  const browserPort = await waitFor(async () => {
    const file = await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8');
    return Number(file.split('\n')[0]);
  }, 15_000, 'Chromium DevTools port').catch((error) => {
    throw new Error(`${error.message}\n${stderr.slice(-2000)}`);
  });

  const targets = await waitFor(async () => {
    const res = await fetch(`http://127.0.0.1:${browserPort}/json/list`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }, 10_000, 'Chromium targets');
  const page = targets.find((target) => target.type === 'page');
  if (!page) throw new Error('no page target in Chromium');

  const client = cdp(page.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Page.enable');
  await client.send('Page.navigate', { url: `${origin}/tests/webmcp.html` });

  const expression = `new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (window.__webmcpResults) resolve(window.__webmcpResults);
      else if (Date.now() - start > 15000) resolve({ done: true, timeout: true, results: [], passed: 0, failed: 1 });
      else setTimeout(tick, 100);
    };
    tick();
  })`;

  const evaluated = await Promise.race([
    client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
    sleep(30_000).then(() => { throw new Error('timeout waiting for the test page'); }),
  ]);
  client.close();

  const report = evaluated.result?.value;
  if (!report) throw new Error(`unexpected CDP result: ${JSON.stringify(evaluated).slice(0, 800)}`);

  for (const result of report.results ?? []) {
    console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${result.name}${result.error ? `\n     ${result.error}` : ''}`);
  }
  if (report.timeout) console.log('FAIL the test page did not finish within 15 s (did it load?)');
  console.log(`\n${report.passed} passed, ${report.failed} failed`);
  process.exitCode = report.failed ? 1 : 0;
} catch (error) {
  console.error(`webmcp tests failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (browser) {
    browser.kill('SIGKILL');
    await new Promise((resolve) => browser.once('exit', resolve));
  }
  server.close();
  if (profileDir) {
    await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
}
