// Minimal zero-dependency HTTP server exposing the CommandCenter so the
// prototype can be demoed in a browser. Serves a live dashboard (R2 operator
// visibility + R5 supervisor console) and a small JSON API.
//
// Run with:  npm start   (defaults to http://localhost:3000)
//
// The server seeds the repro scenario (R6) on boot so there is something to see.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CommandCenter } from './commandCenter.js';
import { buildScenario } from './simulate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

// Seed with the repro scenario, then hand the CommandCenter a real clock so the
// dashboard's "process" / "resolve" controls behave naturally from here on.
const { cc } = buildScenario();

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  try {
    if (req.method === 'GET' && pathname === '/') {
      const html = await readFile(join(__dirname, '..', 'public', 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (req.method === 'GET' && pathname === '/api/state') {
      return sendJson(res, 200, cc.snapshot());
    }

    if (req.method === 'POST' && pathname === '/api/commands') {
      const body = await readBody(req);
      try {
        return sendJson(res, 201, cc.submit(body));
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (req.method === 'POST' && pathname === '/api/process') {
      const command = cc.processNext();
      if (command) cc.complete(command.id);
      return sendJson(res, 200, { processed: command ? cc.commandView(command) : null });
    }

    if (req.method === 'POST' && pathname === '/api/resolve') {
      const body = await readBody(req);
      try {
        return sendJson(res, 200, cc.resolveConflict(body.conflictId, body.winnerCommandId));
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

// Only listen when run directly, so the module can be imported in tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, () => {
    console.log(`Command queue dashboard on http://localhost:${PORT}`);
  });
}

export { server, cc };
