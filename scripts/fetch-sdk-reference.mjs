import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const provenance=JSON.parse(await readFile('data/sdk/core-0.3.9.json','utf8'));
const response=await fetch(provenance.publicFixture.url,{signal:AbortSignal.timeout(20000)});if(!response.ok)throw new Error('REFERENCE_SOURCE_UNAVAILABLE');
const source=await response.text();if(createHash('sha256').update(source).digest('hex')!==provenance.publicFixture.sha256)throw new Error('REFERENCE_SOURCE_CHANGED');
const literal='"(?:\\\\.|[^"\\\\])*"';
function value(expression){const m=source.match(new RegExp(expression+'\\s*(?:hex)?('+literal+')'));if(!m)throw new Error('REFERENCE_PARSE_FAILED');return JSON.parse(m[1]);}
function object(expression){const m=source.match(new RegExp(expression+'\\s*\\{([\\s\\S]*?)\\}'));if(!m)throw new Error('REFERENCE_PARSE_FAILED');return m[1];}
function field(text,name){const m=text.match(new RegExp(name+':\\s*('+literal+')'));if(!m)throw new Error('REFERENCE_PARSE_FAILED');return JSON.parse(m[1]);}
const request=object('AttNetworkRequest\\('),resolve=object('AttNetworkResponseResolve\\('),attestor=object('Attestor\\(');
const recipient=source.match(/att\.recipient\s*=\s*(0x[0-9a-fA-F]{40})/),address=attestor.match(/attestorAddr:\s*(0x[0-9a-fA-F]{40})/),timestamp=source.match(/att\.timestamp\s*=\s*([0-9]+)/);if(!recipient||!address||!timestamp)throw new Error('REFERENCE_PARSE_FAILED');
let signature=value('att\\.signatures\\[0\\]\\s*=');if(!signature.startsWith('0x'))signature='0x'+signature;
const attestation={recipient:recipient[1],request:Object.fromEntries(['url','header','method','body'].map(k=>[k,field(request,k)])),reponseResolve:[Object.fromEntries(['keyName','parseType','parsePath'].map(k=>[k,field(resolve,k)]))],data:value('att\\.data\\s*='),attConditions:value('att\\.attConditions\\s*='),additionParams:value('att\\.additionParams\\s*='),timestamp:Number(timestamp[1]),attestors:[{attestorAddr:address[1],url:field(attestor,'url')}],signatures:[signature]};
await mkdir('.local/sdk-reference',{recursive:true});await writeFile('.local/sdk-reference/attestation.json',JSON.stringify(attestation),{mode:0o600});
console.log('Pinned official SDK reference prepared locally; no payload printed.');
