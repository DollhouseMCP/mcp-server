/**
 * Embedded HTML template for the DollhouseMCP Log Viewer.
 *
 * Returns a self-contained vanilla JS/CSS page that connects to the
 * SSELogSink's /logs/stream endpoint via EventSource. See docs/LOGGING-DESIGN.md §4.6.
 */

export function getViewerHtml(port: number): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DollhouseMCP Log Viewer</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#1a1a2e;color:#e0e0e0;font-family:'Cascadia Code','Fira Code',monospace;font-size:13px}
#controls{display:flex;gap:8px;padding:8px 12px;background:#16213e;border-bottom:1px solid #0f3460;align-items:center;flex-wrap:wrap}
#controls label{color:#94a3b8;font-size:12px}
#controls select,#controls input{background:#1a1a2e;color:#e0e0e0;border:1px solid #0f3460;border-radius:4px;padding:4px 8px;font-family:inherit;font-size:12px}
#controls select:focus,#controls input:focus{outline:none;border-color:#e94560}
button{background:#0f3460;color:#e0e0e0;border:1px solid #0f3460;border-radius:4px;padding:4px 12px;cursor:pointer;font-family:inherit;font-size:12px}
button:hover{background:#e94560;border-color:#e94560}
#status{margin-left:auto;font-size:11px;padding:2px 8px;border-radius:10px}
.connected{background:#064e3b;color:#6ee7b7}
.disconnected{background:#7f1d1d;color:#fca5a5}
.paused{background:#78350f;color:#fcd34d}
#log{overflow-y:auto;height:calc(100vh - 44px);padding:8px 12px}
.entry{padding:2px 0;white-space:pre-wrap;word-break:break-word;border-bottom:1px solid #1e293b}
.entry:hover{background:#16213e}
.lvl-error{color:#f87171}
.lvl-warn{color:#fbbf24}
.lvl-info{color:#60a5fa}
.lvl-debug{color:#9ca3af}
.ts{color:#64748b}
.cat{color:#a78bfa}
.src{color:#2dd4bf}
.cid{color:#f472b6;font-size:11px;display:inline-block;width:72px;text-align:right;margin-right:4px}
#search{margin-left:4px}
</style>
</head>
<body>
<div id="controls">
  <label>Category
    <select id="fCategory">
      <option value="">all</option>
      <option value="application">application</option>
      <option value="security">security</option>
      <option value="performance">performance</option>
      <option value="telemetry">telemetry</option>
    </select>
  </label>
  <label>Level
    <select id="fLevel">
      <option value="">all</option>
      <option value="debug">debug</option>
      <option value="info">info</option>
      <option value="warn">warn</option>
      <option value="error">error</option>
    </select>
  </label>
  <label>Source <input id="fSource" placeholder="substring" size="14"></label>
  <label>RequestId <input id="fCorrelationId" placeholder="correlationId" size="20"></label>
  <label>Search <input id="search" placeholder="message filter" size="18"></label>
  <button id="btnPause">Pause</button>
  <button id="btnClear">Clear</button>
  <span id="status" class="disconnected">disconnected</span>
</div>
<div id="log"></div>
<script>
(function(){
  var BASE = 'http://127.0.0.1:${port}';
  var MAX_ENTRIES = 1000;
  var log = document.getElementById('log');
  var status = document.getElementById('status');
  var fCategory = document.getElementById('fCategory');
  var fLevel = document.getElementById('fLevel');
  var fSource = document.getElementById('fSource');
  var fCorrelationId = document.getElementById('fCorrelationId');
  var searchBox = document.getElementById('search');
  var btnPause = document.getElementById('btnPause');
  var btnClear = document.getElementById('btnClear');
  var es = null;
  var paused = false;
  var buffer = [];

  function escHtml(s){
    var d = document.createElement('div');
    d.appendChild(document.createTextNode(s));
    return d.innerHTML;
  }

  function setStatus(s, cls){
    status.textContent = s;
    status.className = cls;
  }



  var LEVEL_ORDER = {debug:0, info:1, warn:2, error:3};

  function matchesFilters(entry){
    var cat = fCategory.value;
    if(cat && entry.category !== cat) return false;
    var lvl = fLevel.value;
    if(lvl && (LEVEL_ORDER[entry.level]||0) < (LEVEL_ORDER[lvl]||0)) return false;
    var src = fSource.value.toLowerCase();
    if(src && (!entry.source || entry.source.toLowerCase().indexOf(src) === -1)) return false;
    var cid = fCorrelationId.value;
    if(cid && entry.correlationId !== cid) return false;
    var needle = searchBox.value.toLowerCase();
    if(needle && (!entry.message || entry.message.toLowerCase().indexOf(needle) === -1)) return false;
    return true;
  }

  function refilter(){
    var els = log.children;
    for(var i = 0; i < els.length; i++){
      var data = els[i]._entryData;
      if(data){
        els[i].style.display = matchesFilters(data) ? '' : 'none';
      }
    }
  }

  function addEntry(entry){
    if(!matchesFilters(entry)) var hidden = true;

    var el = document.createElement('div');
    el.className = 'entry lvl-' + entry.level;
    el._entryData = entry;
    if(hidden) el.style.display = 'none';
    var ts = entry.timestamp ? entry.timestamp.slice(11, 23) : '';
    var cid = entry.correlationId ? entry.correlationId.slice(-8) : '';
    el.innerHTML = '<span class="ts">' + escHtml(ts) + '</span> '
      + '<span class="cid">' + escHtml(cid) + '</span> '
      + '<span class="cat">[' + escHtml(entry.category) + ']</span> '
      + '<span class="src">' + escHtml(entry.source) + '</span> '
      + escHtml(entry.message);
    log.appendChild(el);

    while(log.children.length > MAX_ENTRIES){
      log.removeChild(log.firstChild);
    }
    if(!hidden) log.scrollTop = log.scrollHeight;
  }

  function connect(){
    if(es){ es.close(); }
    es = new EventSource(BASE + '/logs/stream');
    es.onopen = function(){ setStatus('connected', 'connected'); };
    es.onmessage = function(e){
      try{
        var entry = JSON.parse(e.data);
        if(paused){ buffer.push(entry); }
        else { addEntry(entry); }
      }catch(err){}
    };
    es.onerror = function(){ setStatus('disconnected', 'disconnected'); };
  }

  var filterTimer = null;
  function onFilterChange(){
    clearTimeout(filterTimer);
    filterTimer = setTimeout(refilter, 50);
  }

  fCategory.addEventListener('change', onFilterChange);
  fLevel.addEventListener('change', onFilterChange);
  fSource.addEventListener('input', function(){
    clearTimeout(filterTimer);
    filterTimer = setTimeout(refilter, 400);
  });
  fCorrelationId.addEventListener('input', function(){
    clearTimeout(filterTimer);
    filterTimer = setTimeout(refilter, 400);
  });
  searchBox.addEventListener('input', function(){
    clearTimeout(filterTimer);
    filterTimer = setTimeout(refilter, 400);
  });

  btnPause.addEventListener('click', function(){
    paused = !paused;
    btnPause.textContent = paused ? 'Resume' : 'Pause';
    if(paused){
      setStatus('paused', 'paused');
    } else {
      setStatus('connected', 'connected');
      buffer.forEach(addEntry);
      buffer = [];
    }
  });

  btnClear.addEventListener('click', function(){
    log.innerHTML = '';
  });

  connect();
})();
</script>
</body>
</html>`;
}
