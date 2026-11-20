import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const workspace = process.argv[2];
if (!workspace) throw new Error('Missing LucidHeart workspace');
const temp = fs.mkdtempSync(path.join(tmpdir(), 'lucidheart-schema-audit-'));
const plugins = ['heart', 'memory', 'fullawake', 'voice-duplex', 'companion', 'evolution',
  'heart-wake', 'qq-plus', 'rvc', 'sticker-look', 'xhs-scroll'];
const quiet = console.log;
console.log = (...args) => console.error(...args);
// Plugin initialization can probe the PC. Only report a detached offline registry here.
globalThis.fetch = async () => new Response('{"online":false}');
globalThis.WebSocket = class extends EventTarget { close() {} };
const entries = [];
try {
  for (const plugin of plugins) {
    const dataDir = path.join(temp, plugin);
    const services = new Map();
    const disposers = [];
    const ctx = {
      tools: {
        register({ name, description, parameters }) {
          entries.push({ plugin, name, description, parameters });
          return () => {};
        },
      },
      systemPrompt: { section: () => {} },
      webServer: { register: () => {} },
      get: name => services.get(name),
      provide: (name, value) => services.set(name, value),
      effect: setup => { disposers.push(setup()); },
      on: () => () => {},
    };
    const module = await import(pathToFileURL(path.join(workspace, 'packages', plugin, 'lib', 'index.js')));
    try {
      const dispose = module.apply(ctx, { root: dataDir, dataDir, pulse: false, runtimeDiagnostics: false,
        injectPrompt: false, gatewayUrl: 'http://127.0.0.1:28765', duplexTarget: 'audit', gameWatchCompanion: true });
      disposers.push(dispose);
    } finally {
      for (const dispose of disposers.reverse()) if (typeof dispose === 'function') dispose();
    }
  }
  process.stdout.write(JSON.stringify(entries));
} finally {
  console.log = quiet;
  fs.rmSync(temp, { recursive: true, force: true });
}
