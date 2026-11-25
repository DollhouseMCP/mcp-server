// Keep identical to tests/helpers/isolated-node-environment.cjs apart from where Jest resolves.
const { TestEnvironment } = require('jest-environment-node');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isolateNativeHome } = require('./isolated-server-env.cjs');

/** Package-local dependencies also support npm install --workspaces=false. */
module.exports = class IsolatedNodeEnvironment extends TestEnvironment {
  constructor(config, context) {
    const accountAppData = process.env.APPDATA;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dollhouse-jest-home-'));
    let restore = () => {};
    try {
      restore = isolateNativeHome(home);
      super(config, context);
      this.global[Symbol.for('dollhouse.test.accountAppData')] = accountAppData;
    } catch (error) {
      restore();
      fs.rmSync(home, { recursive: true, force: true });
      throw error;
    }
    this.fixtureHome = home;
    this.restoreHome = restore;
  }
  async teardown() {
    try { await super.teardown(); }
    finally {
      this.restoreHome();
      fs.rmSync(this.fixtureHome, { recursive: true, force: true });
    }
  }
};
