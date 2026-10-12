#!/usr/bin/env python3
"""Single hosted native artifact acquisition; synthetic inputs only, no publish/deploy."""
import os,sys,pathlib,subprocess,json,hashlib,secrets,time,tarfile,shutil
S=pathlib.Path(sys.argv[1]).resolve(); O=pathlib.Path(sys.argv[2]).resolve(); O.mkdir(mode=0o700)
P=O.parent/'private-native'; P.mkdir(mode=0o700); os.umask(0o077)
SHA='e5449665b24907a3b3b01353ac8bbe0f4f3ee3e6'; TREE='de79bdb7891e9b1eb294851989c2dc0058996086'
N='d2870-'+os.environ['GITHUB_RUN_ID']+'-'+os.environ['GITHUB_RUN_ATTEMPT']; NET=N+'-net'; PG=N+'-pg'; APP=N+'-app'; MIG=N+'-migrate'; B=N+'-build'; VOL=N+'-pgdata'
containers=[]; network=False; volume=False; builder=False; counter=0; fixture_secrets=[]

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

def inspect(kind,name): return json.loads(run(['docker',kind,'inspect',name],record=False))[0]
def write_env(name,fields):
 f=P/name; f.write_text(''.join(k+'='+v+'\n' for k,v in fields.items())); return str(f)
def sql(query): return run(['docker','exec','-i',PG,'psql','-X','-Atq','-v','ON_ERROR_STOP=1','-U','dollhouse','-d','dollhousemcp'],stdin=query,record=False)
def closed(name):
 run(['docker','stop','--time','20',name],timeout=30); run(['docker','wait',name],timeout=10)
 state=inspect('container',name)['State']
 if state['Running'] or state['ExitCode'] or state['OOMKilled']: raise RuntimeError('unsuccessful close '+name)
 return state

def state_record(name):
 d=inspect('container',name)
 safe={'name':name,'id':d['Id'],'image':d['Image'],'user':d['Config']['User'],'path':d['Path'],'args':d['Args'],'state':d['State'],'ports':d['NetworkSettings']['Ports'],'memory':d['HostConfig']['Memory'],'cpuQuota':d['HostConfig']['CpuQuota'],'cpuPeriod':d['HostConfig']['CpuPeriod'],'nanoCpus':d['HostConfig']['NanoCpus']}
 (O/(name+'-state.json')).write_text(json.dumps(safe,indent=2)); return safe

def check_catalog():
 if sql((pathlib.Path(__file__).parent/'native-amd64-catalog.sql').read_bytes()).strip()!=b't': raise RuntimeError('APP SYSTEM grants or empty guarded catalog mismatch')

def cleanup():
 errors=[]; children_settled=True; pg_settled=True
 for name in reversed(containers):
  if name==PG and not children_settled:
   errors.append('database retained: child settlement unproven'); pg_settled=False; continue
  try:
   d=json.loads(run(['docker','container','inspect',name],record=False))[0]
   if d['Config']['Labels'].get('dollhouse.native')!=N: raise RuntimeError('ownership mismatch')
   run(['docker','stop','--time','20',name],timeout=30,record=False); run(['docker','wait',name],timeout=10,record=False)
   settled=json.loads(run(['docker','container','inspect',name],record=False))[0]['State']
   if settled['Running']: raise RuntimeError('child remains running')
   run(['docker','rm',name],record=False)
  except Exception as e:
   errors.append(type(e).__name__+':'+name)
   if name in (APP,MIG): children_settled=False
   if name==PG: pg_settled=False
 if volume and children_settled and pg_settled:
  try:
   d=inspect('volume',VOL)
   if d['Labels'].get('dollhouse.native')!=N: raise RuntimeError('volume owner')
   run(['docker','volume','rm',VOL])
  except Exception: errors.append('volume cleanup')
 if network and children_settled and pg_settled:
  try:
   d=inspect('network',NET)
   if d['Labels'].get('dollhouse.native')!=N: raise RuntimeError('network owner')
   run(['docker','network','rm',NET])
  except Exception: errors.append('network cleanup')
 if builder:
  try: run(['docker','buildx','rm',B],timeout=30)
  except Exception: errors.append('builder cleanup')
 absent={}
 for kind,names in [('container',containers),('volume',[VOL]),('network',[NET]),('container',['buildx_buildkit_'+B+'0']),('volume',['buildx_buildkit_'+B+'0_state'])]:
  for name in names:
   p=subprocess.run(['docker',kind,'inspect',name],capture_output=True,timeout=10)
   absent[kind+':'+name]=p.returncode!=0 and ('no such' in p.stderr.decode().lower() or 'not found' in p.stderr.decode().lower())
 (O/'cleanup.json').write_text(json.dumps({'errors':errors,'absent':absent},indent=2))
 shutil.rmtree(P)
 if errors or not all(absent.values()): raise RuntimeError('owned cleanup incomplete')

failure=None; manifest={}
try:
 if run(['uname','-m']).strip()!=b'x86_64': raise RuntimeError('runner not native AMD64')
 if run(['git','rev-parse','HEAD'],cwd=S).strip().decode()!=SHA or run(['git','rev-parse','HEAD^{tree}'],cwd=S).strip().decode()!=TREE: raise RuntimeError('source pin')
 if run(['git','status','--porcelain'],cwd=S).strip(): raise RuntimeError('dirty source')
 manifest={'source':SHA,'tree':TREE,'driver':os.environ['GITHUB_SHA'],'run':os.environ['GITHUB_RUN_ID'],'attempt':os.environ['GITHUB_RUN_ATTEMPT'],'platform':'linux/amd64','files':{f:hashlib.sha256((S/f).read_bytes()).hexdigest() for f in ['docker/Dockerfile','package-lock.json','packages/safety/package-lock.json'] if (S/f).exists()},'images':{}}
 run(['docker','version']); run(['docker','buildx','version'])
 for kind,names in [('container',[APP,MIG,PG,'buildx_buildkit_'+B+'0']),('volume',[VOL,'buildx_buildkit_'+B+'0_state']),('network',[NET])]:
  for name in names:
   probe=subprocess.run(['docker',kind,'inspect',name],capture_output=True,timeout=10)
   if probe.returncode==0 or not ('no such' in probe.stderr.decode().lower() or 'not found' in probe.stderr.decode().lower()): raise RuntimeError('owned namespace not proven absent')
 builder=True
 run(['docker','buildx','create','--name',B,'--driver','docker-container','--driver-opt','memory=2g,memory-swap=2g,cpu-period=100000,cpu-quota=100000','--bootstrap'],timeout=120)
 bd=inspect('container','buildx_buildkit_'+B+'0'); caps=bd['HostConfig']
 if caps['Memory']!=2147483648 or caps['MemorySwap']!=2147483648 or caps['CpuQuota']!=100000 or caps['CpuPeriod']!=100000: raise RuntimeError('build caps')
 manifest['buildCaps']={k:caps[k] for k in ['Memory','MemorySwap','CpuQuota','CpuPeriod']}
 for target in ['production','builder']:
  phase('build-'+target)
  tag=N+':'+target
  run(['docker','buildx','build','--builder',B,'--platform','linux/amd64','--target',target,'--label','org.opencontainers.image.revision='+SHA,'--label','dollhouse.native='+N,'--tag',tag,'--load','--provenance=false','--file','docker/Dockerfile','.'],timeout=1200,cwd=S)
  image=inspect('image',tag)
  if image['Architecture']!='amd64' or image['Os']!='linux' or image['Config']['Labels']['org.opencontainers.image.revision']!=SHA: raise RuntimeError('image platform/source')
  manifest['images'][target]=image
 run(['docker','pull','--platform','linux/amd64','postgres:17-alpine'],timeout=180); pgimage=inspect('image','postgres:17-alpine'); manifest['postgres']=pgimage
 admin=secrets.token_hex(24); app=secrets.token_hex(24); master=__import__('base64').b64encode(secrets.token_bytes(32)).decode()
 fixture_secrets.extend([admin,app,master])
 pg_env=write_env('pg.env',{'POSTGRES_USER':'dollhouse','POSTGRES_DB':'dollhousemcp','POSTGRES_PASSWORD':admin,'DOLLHOUSE_APP_DB_PASSWORD':app})
 common={'DOLLHOUSE_DATABASE_URL':'postgres://dollhouse_app:'+app+'@'+PG+':5432/dollhousemcp','DOLLHOUSE_DATABASE_ADMIN_URL':'postgres://dollhouse:'+admin+'@'+PG+':5432/dollhousemcp','DOLLHOUSE_DATABASE_SSL':'disable','DOLLHOUSE_DATABASE_POOL_SIZE':'2'}
 migrate_env=write_env('migration.env',common)
 app_env=write_env('app.env',{**common,'NODE_ENV':'production','DOLLHOUSE_TRANSPORT':'streamable-http','DOLLHOUSE_HTTP_HOST':'127.0.0.1','DOLLHOUSE_HTTP_PORT':'3000','DOLLHOUSE_HTTP_ALLOWED_HOSTS':'localhost,127.0.0.1','DOLLHOUSE_PUBLIC_BASE_URL':'http://127.0.0.1:3000','DOLLHOUSE_UNSAFE_NO_TLS':'true','DOLLHOUSE_STORAGE_BACKEND':'database','DOLLHOUSE_DATABASE_MEMORY_GUARDED':'false','DOLLHOUSE_AUTH_ENABLED':'true','DOLLHOUSE_AUTH_PROVIDER':'local','DOLLHOUSE_AUTH_STORAGE_BACKEND':'memory','DOLLHOUSE_AUTH_LOCAL_KEY_FILE':'/app/tmp/rehearsal-local-key.json','DOLLHOUSE_WEB_AUTH_ENABLED':'false','DOLLHOUSE_MASTER_ENCRYPTION_KEY':master,'DOLLHOUSE_PORTFOLIO_DIR':'/app/tmp/portfolio','DOLLHOUSE_DISABLE_UPDATES':'true'})
 run(['docker','network','create','--internal','--label','dollhouse.native='+N,NET]); network=True
 run(['docker','volume','create','--label','dollhouse.native='+N,VOL]); volume=True
 phase('fresh-postgres-tcp-readiness')
 containers.append(PG)
 run(['docker','run','-d','--name',PG,'--label','dollhouse.native='+N,'--network',NET,'--memory','512m','--cpus','1','--env-file',pg_env,'-v',VOL+':/var/lib/postgresql/data',pgimage['Id']])
 deadline=time.monotonic()+60
 while True:
  p=subprocess.run(['docker','exec',PG,'pg_isready','-h','127.0.0.1','-U','dollhouse','-d','dollhousemcp'],capture_output=True,timeout=5)
  if p.returncode==0: break
  if time.monotonic()>deadline: raise RuntimeError('PG deadline')
  time.sleep(1)
 phase('role-bootstrap')
 sql(b"\\getenv app_password DOLLHOUSE_APP_DB_PASSWORD\nSELECT format('CREATE ROLE dollhouse_app WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', :'app_password')\n\\gexec\n")
 phase('exact-image-migrations')
 containers.append(MIG)
 run(['docker','run','--name',MIG,'--label','dollhouse.native='+N,'--network',NET,'--memory','512m','--cpus','1','--env-file',migrate_env,manifest['images']['builder']['Id'],'npm','run','db:migrate'],timeout=120,record=False)
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
 containers.append(APP)
 run(['docker','run','-d','--name',APP,'--label','dollhouse.native='+N,'--network',NET,'--memory','512m','--cpus','1','--env-file',app_env,'--tmpfs','/app/tmp:rw,nosuid,size=200m,mode=1777','--tmpfs','/app/logs:rw,nosuid,size=100m,mode=1777','--tmpfs','/tmp:rw,noexec,nosuid,size=200m,mode=1777','--cap-drop','ALL','--security-opt','no-new-privileges',manifest['images']['production']['Id']])
 deadline=time.monotonic()+90
 while True:
  p=subprocess.run(['docker','exec',APP,'node','-e',"fetch('http://127.0.0.1:3000/readyz',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],capture_output=True,timeout=8)
  if p.returncode==0: break
  if time.monotonic()>deadline: raise RuntimeError('OFF readyz deadline')
  time.sleep(1)
 native=json.loads(run(['docker','exec',APP,'node','-e',"console.log(JSON.stringify({arch:process.arch,node:process.version,uid:process.getuid()}))"]))
 if native['arch']!='x64' or native['uid']!=1001: raise RuntimeError('actual native nonroot process')
 identity=run(['docker','exec',APP,'node','--input-type=module','-e',"import {BuildInfoService} from './dist/services/BuildInfoService.js'; console.log(JSON.stringify(await new BuildInfoService().getBuildInfo()))"])
 info=json.loads(identity)
 if info['package']['version']!=json.loads((S/'package.json').read_text())['version'] or info['runtime']['arch']!='x64' or info['runtime']['platform']!='linux' or not info['build']['timestamp']: raise RuntimeError('compiled metadata')
 (O/'compiled-build-info.json').write_bytes(identity)
 manifest['native']=native
 phase('off-ready-native-identity-and-close')
 closed(APP); state=state_record(APP)
 image=manifest['images']['production']
 if state['ports'].get('3000/tcp') is not None or state['memory']!=536870912 or state['nanoCpus']!=1000000000 or state['user']!=image['Config']['User'] or state['path']!=image['Config']['Cmd'][0] or state['args']!=image['Config']['Cmd'][1:]: raise RuntimeError('runtime defaults/caps/ports')
 check_catalog(); state_record(PG)
 for target in ['production','builder']:
  phase('export-'+target)
  image=manifest['images'][target]; archive=O/(target+'.docker.tar')
  run(['docker','save','--output',str(archive),image['Id']],timeout=180)
  with tarfile.open(archive) as t:
   m=json.load(t.extractfile('manifest.json'))
   if len(m)!=1 or pathlib.PurePosixPath(m[0]['Config']).stem!=image['Id'].split(':')[1]: raise RuntimeError('archive image config identity')
   config=t.extractfile(m[0]['Config']).read()
   if hashlib.sha256(config).hexdigest()!=image['Id'].split(':')[1]: raise RuntimeError('archive config digest')
  manifest['images'][target]['archiveSha256']=hashlib.file_digest(archive.open('rb'),'sha256').hexdigest()
  manifest['images'][target]['archiveBytes']=archive.stat().st_size
 manifest['scope']='native AMD64 synthetic migration/OFF startup; no historical restore, production auth/key/drain/deployment/activation'
except BaseException as e:
 failure=type(e).__name__+': '+str(e)
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
