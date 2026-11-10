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
const result=await build({absWorkingDir:process.cwd(),entryPoints:['apps/web/src/workers/attestation.worker.ts'],bundle:true,platform:'browser',format:'iife',target:'es2022',minify:true,write:false,legalComments:'eof',define:{'process.env.NODE_ENV':'"production"'}});
const bytes=result.outputFiles[0].contents,hash=createHash('sha256').update(bytes).digest('hex').slice(0,16);
await mkdir('apps/web/public/sdk',{recursive:true});
for(const file of await readdir('apps/web/public/sdk'))if(/^primus-page-verifier-[a-f0-9]+\.js$/.test(file))await unlink('apps/web/public/sdk/'+file);
await writeFile(`apps/web/public/sdk/primus-page-verifier-${hash}.js`,bytes);
await writeFile('apps/web/src/lib/sdk-worker-manifest.json',JSON.stringify({path:`/sdk/primus-page-verifier-${hash}.js`,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length})+'\n');
console.log(`Official SDK offline worker: ${bytes.length} bytes; SHA-256 ${hash}`);
