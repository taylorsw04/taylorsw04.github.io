import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDocsServer } from './serve-docs.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

function errorText(error) {
  return String(error?.message || error)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(-16000);
}

export async function snapshotDocsInputs(root = projectRoot) {
  const files = [
    'scripts/build.mjs',
    'scripts/docs-plugins.mjs',
    'scripts/render-markdown.mjs',
    'content/site.json',
    'content/posts.json',
  ];
  async function collect(directory, recursive) {
    const entries = await readdir(path.join(root, directory), { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      const name = path.join(directory, entry.name);
      if (entry.isDirectory() && recursive) await collect(name, true);
      else if (entry.isFile() && (directory === '' ? /\.ts$/ : /\.(?:[cm]?tsx?|[cm]?jsx?|css|html|json|md)$/).test(entry.name)) {
        if (!/\.(?:test|nontest)\./.test(entry.name)) files.push(name);
      }
    }
  }
  await Promise.all([
    collect('docs/web', true),
    collect('extended', true),
    collect('content', true),
    collect('site', true),
    collect('public', true),
    collect('', false),
  ]);
  const snapshots = await Promise.all(files.sort().map(async name => {
    const info = await lstat(path.join(root, name), { bigint: true }).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    return info ? `${name}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` : `${name}:missing`;
  }));
  return snapshots.join('\n');
}

function runBuilder(root, signal, log) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Build cancelled.'));
      return;
    }
    const child = spawn(process.execPath, [path.join(root, 'scripts/build.mjs')], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let killTimer;
    const append = chunk => { output = (output + chunk.toString()).slice(-32000); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const abort = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
      killTimer.unref();
    };
    const cleanup = () => {
      clearTimeout(killTimer);
      signal.removeEventListener('abort', abort);
    };
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', error => {
      cleanup();
      reject(error);
    });
    child.once('close', (code, termination) => {
      cleanup();
      if (code === 0 && !signal.aborted) {
        if (output.trim()) log(errorText(output.trim()));
        resolve();
      } else {
        reject(new Error(output.trim() || `Documentation build ${termination ? `stopped (${termination})` : `exited with code ${code}`}.`));
      }
    });
  });
}

export async function startDocsDev({
  root = projectRoot,
  outputPath = path.join(root, 'dist'),
  port = process.env.PORT ?? '4174',
  pollInterval = 200,
  debounceMs = 120,
  build = ({ signal }) => runBuilder(root, signal, log),
  snapshot = () => snapshotDocsInputs(root),
  log = console.log,
  signal,
} = {}) {
  const session = randomUUID();
  const abort = new AbortController();
  const listeners = new Set();
  let revision = 0;
  let state = { generation: `${session}:0`, error: null };
  let dirty = true;
  let stopped = false;
  let running;
  let polling;
  let debounce;
  let interval;
  let preview;
  let closing;
  let previous = await snapshot();

  const notify = error => {
    state = { generation: `${session}:${revision}`, error };
    for (const listener of listeners) listener(state);
  };
  const schedule = () => {
    if (stopped) return;
    dirty = true;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      void rebuild();
    }, debounceMs);
  };
  const rebuild = () => {
    if (stopped || running || !dirty) return running;
    dirty = false;
    running = Promise.resolve().then(() => build({ signal: abort.signal })).then(() => {
      if (stopped) return;
      revision++;
      notify(null);
      log(`Documentation rebuilt (${revision}).`);
    }).catch(error => {
      if (stopped) return;
      const message = errorText(error);
      notify(message);
      log(`Documentation build failed:\n${message}`);
    }).finally(() => {
      running = undefined;
      // Edits arriving while a build runs stay dirty, even if their debounce
      // already elapsed. Only one builder is ever active.
      if (dirty && !debounce && !stopped) schedule();
    });
    return running;
  };
  const close = () => {
    if (closing) return closing;
    stopped = true;
    clearInterval(interval);
    clearTimeout(debounce);
    abort.abort();
    signal?.removeEventListener('abort', close);
    closing = Promise.all([preview?.close(), running, polling]).then(() => {
      listeners.clear();
    });
    return closing;
  };
  signal?.addEventListener('abort', close, { once: true });
  if (signal?.aborted) await close();
  try {
    if (stopped) throw new Error('Documentation preview startup cancelled.');
    interval = setInterval(() => {
      if (polling || stopped) return;
      polling = Promise.resolve().then(snapshot).then(next => {
        if (next !== previous) {
          previous = next;
          schedule();
        }
      }).catch(error => {
        if (!stopped) {
          const message = `Cannot watch documentation inputs: ${errorText(error)}`;
          if (state.error !== message) {
            notify(message);
            log(message);
          }
        }
      }).finally(() => { polling = undefined; });
    }, pollInterval);
    await rebuild();
    if (stopped) throw new Error('Documentation preview startup cancelled.');
    preview = await startDocsServer({
      port,
      outputPath,
      dev: {
        getState: () => state,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    });
    if (stopped) {
      await preview.close();
      throw new Error('Documentation preview startup cancelled.');
    }
    return { ...preview, getState: () => ({ ...state }), close };
  } catch (error) {
    await close();
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  startDocsDev({ signal: shutdown.signal }).then(preview => {
    console.log(`Live documentation preview at http://localhost:${preview.port}`);
    console.log('Watching Markdown, docs/web, build scripts, and library TypeScript. Press Ctrl+C to stop.');
  }).catch(error => {
    if (!shutdown.signal.aborted) {
      console.error('Cannot start the live documentation preview:', error);
      process.exitCode = 1;
    }
  });
}
