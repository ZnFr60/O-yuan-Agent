// kb.js - 轻量化私有知识库 RAG
// 相似度/文本预处理交由 C++ 扩展运算（Worker 线程执行，避免阻塞事件循环）。
'use strict';
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const config = require('./config');
const native = require('./native');
const logger = require('./logger');

class KnowledgeBase {
  constructor() {
    this.documents = [];   // { id, file, chunks: [{text, keywords}] }
    this.dir = null;
    this.enabled = true;
    this.maxRefs = 3;
    this.threshold = 0.25;
    this.revision = 0;
  }

  init() {
    const c = config.get(['rag']) || {};
    this.dir = c.kbPath ? config.resolveDir(c.kbPath) : config.resolveDir(path.join('config', 'kb'));
    this.enabled = c.enabled !== false;
    this.maxRefs = c.maxRefs || 3;
    this.threshold = c.similarityThreshold != null ? c.similarityThreshold : 0.25;
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
    this.reload();
  }

  reload() {
    const files = this.listFiles();
    this.documents = [];
    for (const f of files) {
      try {
        const content = fs.readFileSync(f, 'utf8');
        const chunks = this.chunk(content);
        this.documents.push({ id: path.basename(f), file: f, chunks, content });
      } catch (e) {
        logger.warn('知识库文件读取失败', { file: f, error: e.message });
      }
    }
    this.revision++;
    logger.info('知识库已加载', { docs: this.documents.length, revision: this.revision });
    return this.documents.length;
  }

  listFiles() {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir)
      .filter((f) => /\.(txt|md)$/i.test(f))
      .map((f) => path.join(this.dir, f));
  }

  chunk(content) {
    const api = native.api();
    const c = config.get(['rag']) || {};
    const size = c.chunkSize || 1000;
    const overlap = c.chunkOverlap || 100;
    let chunks;
    if (typeof api.chunkText === 'function') {
      try { chunks = api.chunkText(content, size, overlap); }
      catch (e) { chunks = fallbackChunk(content, size, overlap); }
    } else {
      chunks = fallbackChunk(content, size, overlap);
    }
    return chunks.map((text) => ({
      text,
      keywords: (typeof api.keywordWeights === 'function') ? api.keywordWeights(text) : []
    }));
  }

  // 检索相关片段（Worker 线程执行相似度计算）
  async search(query, limit) {
    if (!this.enabled) return [];
    const lim = limit || this.maxRefs;
    const api = native.api();
    const threshold = this.threshold;
    // 在 Worker 线程中做全部相似度计算，避免阻塞主线程
    const docs = this.documents;
    const result = await new Promise((resolve, reject) => {
      try {
        const worker = new Worker(getWorkerScript(), {
          eval: true,
          workerData: { query, docs, threshold }
        });
        worker.on('message', resolve);
        worker.on('error', reject);
        worker.on('exit', (code) => { if (code !== 0) reject(new Error('KB worker exit ' + code)); });
      } catch (e) { reject(e); }
    });
    const scored = result.map((r) => ({ ...r, doc: docs.find((d) => d.id === r.docId) }));
    return scored.slice(0, lim);
  }

  setEnabled(v) { this.enabled = !!v; }
  stats() { return { docs: this.documents.length, chunks: this.documents.reduce((a, d) => a + d.chunks.length, 0), revision: this.revision }; }
}

// 由 Worker 线程加载并执行的检索脚本
// 评分 = 0.6 * 余弦相似度(字符 unigram) + 0.3 * 关键词命中 + 0.1 * 长度归一化
function getWorkerScript() {
  return `
    const { parentPort, workerData } = require('worker_threads');
    const { query, docs, threshold } = workerData;
    function norm(s){ return String(s||'').replace(/[\\t\\n\\r]+/g,' ').replace(/\\s+/g,' ').trim().toLowerCase(); }
    function unigrams(s){ return [...s]; }
    function cosine(a,b){
      const ua=unigrams(a), ub=unigrams(b);
      if(!ua.length||!ub.length) return 0;
      const fa={},fb={};
      for(const t of ua) fa[t]=(fa[t]||0)+1;
      for(const t of ub) fb[t]=(fb[t]||0)+1;
      let dot=0,na=0,nb=0;
      for(const k in fa){ dot+=fa[k]*(fb[k]||0); na+=fa[k]*fa[k]; }
      for(const k in fb) nb+=fb[k]*fb[k];
      if(!na||!nb) return 0;
      return dot/(Math.sqrt(na)*Math.sqrt(nb));
    }
    function kwMatch(q,t){
      const words=q.split(/[\\s,，。;；:：!！?？]+/).filter(w=>w.length>1);
      if(!words.length) return 0;
      let hit=0;
      for(const w of words) if(t.includes(w)) hit++;
      return hit/words.length;
    }
    function score(q,text){
      const qn=norm(q), tn=norm(text);
      const cos=cosine(qn,tn);
      const kw=kwMatch(qn,tn);
      return Math.min(1, cos*0.6 + kw*0.35 + (tn.length?0.05:0));
    }
    const out=[];
    for(const doc of docs){
      let best=0, bestText='';
      for(const chunk of doc.chunks){
        const s=score(query,chunk.text);
        if(s>best){ best=s; bestText=chunk.text; }
      }
      if(best>=threshold) out.push({docId:doc.id, score:best, snippet:bestText.slice(0,1500)});
    }
    out.sort((a,b)=>b.score-a.score);
    parentPort.postMessage(out);
  `;
}

function fallbackChunk(text, size, overlap) {
  const out = [];
  if (!text) return out;
  if (overlap >= size) overlap = Math.floor(size / 2);
  let pos = 0;
  while (pos < text.length) {
    const end = Math.min(pos + size, text.length);
    out.push(text.slice(pos, end));
    if (end === text.length) break;
    pos = end > overlap ? end - overlap : end;
  }
  return out;
}

module.exports = new KnowledgeBase();
