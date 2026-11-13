// Native fixture producer, embedded unchanged into the owned Node container.
// This exercises a completed bounded request body before opening an SSE reply.
export const upstreamSource = String.raw`
const http=require('node:http');
const expected=Buffer.from('{"jsonrpc":"2.0","id":1,"method":"qualification"}');
http.createServer((req,res)=>{
 if(['/healthz','/readyz','/mcp'].includes(req.url)) console.log(JSON.stringify({fixture:'probe',path:req.url,method:req.method}));
 if(req.url==='/quiet') {
  let bytes=0, rejected=false, ended=false, timer;
  const chunks=[];
  const report=event=>console.log(JSON.stringify({fixture:'quiet',event,bytes,ended}));
  const reject=status=>{
   if(rejected || res.headersSent || res.destroyed) return;
   rejected=true; res.writeHead(status); res.end();
  };
  res.on('close',()=>{clearTimeout(timer);report('response-close');});
  res.on('finish',()=>{clearTimeout(timer);report('response-finish');});
  res.on('error',()=>{clearTimeout(timer);report('response-error');});
  req.on('aborted',()=>{rejected=true;report('request-aborted');res.destroy();});
  req.on('error',()=>{rejected=true;report('request-error');res.destroy();});
  if(req.method!=='POST' || req.headers['content-type']!=='application/json') {
   reject(400); req.resume(); return;
  }
  req.on('data',chunk=>{
   bytes+=chunk.length;
   if(bytes>expected.length){reject(413);req.resume();return;}
   chunks.push(chunk);
  });
  req.on('end',()=>{
   ended=true;report('request-end');
   if(rejected || !req.complete || bytes!==expected.length || !Buffer.concat(chunks).equals(expected)) {reject(400);return;}
   res.writeHead(200, {'content-type':'text/event-stream','cache-control':'no-cache'});
   res.write('event: start\ndata: method='+req.method+'\n\n');
   timer=setTimeout(()=>res.end('event: done\ndata: survived\n\n'),76000);
  });
 } else {
  res.writeHead(req.url==='/mcp' ? 401 : 200, {'content-type':'application/json', ...(['/healthz','/readyz','/mcp'].includes(req.url) ? {'x-dollhouse-verification':'spoofed'} : {})});
  res.end(JSON.stringify({headers:req.headers,url:req.url}));
 }
}).listen(8081,'0.0.0.0');
`;
