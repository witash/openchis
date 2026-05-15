const transformModule = require('./transform');
const writeModule = require('./write');
const transformAndWriteModule = require('./transform-and-write');

module.exports = {
  // pure transform
  transform: transformModule.transform,
  // helpers (re-exported for callers that need them, eg. sentinel's importer)
  isContactDoc: transformModule.isContactDoc,
  isSystemDoc: transformModule.isSystemDoc,
  getDocType: transformModule.getDocType,
  getContactType: transformModule.getContactType,
  getParentId: transformModule.getParentId,
  getSubject: transformModule.getSubject,
  getDataRecordSubject: transformModule.getDataRecordSubject,

  // bulk write helpers
  write: writeModule.write,
  sanitize: writeModule.sanitize,

  // hot path for the api interceptor
  transformAndWrite: transformAndWriteModule.transformAndWrite,
};
