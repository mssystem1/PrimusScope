import{describe,it,expect,vi,afterEach}from'vitest';
import{getObservationSet}from'@primusscope/data';
import{observeSavedObjects}from'./workspace-observations';
import{watchReference}from'./watch-reference';
import{compareSaved,readBaselines}from'./workspace-tracking';
import{readSaved,pruneBaselines,BASELINE_STORAGE,WORKSPACE_STORAGE}from'./public-workspace';
import{WatchRequestSchema,WatchResponseSchema}from'./workspace-schema';
const source=await getObservationSet(),task=source.network.stateSamples[0]!.taskId,href=`/network/tasks/8453/${source.network.taskContract}/${task}`,item={id:'tracked-task',href};
const observe=(snapshot=source)=>observeSavedObjects(snapshot,[item],'recorded_observations')[0]!;
afterEach(()=>vi.unstubAllGlobals());
describe('saved public object observations and baselines',()=>{
 it('allows exact supported references and rejects external, ambiguous or private query routes',()=>{
  expect(watchReference(href)?.kind).toBe('task');expect(watchReference('/finance?range=7d')?.kind).toBe('view');expect(watchReference('/finance/vaults/united-stables-confidential-vault?range=30d')?.kind).toBe('view');
  for(const input of ['//evil.test/network','/network?privateKey=secret','/network?range=7d&range=24h','/network?cursor=private','/network#private','/network/tasks/56/'+source.network.taskContract+'/'+task])expect(watchReference(input)).toBeNull();
 });
 it('projects minimal source data without raw event bodies or participant details',()=>{
  const observed=observe();expect(observed.availability).toBe('available');expect(observed.kind).toBe('task');expect(observed.eventCount).toBeGreaterThan(0);expect(observed.scopeKey).toHaveLength(64);
  expect(WatchResponseSchema.safeParse({snapshotId:source.snapshotId,checkedAt:new Date().toISOString(),mode:'recorded_observations',items:[observed]}).success).toBe(true);
  for(const key of ['events','submittedAt','signatures','recipient','caller','assetsRaw','taskResults'])expect(Object.keys(observed)).not.toContain(key);
 });
 it('ignores growing coverage when an object event set and native state are unchanged',()=>{
  const initial=observe(),next=structuredClone(source);next.network.coverage.toBlock=String(BigInt(next.network.coverage.toBlock)+1n);
  const current=observe(next);expect(current.contentHash).toBe(initial.contentHash);expect(compareSaved(current,{reviewedAt:source.generatedAt,observation:initial})).toMatchObject({code:'unchanged'});
 });
 it('detects state changes and does not silently acknowledge them',()=>{
  const initial=observe(),next=structuredClone(source);next.network.stateSamples[0]!.nativeStatusCode=4;
  expect(compareSaved(observe(next),{reviewedAt:source.generatedAt,observation:initial})).toMatchObject({code:'changed',detail:expect.stringContaining('Observed state changed')});
  expect(initial.state).not.toBe('FAILED');
 });
 it('suppresses growth comparisons across a shifted history boundary or regressed source',()=>{
  const initial=observe(),next=structuredClone(initial);next.scopeKey='f'.repeat(64);next.eventCount=100;
  expect(compareSaved(next,{reviewedAt:source.generatedAt,observation:initial}).code).toBe('scope_changed');
  next.scopeKey=initial.scopeKey;next.coverage!.toBlock=String(BigInt(initial.coverage!.toBlock)-1n);expect(compareSaved(next,{reviewedAt:source.generatedAt,observation:initial}).code).toBe('revised');
 });
 it('keeps missing objects and incomplete coverage distinct from deletion or zero changes',()=>{
  const absent=observeSavedObjects(source,[{id:'missing',href:href.replace(task,'0x'+'ff'.repeat(32))}],'recorded_observations')[0]!;
  expect(absent).toMatchObject({availability:'unavailable',reason:'NOT_FOUND',eventCount:null});expect(compareSaved(absent).detail).toContain('does not mean the object was deleted');
  const partial=structuredClone(source);partial.network.coverage.completeForRegisteredContracts=false;expect(observe(partial).reason).toBe('INCOMPLETE_COVERAGE');
 });
 it('describes saved-view source updates without a filtered activity growth claim',()=>{
  const view={id:'view',href:'/network?range=7d&eventKind=ReportResult#activity'};
  const a=observeSavedObjects(source,[view],'recorded_observations')[0]!,b=structuredClone(source);b.network.coverage.toBlock=String(BigInt(b.network.coverage.toBlock)+1n);
  const compared=compareSaved(observeSavedObjects(b,[view],'recorded_observations')[0]!,{reviewedAt:source.generatedAt,observation:a});expect(compared.code).toBe('source_updated');expect(compared.detail).toContain('not a measured activity increase');expect(a.eventCount).toBeNull();
 });
 it('bounds strict request bodies and rejects private fields and duplicate IDs',()=>{
  expect(WatchRequestSchema.safeParse({items:[item],proof:'secret'}).success).toBe(false);expect(WatchRequestSchema.safeParse({items:[item,item]}).success).toBe(false);expect(WatchRequestSchema.safeParse({items:Array.from({length:51},(_,i)=>({...item,id:String(i)}))}).success).toBe(false);
 });
 it('keeps old saved-item storage compatible and discards malformed baseline fields',()=>{
  const values=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value),removeItem:(key:string)=>values.delete(key)});
  values.set(WORKSPACE_STORAGE,JSON.stringify([{...item,title:'Saved task',domain:'network',savedAt:source.generatedAt}]));expect(readSaved()).toHaveLength(1);
  values.set(BASELINE_STORAGE,JSON.stringify({[item.id]:{reviewedAt:source.generatedAt,observation:{...observe(),proof:'PRIVATE'}}}));expect(readBaselines([item.id])).toEqual({});
  values.set(BASELINE_STORAGE,JSON.stringify({[item.id]:{reviewedAt:source.generatedAt,observation:observe()}}));expect(Object.keys(readBaselines([item.id]))).toEqual([item.id]);pruneBaselines([]);expect(values.has(BASELINE_STORAGE)).toBe(false);
 });
});
