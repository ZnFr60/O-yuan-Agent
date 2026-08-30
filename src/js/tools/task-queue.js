// task-queue.js - 异步任务队列（并发上限 / 排队 / 超时丢弃 / 状态看板）
'use strict';
const { EventEmitter } = require('events');
const config = require('../core/config');
const logger = require('../core/logger');

class TaskQueue extends EventEmitter {
  constructor() {
    super();
    this.concurrency = 2;
    this.timeoutMs = 120000;
    this.running = 0;
    this.queue = [];
    this.tasks = new Map(); // id -> task record
    this.seq = 0;
  }

  init() {
    const c = config.get(['taskQueue']) || {};
    this.concurrency = c.concurrency || 2;
    this.timeoutMs = c.timeoutMs || 120000;
  }

  submit(fn, opts = {}) {
    const id = 't' + (++this.seq) + '-' + Date.now();
    const task = {
      id,
      label: opts.label || 'task',
      status: 'queued',
      queuedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null
    };
    this.tasks.set(id, task);
    this.queue.push({ id, fn, timeout: opts.timeout || this.timeoutMs });
    this.emit('task', { id, status: 'queued' });
    this.pump();
    return id;
  }

  pump() {
    while (this.running < this.concurrency && this.queue.length) {
      const { id, fn, timeout } = this.queue.shift();
      this._run(id, fn, timeout);
    }
  }

  _run(id, fn, timeout) {
    const task = this.tasks.get(id);
    if (!task) return;
    this.running++;
    task.status = 'running';
    task.startedAt = Date.now();
    this.emit('task', { id, status: 'running' });

    const timer = setTimeout(() => {
      if (task.status === 'running') {
        task.status = 'timeout';
        task.finishedAt = Date.now();
        task.error = '任务超时丢弃';
        this.running--;
        logger.warn('任务超时', { id, label: task.label });
        this.emit('task', { id, status: 'timeout' });
        this.pump();
      }
    }, timeout);

    Promise.resolve()
      .then(() => fn())
      .then((res) => {
        clearTimeout(timer);
        if (task.status === 'running') {
          task.status = 'completed';
          task.finishedAt = Date.now();
          task.result = res;
          this.running--;
          this.emit('task', { id, status: 'completed', result: res });
        }
        this.pump();
      })
      .catch((err) => {
        clearTimeout(timer);
        if (task.status === 'running') {
          task.status = 'failed';
          task.finishedAt = Date.now();
          task.error = String(err && err.message || err);
          this.running--;
          logger.error('任务失败', { id, label: task.label, error: task.error });
          this.emit('task', { id, status: 'failed', error: task.error });
        }
        this.pump();
      });
  }

  status() {
    return {
      running: this.running,
      queued: this.queue.length,
      concurrency: this.concurrency,
      tasks: Array.from(this.tasks.values()).map((t) => ({
        id: t.id, label: t.label, status: t.status,
        queuedAt: t.queuedAt, startedAt: t.startedAt, finishedAt: t.finishedAt,
        error: t.error
      })).slice(-50)
    };
  }
}

module.exports = new TaskQueue();
