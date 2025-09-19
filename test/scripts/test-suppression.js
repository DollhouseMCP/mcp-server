function globToRegex(glob) {
  let processedGlob = glob;
  let prefix = '';
  if (glob.startsWith('*') && !glob.startsWith('**')) {
    prefix = '(?:.*/)?';
    processedGlob = glob.substring(1);
  }
  
  let pattern = processedGlob.replace(/[\\^$.()+?{}[\]|]/g, '\\$&');
  
  pattern = pattern
    .replace(/\*\*/g, '<<GLOBSTAR>>')
    .replace(/\*/g, '<<STAR>>')
    .replace(/<<GLOBSTAR>>\//g, '(?:.*/)?')
    .replace(/<<GLOBSTAR>>/g, '.*')
    .replace(/<<STAR>>/g, '[^/]*')
    .replace(/\//g, '\\/');
  
  const fullPattern = prefix + pattern;
  const regex = new RegExp(`^${fullPattern}$`);
  return regex;
}

const pattern = '**/test-element-lifecycle.js';
const regex = globToRegex(pattern);

console.log('Pattern:', pattern);
console.log('Regex:', regex);
console.log('Test "test-element-lifecycle.js":', regex.test('test-element-lifecycle.js'));
console.log('Test "/home/runner/work/mcp-server/mcp-server/test-element-lifecycle.js":', 
            regex.test('/home/runner/work/mcp-server/mcp-server/test-element-lifecycle.js'));
