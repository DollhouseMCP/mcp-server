#!/usr/bin/env python3
"""Single hosted native artifact acquisition; synthetic inputs only, no publish/deploy."""
import os,sys,pathlib,subprocess,json,hashlib,secrets,time,tarfile,shutil
S=pathlib.Path(sys.argv[1]).resolve(); O=pathlib.Path(sys.argv[2]).resolve(); O.mkdir(mode=0o700)
P=O.parent/'private-native'; P.mkdir(mode=0o700); os.umask(0o077)
SHA='6c4322d29e05608b91dc0150fcdb804f9069c7b7'; TREE='3fa5ccba6dc7991c38cf13a582f9d9c347899c65'
N='d3050-release-'+os.environ['GITHUB_RUN_ID']+'-'+os.environ['GITHUB_RUN_ATTEMPT']; NET=N+'-net'; PG=N+'-pg'; APP=N+'-app'; MIG=N+'-migrate'; B=N+'-build'; VOL=N+'-pgdata'
DOCKER=['docker','--host','unix:///var/run/docker.sock']
for selector in ('DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH'): os.environ.pop(selector,None)
containers=[]; network=False; volume=False; builder=False; counter=0; fixture_secrets=[]; pins={}; volume_identity=None; audit_needs_disposition=False

def phase(name): print("phase: "+name,flush=True)
def redact(data):
 for value in fixture_secrets:
  data=data.replace(value.encode(),b"<fixture-redacted>")
 return data

def run(args,timeout=60,stdin=None,record=True,cwd=None):
 global counter
 counter+=1
 r=subprocess.run(args,input=stdin,capture_output=True,timeout=timeout,cwd=cwd)
 if record:
  (O/f'{counter:03}-stdout.txt').write_bytes(redact(r.stdout)); (O/f'{counter:03}-stderr.txt').write_bytes(redact(r.stderr))
 if r.returncode:
  safe=redact(r.stderr)
  (O/f'{counter:03}-failure-stderr.txt').write_bytes(safe[:16384])
  (O/f'{counter:03}-failure.json').write_text(json.dumps({'step':counter,'exitCode':r.returncode,'stderrTruncated':len(safe)>16384,'fixtureSecretsRedacted':True}))
  raise RuntimeError('command failed: '+args[0]+' step '+str(counter)+' code '+str(r.returncode))
 return r.stdout

def inspect(kind,name):
 d=json.loads(run([*DOCKER,kind,'inspect',pins.get(name,name)],record=False))[0]
 if name in pins and d['Id']!=pins[name]: raise RuntimeError('immutable resource identity mismatch')
 if kind in ('container','network') and name in pins and d.get('Config',{}).get('Labels',d.get('Labels',{})).get('dollhouse.native')!=N: raise RuntimeError('resource ownership mismatch')
 return d

def create_container(name,arguments,attach=False):
 containers.append(name)
 raw=run([*DOCKER,'create','--name',name,'--label','dollhouse.native='+N,*arguments]).decode().strip()
 if not __import__('re').fullmatch('[a-f0-9]{64}',raw): raise RuntimeError('container creation identity absent')
 pins[name]=raw; inspect('container',name)
 run([*DOCKER,'start',*(['--attach'] if attach else []),raw],timeout=180,record=not attach)
 return raw

def term_wait(name):
 d=inspect('container',name)
 if d['State']['Running']:
  if name==APP:
   run(['env','DOCKER_HOST=unix:///var/run/docker.sock','bash',str(S/'scripts/hosted-graceful-stop.sh'),pins[name],'20'],timeout=25)
  else: run([*DOCKER,'kill','--signal','TERM',pins[name]],timeout=10)
  run([*DOCKER,'wait',pins[name]],timeout=15)
 state=inspect('container',name)['State']
 if state['Running'] or state['ExitCode'] or state['OOMKilled']: raise RuntimeError('known clean closure unavailable')
 return state
def write_env(name,fields):
 f=P/name; f.write_text(''.join(k+'='+v+'\n' for k,v in fields.items())); return str(f)
def sql(query): return run([*DOCKER,'exec','-i',pins[PG],'psql','-X','-Atq','-v','ON_ERROR_STOP=1','-U','dollhouse','-d','dollhousemcp'],stdin=query,record=False)
def closed(name): return term_wait(name)

def state_record(name):
 d=inspect('container',name)
 safe={'name':name,'id':d['Id'],'image':d['Image'],'user':d['Config']['User'],'path':d['Path'],'args':d['Args'],'state':d['State'],'ports':d['NetworkSettings']['Ports'],'memory':d['HostConfig']['Memory'],'cpuQuota':d['HostConfig']['CpuQuota'],'cpuPeriod':d['HostConfig']['CpuPeriod'],'nanoCpus':d['HostConfig']['NanoCpus']}
 (O/(name+'-state.json')).write_bytes(redact(json.dumps(safe,indent=2).encode())); return safe

def check_catalog():
 if sql((pathlib.Path(__file__).parent/'native-amd64-catalog.sql').read_bytes()).strip()!=b't': raise RuntimeError('APP SYSTEM grants or empty guarded catalog mismatch')

def cleanup():
 errors=[]; children_settled=True; pg_settled=True
 for name in reversed(containers):
  if name==PG and not children_settled:
   errors.append('database retained: child settlement unproven'); pg_settled=False; continue
  try:
   if name not in pins: raise RuntimeError('resource creation identity unavailable; retain')
   term_wait(name); run([*DOCKER,'rm',pins[name]],record=False)
  except Exception as e:
   errors.append(type(e).__name__+':'+name)
   if name!=PG: children_settled=False
   else: pg_settled=False
 if volume and children_settled and pg_settled:
  try:
   d=inspect('volume',VOL)
   if {k:d.get(k) for k in volume_identity}!=volume_identity: raise RuntimeError('volume creation tuple changed')
   run([*DOCKER,'volume','rm',VOL])
  except Exception: errors.append('volume cleanup')
 if network and children_settled and pg_settled:
  try: inspect('network',NET); run([*DOCKER,'network','rm',pins[NET]])
  except Exception: errors.append('network cleanup')
 if builder:
  try: run([*DOCKER,'buildx','rm',B],timeout=30)
  except Exception: errors.append('builder cleanup')
 absent={}
 for kind,names in [('container',containers),('volume',[VOL]),('network',[NET]),('container',['buildx_buildkit_'+B+'0']),('volume',['buildx_buildkit_'+B+'0_state'])]:
  for name in names:
   p=subprocess.run([*DOCKER,kind,'inspect',name],capture_output=True,timeout=10)
   absent[kind+':'+name]=p.returncode!=0 and ('no such' in p.stderr.decode().lower() or 'not found' in p.stderr.decode().lower())
 (O/'cleanup.json').write_text(json.dumps({'errors':errors,'absent':absent},indent=2))
 if not errors: shutil.rmtree(P)
 if errors or not all(absent.values()): raise RuntimeError('owned cleanup incomplete')

def audit_image(image):
 global audit_needs_disposition
 phase('actual-image-inventory-and-audit')
 inventory="const fs=require('fs');let p=[];function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){if(e.isSymbolicLink())continue;const q=d+'/'+e.name;if(e.isDirectory())walk(q);else if(e.name==='package.json'){try{const j=JSON.parse(fs.readFileSync(q));if(j.name&&j.version)p.push({path:q,name:j.name,version:j.version})}catch{}}}}walk('/app');console.log(JSON.stringify({node:process.version,arch:process.arch,uid:process.getuid(),packages:p}));"
 for suffix,entry,args in [('inventory', 'node', ['-e', inventory]), ('os-release', 'node', ['-e', "process.stdout.write(require('fs').readFileSync('/etc/os-release'))"]), ('os-packages', 'dpkg-query', ['-W', '-f=${Package} ${Version}\n']), ('audit-production', 'npm', ['audit', '--omit=dev', '--json']), ('audit-full-lock', 'npm', ['audit', '--json']), ('audit-safety', 'npm', ['--prefix', '/app/packages/safety', 'audit', '--json'])]:
  name=N+'-'+suffix
  containers.append(name)
  cid=run([*DOCKER,'create','--name',name,'--label','dollhouse.native='+N,'--network','bridge','--memory','512m','--cpus','1','--entrypoint',entry,image,*args]).decode().strip()
  if not __import__('re').fullmatch('[a-f0-9]{64}',cid): raise RuntimeError('audit creation identity unavailable')
  pins[name]=cid; inspect('container',name)
  r=subprocess.run([*DOCKER,'start','--attach',cid],capture_output=True,timeout=180)
  (O/(suffix+'.stdout')).write_bytes(redact(r.stdout)); (O/(suffix+'.stderr')).write_bytes(redact(r.stderr))
  state=inspect('container',name)['State']
  if state['Running'] or state['OOMKilled']: raise RuntimeError('audit process unsettled')
  if suffix.startswith('audit'):
   data=json.loads(r.stdout); counts=data.get('metadata',{}).get('vulnerabilities')
   if not counts: raise RuntimeError('audit service unavailable')
   audit_needs_disposition |= bool(counts.get('high',0) or counts.get('critical',0))
   manifest.setdefault('audit',{})[suffix]={'exitCode':state['ExitCode'],'counts':counts,'kind':'actual image npm/lock view; installed-presence inventory retained separately'}
  elif state['ExitCode']: raise RuntimeError('image inventory unavailable')
  run([*DOCKER,'rm',cid],record=False); containers.remove(name); pins.pop(name)
 manifest['auditNeedsReleaseDisposition']=audit_needs_disposition

failure=None; manifest={}
try:
 if run(['uname','-m']).strip()!=b'x86_64': raise RuntimeError('runner not native AMD64')
 if run(['git','rev-parse','HEAD'],cwd=S).strip().decode()!=SHA or run(['git','rev-parse','HEAD^{tree}'],cwd=S).strip().decode()!=TREE: raise RuntimeError('source pin')
 if run(['git','status','--porcelain'],cwd=S).strip(): raise RuntimeError('dirty source')
 manifest={'source':SHA,'tree':TREE,'driver':os.environ['GITHUB_SHA'],'run':os.environ['GITHUB_RUN_ID'],'attempt':os.environ['GITHUB_RUN_ATTEMPT'],'platform':'linux/amd64','files':{f:hashlib.sha256((S/f).read_bytes()).hexdigest() for f in ['docker/Dockerfile','package-lock.json','packages/safety/package-lock.json'] if (S/f).exists()},'images':{}}
 run([*DOCKER,'version']); run([*DOCKER,'buildx','version'])
 run([*DOCKER,'pull','--platform','linux/amd64','node:24-slim'],timeout=180)
 base=inspect('image','node:24-slim'); manifest['freshNodeBase']=base; manifest['buildResolvedBaseDigests']={}
 for kind,names in [('container',[APP,MIG,PG,'buildx_buildkit_'+B+'0']),('volume',[VOL,'buildx_buildkit_'+B+'0_state']),('network',[NET])]:
  for name in names:
   probe=subprocess.run([*DOCKER,kind,'inspect',name],capture_output=True,timeout=10)
   if probe.returncode==0 or not ('no such' in probe.stderr.decode().lower() or 'not found' in probe.stderr.decode().lower()): raise RuntimeError('owned namespace not proven absent')
 builder=True
 run([*DOCKER,'buildx','create','--name',B,'--driver','docker-container','--driver-opt','memory=2g,memory-swap=2g,cpu-period=100000,cpu-quota=100000','--bootstrap'],timeout=120)
 bd=inspect('container','buildx_buildkit_'+B+'0'); caps=bd['HostConfig']
 if caps['Memory']!=2147483648 or caps['MemorySwap']!=2147483648 or caps['CpuQuota']!=100000 or caps['CpuPeriod']!=100000: raise RuntimeError('build caps')
 manifest['buildCaps']={k:caps[k] for k in ['Memory','MemorySwap','CpuQuota','CpuPeriod']}
 for target in ['production','builder']:
  phase('build-'+target)
  tag=N+':'+target
  run([*DOCKER,'buildx','build','--builder',B,'--platform','linux/amd64','--target',target,'--label','org.opencontainers.image.revision='+SHA,'--label','dollhouse.native='+N,'--label','org.dollhousemcp.ci.source='+SHA,'--tag',tag,'--load','--provenance=false','--file','docker/Dockerfile','.'],timeout=1200,cwd=S)
  build_output=(O/f'{counter:03}-stdout.txt').read_text(errors='replace')+(O/f'{counter:03}-stderr.txt').read_text(errors='replace')
  resolved=sorted(set(__import__('re').findall(r'FROM (?:docker.io/library/)?node:24-slim@(sha256:[a-f0-9]{64})',build_output)))
  expected_base={x.rsplit('@',1)[-1] for x in base.get('RepoDigests',[])}
  if not resolved or not set(resolved)<=expected_base: raise RuntimeError('mutable base resolution changed or not observed')
  manifest['buildResolvedBaseDigests'][target]=resolved
  image=inspect('image',tag)
  if image['RootFS']['Layers'][:len(base['RootFS']['Layers'])]!=base['RootFS']['Layers']: raise RuntimeError('actual base layer identity mismatch')
  if image['Architecture']!='amd64' or image['Os']!='linux' or image['Config']['Labels']['org.opencontainers.image.revision']!=SHA: raise RuntimeError('image platform/source')
  manifest['images'][target]=image
  if target=='production' and os.environ.get('GITHUB_OUTPUT'):
   with open(os.environ['GITHUB_OUTPUT'],'a') as f: f.write('image='+image['Id']+'\n')
 run([*DOCKER,'pull','--platform','linux/amd64','postgres:17-alpine'],timeout=180); pgimage=inspect('image','postgres:17-alpine'); manifest['postgres']=pgimage
 admin=secrets.token_hex(24); app=secrets.token_hex(24); master=__import__('base64').b64encode(secrets.token_bytes(32)).decode()
 fixture_secrets.extend([admin,app,master])
 pg_env=write_env('pg.env',{'POSTGRES_USER':'dollhouse','POSTGRES_DB':'dollhousemcp','POSTGRES_PASSWORD':admin,'DOLLHOUSE_APP_DB_PASSWORD':app})
 common={'DOLLHOUSE_DATABASE_URL':'postgres://dollhouse_app:'+app+'@'+PG+':5432/dollhousemcp','DOLLHOUSE_DATABASE_ADMIN_URL':'postgres://dollhouse:'+admin+'@'+PG+':5432/dollhousemcp','DOLLHOUSE_DATABASE_SSL':'disable','DOLLHOUSE_DATABASE_POOL_SIZE':'2'}
 migrate_env=write_env('migration.env',common)
 app_env=write_env('app.env',{**common,'NODE_ENV':'production','DOLLHOUSE_TRANSPORT':'streamable-http','DOLLHOUSE_MEMORY_UPGRADE_CONTROL_DIR':'/app/.memory-upgrade-control','DOLLHOUSE_HTTP_HOST':'127.0.0.1','DOLLHOUSE_HTTP_PORT':'3000','DOLLHOUSE_HTTP_ALLOWED_HOSTS':'localhost,127.0.0.1','DOLLHOUSE_PUBLIC_BASE_URL':'http://127.0.0.1:3000','DOLLHOUSE_UNSAFE_NO_TLS':'true','DOLLHOUSE_STORAGE_BACKEND':'database','DOLLHOUSE_DATABASE_MEMORY_GUARDED':'false','DOLLHOUSE_AUTH_ENABLED':'true','DOLLHOUSE_AUTH_PROVIDER':'local','DOLLHOUSE_AUTH_STORAGE_BACKEND':'memory','DOLLHOUSE_AUTH_LOCAL_KEY_FILE':'/app/tmp/rehearsal-local-key.json','DOLLHOUSE_WEB_AUTH_ENABLED':'false','DOLLHOUSE_MASTER_ENCRYPTION_KEY':master,'DOLLHOUSE_PORTFOLIO_DIR':'/app/tmp/portfolio','DOLLHOUSE_DISABLE_UPDATES':'true'})
 pins[NET]=run([*DOCKER,'network','create','--internal','--label','dollhouse.native='+N,NET]).decode().strip(); network=True; inspect('network',NET)
 run([*DOCKER,'volume','create','--label','dollhouse.native='+N,VOL]); volume=True
 volume_data=inspect('volume',VOL)
 if volume_data.get('Labels',{}).get('dollhouse.native')!=N: raise RuntimeError('created volume ownership mismatch')
 volume_identity={k:volume_data.get(k) for k in ['Name','CreatedAt','Mountpoint','Driver','Scope','Labels']}
 phase('fresh-postgres-tcp-readiness')
 create_container(PG,['--network',NET,'--memory','512m','--cpus','1','--env-file',pg_env,'-v',VOL+':/var/lib/postgresql/data',pgimage['Id']])
 mounts=inspect('container',PG)['Mounts']
 if not any(m.get('Type')=='volume' and m.get('Name')==VOL and m.get('Source')==volume_identity['Mountpoint'] and m.get('Destination')=='/var/lib/postgresql/data' for m in mounts): raise RuntimeError('owned volume mount mismatch')
 deadline=time.monotonic()+60
 while True:
  p=subprocess.run([*DOCKER,'exec',pins[PG],'pg_isready','-h','127.0.0.1','-U','dollhouse','-d','dollhousemcp'],capture_output=True,timeout=5)
  if p.returncode==0: break
  if time.monotonic()>deadline: raise RuntimeError('PG deadline')
  time.sleep(1)
 phase('role-bootstrap')
 sql(b"\\getenv app_password DOLLHOUSE_APP_DB_PASSWORD\nSELECT format('CREATE ROLE dollhouse_app WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', :'app_password')\n\\gexec\n")
 phase('exact-image-migrations')
 create_container(MIG,['--network',NET,'--memory','512m','--cpus','1','--env-file',migrate_env,manifest['images']['builder']['Id'],'npm','run','db:migrate'],attach=True)
 ms=state_record(MIG)
 if ms['state']['Running'] or ms['state']['ExitCode'] or ms['state']['OOMKilled']: raise RuntimeError('migration did not close')
 migrations=S/'src/database/migrations'; entries=json.loads((migrations/'meta/_journal.json').read_text())['entries']
 if len(entries)!=62 or [x['idx'] for x in entries]!=list(range(62)) or any(entries[i]['when']>=entries[i+1]['when'] for i in range(61)): raise RuntimeError('source journal')
 expected=[{'hash':hashlib.sha256((migrations/(x['tag']+'.sql')).read_bytes()).hexdigest(),'created_at':x['when']} for x in entries]
 actual=[json.loads(x) for x in sql(b"SELECT json_build_object('hash',hash,'created_at',created_at)::text FROM drizzle.__drizzle_migrations ORDER BY created_at,id;").decode().splitlines()]
 if actual!=expected: raise RuntimeError('complete ledger mismatch')
 (O/'ledger.json').write_text(json.dumps(actual,indent=2))
 phase('ledger-and-source-grants')
 grants=P/'grants.sql'
 run(['bash','-c','source "$1"; POST_MIGRATION_GRANTS_FILE="$2"; write_post_migration_grants','render',str(S/'scripts/hosted-deploy/render.sh'),str(grants)],record=False)
 sql(b'\\getenv app_password DOLLHOUSE_APP_DB_PASSWORD\n'+grants.read_bytes()); check_catalog()
 phase('same-image-off-startup')
 create_container(APP,['--network',NET,'--memory','512m','--cpus','1','--env-file',app_env,'--tmpfs','/app/tmp:rw,nosuid,size=200m,mode=1777','--tmpfs','/app/logs:rw,nosuid,size=100m,mode=1777','--tmpfs','/tmp:rw,noexec,nosuid,size=200m,mode=1777','--cap-drop','ALL','--security-opt','no-new-privileges',manifest['images']['production']['Id']])
 deadline=time.monotonic()+90
 while True:
  p=subprocess.run([*DOCKER,'exec',pins[APP],'node','-e',"fetch('http://127.0.0.1:3000/readyz',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],capture_output=True,timeout=8)
  if p.returncode==0: break
  if time.monotonic()>deadline: raise RuntimeError('OFF readyz deadline')
  time.sleep(1)
 native=json.loads(run([*DOCKER,'exec',pins[APP],'node','-e',"console.log(JSON.stringify({arch:process.arch,node:process.version,uid:process.getuid()}))"]))
 if native['arch']!='x64' or native['uid']!=1001: raise RuntimeError('actual native nonroot process')
 identity=run([*DOCKER,'exec',pins[APP],'node','--input-type=module','-e',"import {BuildInfoService} from './dist/services/BuildInfoService.js'; console.log(JSON.stringify(await new BuildInfoService().getBuildInfo()))"])
 info=json.loads(identity)
 if info['package']['version']!=json.loads((S/'package.json').read_text())['version'] or info['runtime']['arch']!='x64' or info['runtime']['platform']!='linux' or not info['build']['timestamp']: raise RuntimeError('compiled metadata')
 (O/'compiled-build-info.json').write_bytes(identity)
 manifest['native']=native
 phase('off-ready-native-identity-and-close')
 closed(APP); state=state_record(APP)
 image=manifest['images']['production']
 default_command=(image['Config'].get('Entrypoint') or [])+(image['Config'].get('Cmd') or [])
 if not default_command: raise RuntimeError('image default command absent')
 if state['ports'].get('3000/tcp') is not None or state['memory']!=536870912 or state['nanoCpus']!=1000000000 or state['user']!=image['Config']['User'] or state['path']!=default_command[0] or state['args']!=default_command[1:]: raise RuntimeError('runtime defaults/caps/ports')
 check_catalog(); state_record(PG)
 phase('same-id-native-four-case-v2-engine-witness')
 try:
  run(['python3',str(S/'tests/scripts/memory-upgrade-docker-engine.py'),manifest['images']['production']['Id'],SHA],timeout=210,cwd=S)
 finally:
  proof=pathlib.Path('/tmp/memory-upgrade-engine-proof.json')
  if proof.exists(): shutil.copyfile(proof,O/'native-engine-proof.json')
 manifest['nativeRuntimePassed']=True
 audit_image(manifest['images']['production']['Id'])
 for target in ['production','builder']:
  phase('export-'+target)
  image=manifest['images'][target]; archive=O/(target+'.docker.tar')
  run([*DOCKER,'save','--output',str(archive),image['Id']],timeout=180)
  with tarfile.open(archive) as t:
   m=json.load(t.extractfile('manifest.json'))
   if len(m)!=1 or pathlib.PurePosixPath(m[0]['Config']).stem!=image['Id'].split(':')[1]: raise RuntimeError('archive image config identity')
   config=t.extractfile(m[0]['Config']).read()
   if hashlib.sha256(config).hexdigest()!=image['Id'].split(':')[1]: raise RuntimeError('archive config digest')
  manifest['images'][target]['archiveSha256']=hashlib.file_digest(archive.open('rb'),'sha256').hexdigest()
  manifest['images'][target]['archiveBytes']=archive.stat().st_size
 manifest['scope']='native AMD64 exact6c migration/OFF localauth default startup/v2 drain and four-case engine witness; actual installed/npm/OS inventory; no historical restore/production auth/key/SMTP/deployment/guard activation'
 if audit_needs_disposition: raise RuntimeError('Image audit high/critical findings require explicit release disposition')
except BaseException as e:
 failure=type(e).__name__+': '+str(e)
 if APP in pins:
  try:
   state_record(APP); run([*DOCKER,'logs',pins[APP]],record=True)
  except Exception: pass
finally:
 phase('owned-cleanup')
 try: cleanup()
 except Exception as e: failure=(failure or '')+'; '+str(e)
 (O/'manifest.json').write_text(json.dumps(manifest,indent=2))
 (O/'result.json').write_text(json.dumps({'success':failure is None,'failure':failure},indent=2))
 files=sorted(p for p in O.iterdir() if p.is_file())
 with (O/'SHA256SUMS').open('w') as f:
  for p in files: f.write(hashlib.file_digest(p.open('rb'),'sha256').hexdigest()+'  '+p.name+'\n')
if failure: print(failure); sys.exit(1)
print('Native AMD64 exact-image acquisition and synthetic OFF proof complete; owned resources absent.')
