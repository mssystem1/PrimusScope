import {build} from 'esbuild';
import {mkdir,writeFile,readdir,unlink,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
process.chdir(fileURLToPath(new URL('../',import.meta.url)));
const provenance=JSON.parse(await readFile('data/sdk/page-core-0.2.1.json','utf8'));
const lock=JSON.parse(await readFile('package-lock.json','utf8')).packages['node_modules/'+provenance.package];
if(lock?.version!==provenance.version||lock?.integrity!==provenance.integrity)throw new Error('SDK_PACKAGE_PIN_MISMATCH');
for(const [file,expected]of Object.entries(provenance.sourceHashes)){
  const actual=createHash('sha256').update(await readFile('node_modules/'+provenance.package+'/'+file)).digest('hex');
  if(actual!==expected)throw new Error('SDK_SOURCE_PIN_MISMATCH');
}
const coreProvenance=JSON.parse(await readFile('data/sdk/core-0.3.9.json','utf8'));
for(const [file,expected]of Object.entries(coreProvenance.sourceHashes))if(createHash('sha256').update(await readFile(file)).digest('hex')!==expected)throw new Error('CORE_SDK_SOURCE_PIN_MISMATCH');
const method=await readFile('vendor/primus-core-0.3.9/verify-method.txt','utf8');
if(!(await readFile('vendor/primus-core-0.3.9/verify.cjs','utf8')).includes(method))throw new Error('CORE_SDK_METHOD_CHANGED');
const result=await build({absWorkingDir:process.cwd(),entryPoints:['apps/web/src/workers/attestation.worker.ts'],bundle:true,platform:'browser',format:'iife',target:'es2022',minify:true,write:false,legalComments:'eof',define:{'process.env.NODE_ENV':'"production"'}});
const bytes=result.outputFiles[0].contents,hash=createHash('sha256').update(bytes).digest('hex').slice(0,16);
await mkdir('apps/web/public/sdk',{recursive:true});
for(const file of await readdir('apps/web/public/sdk'))if(/^primus-page-verifier-[a-f0-9]+\.js$/.test(file))await unlink('apps/web/public/sdk/'+file);
await writeFile(`apps/web/public/sdk/primus-page-verifier-${hash}.js`,bytes);
const core=await build({absWorkingDir:process.cwd(),entryPoints:['apps/web/src/workers/core-attestation.worker.ts'],bundle:true,platform:'browser',format:'iife',target:'es2022',minify:true,write:false,metafile:true,legalComments:'eof',plugins:[{name:'verification-only-ethers',setup(build){build.onResolve({filter:/^ethers$/},()=>({path:fileURLToPath(new URL('../apps/web/src/workers/ethers-verify-shim.ts',import.meta.url))}));}}]});
if(Object.keys(core.metafile.inputs).some(path=>/zktls-page-core-sdk|primus_zk|AlgorithmUrls|koffi|node:|\/ws\//.test(path)))throw new Error('CORE_WORKER_RUNTIME_DEPENDENCY');
const coreBytes=core.outputFiles[0].contents,coreHash=createHash('sha256').update(coreBytes).digest('hex');
for(const file of await readdir('apps/web/public/sdk'))if(/^primus-core-verifier-[a-f0-9]+\.js$/.test(file))await unlink('apps/web/public/sdk/'+file);
const corePath='/sdk/primus-core-verifier-'+coreHash.slice(0,16)+'.js';await writeFile('apps/web/public'+corePath,coreBytes);
await writeFile('apps/web/src/lib/sdk-worker-manifest.json',JSON.stringify({path:`/sdk/primus-page-verifier-${hash}.js`,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,core:{path:corePath,sha256:coreHash,bytes:coreBytes.length}})+'\n');
console.log('Core verification-only offline worker: '+coreBytes.length+' bytes; native runtime excluded.');
console.log(`Official SDK offline worker: ${bytes.length} bytes; SHA-256 ${hash}`);
