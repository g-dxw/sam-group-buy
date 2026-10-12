import { randomUUID } from 'node:crypto';
import { DomainError } from './order-service.js';

export class SyncJobs {
  constructor() { this.jobs = new Map(); this.active = new Map(); }

  start(key, action, { acceptErrorResult = false } = {}) {
    const active = this.active.get(key);
    if (active) return this.publicJob(active);
    for (const [id, job] of this.jobs) {
      if (job.status !== 'running' && Date.now() - job.createdAt > 60 * 60 * 1000) this.jobs.delete(id);
    }
    const job = { id: randomUUID(), status: 'running', createdAt: Date.now() };
    this.jobs.set(job.id, job);
    this.active.set(key, job);
    job.promise = Promise.resolve().then(action).then(result => {
      if (result?.status === 'error' && !acceptErrorResult) throw new DomainError(503, 'SYNC_FAILED', typeof result.error === 'string' ? result.error : result.error?.message || '本次飞书同步未完成，未同步的数据已保留。');
      job.status = 'completed'; job.result = result;
    }).catch(error => {
      job.status = 'failed';
      job.error = { message: error instanceof DomainError ? error.message : '飞书同步未完成，请检查授权或网络后重试；尚未同步的数据已保留。' };
    }).finally(() => this.active.delete(key));
    return this.publicJob(job);
  }

  publicJob(job) {
    return { id: job.id, status: job.status, ...(job.result ? { result: job.result } : {}), ...(job.error ? { error: job.error } : {}) };
  }

  get(id) {
    const job = this.jobs.get(id);
    if (!job) throw new DomainError(404, 'SYNC_JOB_NOT_FOUND', '同步结果已过期，请刷新后台查看最新状态。');
    return this.publicJob(job);
  }

  async waitForIdle() { await Promise.allSettled([...this.active.values()].map(job => job.promise)); }
}
