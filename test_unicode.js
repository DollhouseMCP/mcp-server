const { UnicodeValidator } = require('./dist/security/validators/unicodeValidator.js');

const rtlName = '\u202Eeruces';
const result = UnicodeValidator.normalize(rtlName);
console.log('Input:', rtlName);
console.log('Normalized:', result.normalizedContent);
console.log('Is "secure"?:', result.normalizedContent === 'secure');
