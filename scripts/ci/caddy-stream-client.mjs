// Native qualification client source, also exercised by local transport controls.
import { observeStream, observeUnsettledExit, observeRequestClose } from './caddy-stream-guard.mjs';

export const clientSource = String.raw`
const http = require('node:http');
const https = require('node:https');
const http2 = require('node:http2');
const fs = require('node:fs');
const observeStream = (${observeStream.toString()});
const observeUnsettledExit = (${observeUnsettledExit.toString()});
const observeRequestClose = (${observeRequestClose.toString()});
const options = JSON.parse(process.argv[1]);
let settled = false;
let terminate = () => {};
const fail = (reason, error) => {
 if (settled) return;
 settled = true;
 const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : 'UNKNOWN';
 console.error(JSON.stringify({ success:false, reason, code }));
 process.exitCode = 1;
 terminate();
};
observeUnsettledExit(process, () => settled, fail);
let body = '';
let status;
let protocol;
const started = performance.now();
let firstDataMs;
let cursor=0;
const eventTimesMs=[];
const data = bytes => {
 firstDataMs ??= performance.now()-started;
 body+=bytes;
 let boundary=body.indexOf('\n\n',cursor);
 while(boundary!==-1){eventTimesMs.push(performance.now()-started);cursor=boundary+2;boundary=body.indexOf('\n\n',cursor);}
};
const done = () => {
 if (settled) return;
 settled = true;
 const elapsedMs=performance.now()-started;
 console.log(JSON.stringify({ status, body, protocol, method:options.method??'GET', elapsedMs, firstDataMs, eventTimesMs,
  quietGapMs:(eventTimesMs[1]??elapsedMs)-eventTimesMs[0] }));
};
if (options.h2) {
  const session = http2.connect('https://proxy:443', { servername: 'fixture.local', ca: fs.readFileSync('/tmp/qualification-ca.crt') });
  session.on('error', error => fail('session-error', error));
  const req = session.request({ ':path': options.path, ':authority': 'fixture.local', ':method':options.method??'GET', ...options.headers });
  observeStream(req, fail);
  terminate = () => { req.destroy(); session.destroy(); };
  req.setTimeout(80000, () => { req.destroy(new Error('qualification request timeout')); });
  req.on('response', headers => { status=headers[':status']; protocol=session.alpnProtocol; });
  req.on('data', data);
  req.on('end', () => { done(); session.close(); });
  req.on('error', error => { fail('request-error', error); session.destroy(); });
  req.end(options.body);
} else {
  const transport=options.tls?https:http;
  const tlsOptions=options.tls?{ servername:'fixture.local',ca:fs.readFileSync('/tmp/qualification-ca.crt'),ALPNProtocols:['http/1.1'] }:{};
  let responseStarted = false;
  const req = transport.request({ hostname:options.host??'proxy', port:options.port??(options.tls?443:80), path:options.path,method:options.method??'GET',...tlsOptions,
    headers:{ host:'fixture.local', ...options.headers }, timeout:80000 }, res => {
    responseStarted = true;
    observeStream(res, fail);
    status=res.statusCode;
    protocol='http/'+res.httpVersion;
    res.on('data', data);
    res.on('end', () => { if (res.complete) done(); else fail('response-incomplete'); });
  });
  terminate = () => req.destroy();
  req.on('error', error => fail('request-error', error));
  observeRequestClose(req, () => responseStarted, fail);
  req.on('timeout', () => req.destroy(new Error('qualification request timeout')));
  req.end(options.body);
}
`;
