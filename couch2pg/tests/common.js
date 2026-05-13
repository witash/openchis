const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');

chai.config.includeStack = true;
chai.use(chaiAsPromised);

global.expect = chai.expect;
