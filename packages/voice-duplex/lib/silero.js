import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const worker = fileURLToPath(new URL('./silero_worker.py', import.meta.url));

export class Silero {
  #child;
  #lines;
  #pending;
  #failed;

  constructor({ python, model, sha256 }) {
    this.#child = spawn(python, ['-u', worker, model, sha256], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.#lines = createInterface({ input: this.#child.stdout });
    this.#lines.on('line', line => this.#pending?.resolve(line));
    this.#child.on('exit', code => this.#fail(new Error(`Silero worker stopped (${code})`)));
    this.#child.on('error', error => this.#fail(error));
    this.#child.stdin.on('error', error => this.#fail(error));
    this.ready = this.#reply(10_000).then(line => {
      if (line !== 'ready') throw new Error('Silero worker handshake failed');
    });
  }

  #fail(error) {
    this.#failed = error;
    this.#pending?.reject(error);
  }

  async #reply(timeout, data) {
    if (this.#failed) throw this.#failed;
    if (this.#pending) throw new Error('Silero worker request already in flight');
    this.#pending = Promise.withResolvers();
    const timer = setTimeout(() => {
      this.#fail(new Error('Silero worker timed out'));
      this.close();
    }, timeout);
    try {
      if (data) this.#child.stdin.write(data);
      return await this.#pending.promise;
    } finally {
      clearTimeout(timer);
      this.#pending = null;
    }
  }

  async reset() {
    if (await this.#reply(500, 'R') !== 'reset') throw new Error('Silero reset failed');
  }

  async score(pcm) {
    const score = Number(await this.#reply(500, Buffer.concat([Buffer.from('F'), pcm])));
    if (!Number.isFinite(score) || score < 0 || score > 1) throw new Error('Silero returned an invalid score');
    return score;
  }

  close() {
    this.#lines.close();
    this.#child.stdin.end();
    this.#child.kill();
  }
}
