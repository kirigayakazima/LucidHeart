import { randomUUID } from 'node:crypto';
import { getZonedParts, shanghaiDay } from './store.js';

export class ProjectLedger {
  entries = new Map();

  constructor(store, ensureCurrent = () => {}) {
    this.store = store;
    this.ensureCurrent = ensureCurrent;
  }

  #save(entry) {
    try {
      this.store.appendJournal(entry, 'project');
    } catch (error) {
      try { this.store.loadAllFromJournal(undefined, this.entries); } catch {}
      throw error;
    }
    this.entries.set(entry.id, entry);
    return { ...entry };
  }

  list(scope) {
    this.ensureCurrent();
    return [...this.entries.values()].filter(entry => entry.scope === scope).map(entry => ({ ...entry }));
  }

  start({ scope, title, goal, evidence }, now = new Date()) {
    const existing = this.list(scope).find(item => item.title === title && item.status === 'active');
    if (existing) return existing;
    const updatedAt = now.toISOString();
    return this.#save({
      id: `project_${randomUUID()}`, scope, title, goal, evidence,
      progress: 0, revision: 1, status: 'active', updatedAt, note: '',
    });
  }

  update({ scope, id, revision, progress, note, evidence, cancel }, now = new Date()) {
    this.ensureCurrent();
    const entry = this.entries.get(id);
    if (entry?.scope !== scope) return { status: 'missing' };
    if (entry.revision !== revision) return { status: 'stale', project: { ...entry } };
    if (entry.status !== 'active') return { status: 'closed', project: { ...entry } };
    if (!cancel && (!Number.isInteger(progress) || progress <= entry.progress || progress > entry.goal)) {
      return { status: 'invalid_progress', project: { ...entry } };
    }
    const project = this.#save({
      ...entry, revision: revision + 1, progress: cancel ? entry.progress : progress,
      status: cancel ? 'cancelled' : progress === entry.goal ? 'completed' : 'active',
      updatedAt: now.toISOString(), note, evidence,
    });
    return { status: 'updated', project };
  }

  reminder(scope, heart, execution, now = new Date()) {
    const { hour } = getZonedParts(now, 'Asia/Shanghai');
    const snapshot = heart?.getSnapshot();
    if (!snapshot || ['asleep', 'resting'].includes(snapshot.presence?.status) ||
        snapshot.mood?.state === 'tired' || hour < 8 || hour >= 23) return;
    const day = shanghaiDay(now);
    const project = this.list(scope).find(item => item.status === 'active' && item.remindedOn !== day &&
      shanghaiDay(new Date(item.updatedAt)) < day);
    if (!project || heart.evaluateActivity({ intent: 'project_reminder', category: 'social' }, { execution }).suitable === false) return;
    return project;
  }

  markReminded(id, now = new Date()) {
    this.ensureCurrent();
    const entry = this.entries.get(id);
    const day = shanghaiDay(now);
    if (entry?.status === 'active' && entry.remindedOn !== day) this.#save({ ...entry, remindedOn: day });
  }
}

export function registerProjects(registerTool, ledger, scope, acceptedInput, output) {
  registerTool({
    name: 'memory_project',
    description: '查看或记录双方已说定的共同小目标。进度使用已完成的累计单位，写入须引用当前发言中的原话。',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'start', 'advance', 'cancel'] },
      title: { type: 'string', description: '包含单位的简短标题，例如一起看完动画（集）' },
      goal: { type: 'integer', description: '要完成的单位总数' },
      id: { type: 'string' },
      revision: { type: 'integer' },
      progress: { type: 'integer' },
      note: { type: 'string' },
      evidence: { type: 'string' },
    },
    output,
    async execute({ action, title, goal, id, revision, progress, note = '', evidence }, exec) {
      const input = acceptedInput.get(exec?.agent?.session);
      if (!input || exec?.signal?.aborted) return { status: 'unavailable' };
      if (action === 'list') return { status: 'ok', projects: ledger.list(scope).slice(-10) };
      evidence = evidence?.trim();
      if (!evidence || evidence.length > 120 || !input.text.includes(evidence) || note.length > 120) {
        return { status: 'evidence_required' };
      }
      if (action === 'start') {
        title = title?.trim().replace(/\s+/g, ' ');
        if (!title || title.length > 64 || !Number.isSafeInteger(goal) || goal < 1) return { status: 'invalid_goal' };
        return { status: 'ok', project: ledger.start({ scope, title, goal, evidence }) };
      }
      return ledger.update({ scope, id, revision, progress, note, evidence, cancel: action === 'cancel' });
    },
  });
}
