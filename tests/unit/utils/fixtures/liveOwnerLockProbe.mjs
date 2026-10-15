// Test-child observations only. No probe is issued here: wrappers delegate each
// existing call exactly once and never interpret its output as identity authority.
const providers = ['wmic', 'pwsh', 'powershell'];
const outcomes = ['unobserved', 'returned', 'empty', 'timeout', 'not-found', 'error'];
const markerOutcomes = ['unobserved', 'stat-ok', 'stat-missing', 'stat-error', 'read-ok', 'read-missing', 'read-error'];
const allocationOutcomes = ['unobserved', 'returned', 'missing', 'error'];

export function observeLiveOwnerLockCalls({ fs, childProcess, syncBuiltinESMExports, stateFile, pid, clock, started }) {
  const data = { providers: Object.fromEntries(providers.map(name => [name,
    { count: 0, firstEntryMs: null, totalMs: 0, maxMs: 0, outcome: 'unobserved' }])),
    allocationFinallyLastAttempt: 'unobserved', lastDone: null, lastMarker: 'unobserved', unavailable: false };
  const restorations = [];
  let restored = false;
  const safe = action => { try { action(); } catch { data.unavailable = true; } };
  const lock = `${stateFile}.lock`;
  const marker = value => typeof value === 'string' && value.startsWith(`${lock}.process-`) && value.endsWith('.identity');
  const wrap = (object, name, observe) => {
    const original = object[name];
    const wrapped = function(...args) {
      let result, failed = false, cause;
      try { result = Reflect.apply(original, this, args); return result; }
      catch (error) { failed = true; cause = error; throw error; }
      finally { safe(() => observe(args, result, failed, cause)); }
    };
    object[name] = wrapped;
    restorations.push(() => {
      if (object[name] === wrapped) object[name] = original;
      else data.unavailable = true; // Never overwrite a later owner of a method.
    });
  };
  safe(() => {
    const original = childProcess.execFileSync;
    const wrapped = function(...args) {
      let entry, stats;
      safe(() => {
        const leaf = typeof args[0] === 'string' ? args[0].split(String.fromCharCode(92)).pop().split('/').pop().toLowerCase() : '';
        const name = { 'wmic.exe': 'wmic', 'pwsh.exe': 'pwsh', 'powershell.exe': 'powershell' }[leaf];
        stats = name ? data.providers[name] : undefined;
        if (stats) {
          entry = clock(); stats.count++;
          if (stats.firstEntryMs === null) stats.firstEntryMs = Math.max(0, Math.round(entry - started));
        }
      });
      let outcome = 'returned';
      try {
        const result = Reflect.apply(original, this, args);
        if (result === '') outcome = 'empty';
        return result;
      } catch (error) {
        safe(() => { outcome = error?.code === 'ETIMEDOUT' ? 'timeout' : error?.code === 'ENOENT' ? 'not-found' : 'error'; });
        throw error;
      } finally {
        if (stats) safe(() => {
          const elapsed = Math.max(0, Math.round(clock() - entry));
          stats.totalMs += elapsed; stats.maxMs = Math.max(stats.maxMs, elapsed); stats.outcome = outcome;
        });
      }
    };
    childProcess.execFileSync = wrapped;
    restorations.push(() => {
      if (childProcess.execFileSync === wrapped) childProcess.execFileSync = original;
      else data.unavailable = true;
    });
    wrap(fs, 'existsSync', (args, result, failed) => {
      if (typeof args[0] === 'string' && args[0].startsWith(`${lock}/`) && /^\d+\.done$/.test(args[0].slice(lock.length + 1))) {
        if (failed) data.unavailable = true;
        else data.lastDone = result === true;
      }
    });
    for (const [method, label] of [['statSync', 'stat'], ['readFileSync', 'read']]) {
      wrap(fs, method, (args, _result, failed, cause) => {
        if (marker(args[0])) data.lastMarker = `${label}-${failed ? cause?.code === 'ENOENT' ? 'missing' : 'error' : 'ok'}`;
      });
    }
    wrap(fs, 'rmSync', (args, _result, failed, cause) => {
      if (typeof args[0] === 'string' && args[0].startsWith(`${lock}/.${pid}.`) && args[0].endsWith('.slot.tmp.publish')) {
        data.allocationFinallyLastAttempt = failed ? cause?.code === 'ENOENT' ? 'missing' : 'error' : 'returned';
      }
    });
    syncBuiltinESMExports(); // Before coordinator import: capture named execFileSync.
  });
  return { snapshot: () => data, restore() {
    if (restored) return;
    restored = true;
    for (const restore of restorations.reverse()) safe(restore);
    safe(syncBuiltinESMExports);
  } };
}

// Reconstruct only fixed safe fields. Never forward arbitrary child objects,
// exception text, command arguments, provider output or filesystem paths.
export function decodeLiveOwnerLockProbe(value) {
  const integer = number => Number.isSafeInteger(number) && number >= 0;
  if (!value || typeof value !== 'object' || !value.providers ||
      typeof value.unavailable !== 'boolean' || !allocationOutcomes.includes(value.allocationFinallyLastAttempt) ||
      !markerOutcomes.includes(value.lastMarker) || (value.lastDone !== null && typeof value.lastDone !== 'boolean')) return null;
  const decoded = {};
  for (const name of providers) {
    const item = value.providers[name];
    if (!item || !integer(item.count) || !integer(item.totalMs) || !integer(item.maxMs) ||
        (item.firstEntryMs !== null && !integer(item.firstEntryMs)) || !outcomes.includes(item.outcome)) return null;
    decoded[name] = { count: item.count, firstEntryMs: item.firstEntryMs, totalMs: item.totalMs, maxMs: item.maxMs, outcome: item.outcome };
  }
  return { providers: decoded, allocationFinallyLastAttempt: value.allocationFinallyLastAttempt,
    lastDone: value.lastDone, lastMarker: value.lastMarker, unavailable: value.unavailable };
}
