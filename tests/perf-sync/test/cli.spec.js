'use strict';

const { expect } = require('chai');
const cli = require('../cli');

describe('cli', () => {
  describe('parseArgs', () => {
    it('separates positional args from --flag=val pairs', () => {
      const out = cli.parseArgs(['baseline', '--users=50', '--protocol=both']);
      expect(out._).to.deep.equal(['baseline']);
      expect(out.flags).to.deep.equal({ users: '50', protocol: 'both' });
    });

    it('treats bare --flag as true', () => {
      const out = cli.parseArgs(['--help']);
      expect(out.flags.help).to.equal(true);
    });
  });

  describe('PROTOCOLS', () => {
    it('maps known aliases to lists', () => {
      expect(cli.PROTOCOLS.nairobi).to.deep.equal(['nairobi']);
      expect(cli.PROTOCOLS['pg-sync']).to.deep.equal(['pg-sync']);
      expect(cli.PROTOCOLS.both).to.deep.equal(['nairobi', 'pg-sync']);
    });
  });

  describe('main', () => {
    it('prints help and exits 0 when no scenario is given', async () => {
      const code = await cli.main(['node', 'cli.js']);
      expect(code).to.equal(0);
    });

    it('returns 2 on an unknown scenario', async () => {
      const code = await cli.main(['node', 'cli.js', 'no-such-scenario']);
      expect(code).to.equal(2);
    });
  });
});
