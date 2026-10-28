const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const realHome = os.userInfo().homedir;

/** Apply home overrides last so inherited or caller-supplied values cannot escape isolation. */
function isolatedServerEnv(directory, environment = process.env) {
  if (!directory || !path.isAbsolute(directory)) throw new Error('Test server home must be an absolute fixture directory');
  const home = fs.realpathSync.native(directory);
  const resolvedRealHome = fs.realpathSync.native(realHome);
  const isRealHome = process.platform === 'win32'
    ? home.toLowerCase() === resolvedRealHome.toLowerCase()
    : home === resolvedRealHome;
  if (isRealHome) throw new Error('Test server home must not be the real user home');
  const defined = Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined));
  return { ...defined, HOME: home, DOLLHOUSE_HOME_DIR: home, USERPROFILE: home };
}

module.exports = { isolatedServerEnv };
