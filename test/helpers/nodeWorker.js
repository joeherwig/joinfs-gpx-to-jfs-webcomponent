'use strict';
/**
 * Stand-in for the browser Worker: runs the exact worker source (a Blob URL in the browser) in a Node worker_thread.
 * Only what the component uses is implemented: postMessage, terminate, onmessage, onerror.
 */
const { Worker: NodeWorker } = require('worker_threads');
const { resolveObjectURL } = require('buffer');

const SHIM = "const {parentPort}=require('worker_threads');globalThis.self={postMessage:(m,t)=>parentPort.postMessage(m,t)};"
  + "parentPort.on('message',d=>globalThis.self.onmessage({data:d}));\n";

class FakeWorker {
  constructor(url, getSource) {
    this.queue = [];
    this.dead = false;
    Promise.resolve(getSource ? getSource(url) : resolveObjectURL(url).text()).then((src) => {
      if (this.dead) return;
      this.w = new NodeWorker(SHIM + src, { eval: true });
      this.w.on('message', (d) => this.onmessage && this.onmessage({ data: d }));
      this.w.on('error', (e) => this.onerror && this.onerror({ message: e.message, preventDefault() {} }));
      this.queue.forEach(([m, t]) => this.w.postMessage(m, t));
      this.queue = [];
    });
  }
  postMessage(m, t) { if (this.w) this.w.postMessage(m, t); else this.queue.push([m, t]); }
  terminate() { this.dead = true; if (this.w) this.w.terminate(); }
}

module.exports = { FakeWorker };
