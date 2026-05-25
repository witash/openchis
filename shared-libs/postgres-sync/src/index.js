const transformModule = require('./transform');
const writeModule = require('./write');
const transformAndWriteModule = require('./transform-and-write');

module.exports = {
  transform: transformModule.transform,
  write: writeModule.write,
  sanitize: writeModule.sanitize,
  transformAndWrite: transformAndWriteModule.transformAndWrite,
};
