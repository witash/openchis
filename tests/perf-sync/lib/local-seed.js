'use strict';

// Local-seed: populate a CHW's in-memory PouchDB with pending uploads via
// test-data-generator, by monkeypatching its doc-writer to capture docs
// instead of POSTing them.
//
// test-data-generator's `built/doc-writer.js` exports a default object with
// .write and .flush. Both are reached through that default-exported object
// at every call site (built/docs.js does `import docWriter from
// './doc-writer.js'`), so mutating its properties is visible to the running
// Docs.createDocs invocation.
//
// The mutation is module-global. Serialize concurrent users via a promise
// chain so two simultaneous seeds don't race on the shared `.write`.

const path = require('path');

const { resolveTdgRoot } = require('./setup');

let seedQueue = Promise.resolve();
const withSerialize = (fn) => {
  const next = seedQueue.then(() => fn(), () => fn());
  seedQueue = next.catch(() => {});
  return next;
};

const seedLocalPouch = async (opts) => {
  const {
    local,
    chwId,
    count,
    runId,
    userIdx,
    tdgRoot,
    importDocs,    // injectable for tests
    importDesign,
    importWriter,
  } = opts;

  if (!count || count <= 0) {
    return { docs: [] };
  }
  if (!chwId) {
    throw new Error('perf-sync local-seed: chwId required');
  }

  return withSerialize(async () => {
    const tdg = tdgRoot || resolveTdgRoot();
    const [writerMod, docsMod, designMod] = await Promise.all([
      (importWriter || (() => import(path.resolve(tdg, 'built/doc-writer.js'))))(),
      (importDocs || (() => import(path.resolve(tdg, 'built/docs.js'))))(),
      (importDesign || (() => import(path.resolve(__dirname, '../designs/perf-pending-uploads.js'))))(),
    ]);

    const writer = writerMod.default || writerMod;
    const origWrite = writer.write;
    const origFlush = writer.flush;
    const captured = [];
    writer.write = async (docs) => {
      for (const d of docs) {
        captured.push(d);
      }
    };
    writer.flush = async () => {};

    try {
      designMod.configure({ chwId, count, runId, userIdx });
      const designs = designMod.default();
      await docsMod.Docs.createDocs(designs);
    } finally {
      writer.write = origWrite;
      writer.flush = origFlush;
    }

    if (captured.length && local) {
      await local.bulkDocs(captured);
    }
    return { docs: captured };
  });
};

module.exports = {
  seedLocalPouch,
};
