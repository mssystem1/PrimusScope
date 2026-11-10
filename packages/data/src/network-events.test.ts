import { describe, expect, it } from 'vitest';
import { ObservationSetSchema } from '@primusscope/api-schema';
import recorded from '../../../data/observations/current.json';
import { createRepository } from './index';
import { parseCsv } from '../../../tests/e2e/csv';

const snapshot = ObservationSetSchema.parse(recorded);
const repo = () => createRepository(snapshot);
const coverage = snapshot.network.coverage;

describe('source-scoped Network event research', () => {
  it('combines inclusive bounds, kind and canonical task identity without inferring outcomes', () => {
    const event = snapshot.network.events.find(e => e.kind === 'ReportResult')!;
    const page = repo().getNetworkEvents({ fromBlock: event.blockNumber, toBlock: event.blockNumber,
      eventKind: 'ReportResult', taskId: '0x' + event.taskId!.slice(2).toUpperCase() });
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.selection.taskId).toBe(event.taskId);
    for (const item of page.items) {
      expect(item).toMatchObject({ kind: 'ReportResult', blockNumber: event.blockNumber, taskId: event.taskId });
      expect(Object.keys(item).sort()).toEqual(Object.keys(event).sort());
    }
    expect(repo().getNetworkEvents({ taskId: event.taskId!, eventKind: 'WithdrawBalance' }).total).toBe(0);
  });
  it('rejects reversed, malformed and uncovered selections rather than publishing a false zero', () => {
    for (const options of [{ fromBlock: coverage.toBlock, toBlock: coverage.fromBlock }, { fromBlock: '01' },
      { toBlock: '-1' }, { eventKind: 'SUCCESS' }, { taskId: 'private-input' }, { privateKey: 'secret' }, { limit: 0 }, { limit: 101 }]) {
      expect(() => repo().getNetworkEvents(options as never)).toThrow();
    }
    expect(() => repo().getNetworkEvents({ fromBlock: String(BigInt(coverage.fromBlock)-1n) })).toThrowError(expect.objectContaining({ code:'UNSUPPORTED_SCOPE',status:422 }));
    expect(() => repo().getNetworkEvents({ toBlock: String(BigInt(coverage.toBlock)+1n) })).toThrowError(expect.objectContaining({ code:'UNSUPPORTED_SCOPE' }));
    expect(() => repo().getNetworkEvents({ chainId:56 })).toThrowError(expect.objectContaining({ code:'UNSUPPORTED_SCOPE' }));
  });
  it('preserves block precision above the JavaScript integer limit', () => {
    const input = structuredClone(snapshot), offset = 2n**80n;
    input.network.coverage.fromBlock = String(BigInt(coverage.fromBlock)+offset);
    input.network.coverage.toBlock = String(BigInt(coverage.toBlock)+offset);
    for (const event of input.network.events) event.blockNumber = String(BigInt(event.blockNumber)+offset);
    for (const sample of input.network.stateSamples) sample.asOfBlock = String(BigInt(sample.asOfBlock)+offset);
    const first = input.network.events[0]!;
    const result = createRepository(input).getNetworkEvents({ fromBlock:first.blockNumber,toBlock:first.blockNumber });
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.every(event=>event.blockNumber===first.blockNumber)).toBe(true);
  });
  it('traverses every canonical event once in stable newest-first order', () => {
    const data=repo(), ids:string[]=[], blocks:bigint[]=[]; let cursor:string|null=null;
    do {
      const page=data.getNetworkEvents({limit:17,...(cursor?{cursor}:{})});
      expect(page.pageStart).toBe(ids.length+1); expect(page.pageEnd).toBe(ids.length+page.items.length);
      ids.push(...page.items.map(event=>event.id));blocks.push(...page.items.map(event=>BigInt(event.blockNumber)));
      cursor=page.nextCursor;
    } while(cursor);
    expect(ids).toHaveLength(snapshot.network.events.length); expect(new Set(ids).size).toBe(ids.length);
    expect(blocks).toEqual([...blocks].sort((a,b)=>a>b?-1:a<b?1:0));
    expect(repo().getNetworkEvents({eventKind:'WithdrawBalance'}).items.every(event=>event.taskId===null)).toBe(true);
  });
  it('binds continuation to resource, normalized filters, page size and snapshot', () => {
    const data=repo(), cursor=data.getNetworkEvents({limit:1}).nextCursor!;
    expect(data.getNetworkEvents({limit:1,cursor,fromBlock:coverage.fromBlock,toBlock:coverage.toBlock}).items).toHaveLength(1);
    for (const options of [{limit:2},{limit:1,eventKind:'ReportResult'},{limit:1,fromBlock:coverage.toBlock},
      {limit:1,taskId:snapshot.network.stateSamples[0]!.taskId}]) {
      expect(()=>data.getNetworkEvents({...options,cursor} as never)).toThrowError(expect.objectContaining({code:'INVALID_CURSOR'}));
    }
    const changed=structuredClone(snapshot);changed.snapshotId='a'.repeat(64);
    expect(()=>createRepository(changed).getNetworkEvents({limit:1,cursor})).toThrowError(expect.objectContaining({code:'SNAPSHOT_EXPIRED',status:409}));
    const payload=JSON.parse(Buffer.from(cursor,'base64url').toString());payload.lastId='unknown-position';
    expect(()=>data.getNetworkEvents({limit:1,cursor:Buffer.from(JSON.stringify(payload)).toString('base64url')})).toThrowError(expect.objectContaining({code:'INVALID_CURSOR'}));
  });
  it('exports the exact JSON event order, selection and provenance with a snapshot guard', () => {
    const data=repo(), filters={fromBlock:coverage.fromBlock,toBlock:coverage.toBlock,eventKind:'ReportResult' as const};
    const page=data.getNetworkEvents({...filters,limit:100});
    const [headers,...rows]=parseCsv(data.exportMetricsCsv({domain:'network',...filters,snapshotId:page.snapshotId}));
    const col=(name:string)=>headers.indexOf(name);
    expect(rows.map(row=>row[col('transaction_hash')]+':'+row[col('log_index')])).toEqual(page.items.map(e=>e.transactionHash+':'+e.logIndex));
    for (const row of rows) {
      expect(row[col('selection_from_block')]).toBe(filters.fromBlock);expect(row[col('selection_to_block')]).toBe(filters.toBlock);
      expect(row[col('event_kind_filter')]).toBe('ReportResult');expect(row[col('snapshot_id')]).toBe(page.snapshotId);
      expect(row[col('source_id')]).toBe(coverage.sourceId);expect(row[col('coverage_from_block')]).toBe(coverage.fromBlock);
    }
    expect(()=>data.exportMetricsCsv({domain:'network',snapshotId:'a'.repeat(64)})).toThrowError(expect.objectContaining({code:'SNAPSHOT_EXPIRED'}));
    expect(()=>data.exportMetricsCsv({domain:'finance',...filters})).toThrowError(expect.objectContaining({code:'INVALID_FILTER'}));
    expect(parseCsv(data.exportMetricsCsv({domain:'network',taskId:'0x'+'ff'.repeat(32)}))).toHaveLength(1);
  });
  it('applies the export cap after selection while retaining all unfiltered event identities', () => {
    const input=structuredClone(snapshot), base=input.network.events.find(e=>e.kind==='WithdrawBalance')!;
    for(let i=0;i<5001;i++) input.network.events.push({...base,id:'synthetic-limit-test:'+i,logIndex:String(10000+i),transactionHash:'0x'+BigInt(900000+i).toString(16).padStart(64,'0')});
    const data=createRepository(input);
    expect(()=>data.exportMetricsCsv({domain:'network'})).toThrowError(expect.objectContaining({code:'RANGE_TOO_LARGE'}));
    expect(parseCsv(data.exportMetricsCsv({domain:'network',eventKind:'ReportResult'}))).toHaveLength(91);
  });
});
