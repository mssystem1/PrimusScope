import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, getEventSelector } from 'viem';
import officialAbi from '../../../scripts/discovery/sources/base-task-abi.json';
import networkSource from '../../../scripts/discovery/sources/base-task-source.json';
import firstSource from '../../../docs/discovery/bsc-first-source-observation.json';
import otherSources from '../../../docs/discovery/bsc-other-source-observations.json';
import bscEvidence from '../../../docs/discovery/bsc-rpc-observation.json';
import networkEvidence from '../../../docs/discovery/network-free-rpc-observation.json';
import recorded from '../../../data/observations/current.json';
import { ObservationSetSchema } from '@primusscope/api-schema';
import { FINANCE_ABI, NETWORK_ABI, UPGRADED_TOPIC, codeHash, projectLog, registeredEndpoint, sourceFor } from './registry';

const snapshot=ObservationSetSchema.parse(recorded);
const hash='0x'+'1'.repeat(64);
describe('reviewed event schemas and publication projection',()=>{
  it('Network signatures/indexing match the pinned selected official SDK ABI',()=>{
    const upstream=officialAbi.filter(entry=>entry.type==='event');
    expect(upstream).toHaveLength(NETWORK_ABI.length);
    for(const event of NETWORK_ABI){
      const official=upstream.find(entry=>entry.name===event.name)!;
      expect(event.inputs.map(input=>({type:input.type,indexed:input.indexed}))).toEqual(official.inputs.map(input=>({type:input.type,indexed:'indexed'in input?input.indexed:false})));
      expect(getEventSelector(event)).toBe(networkSource.events.find(item=>item.name===event.name)!.topic0);
    }
  });
  it('Finance event topics/static layouts agree with every explorer-matched implementation',()=>{
    const descriptors=[firstSource.matchedCandidateEvents,...otherSources.contracts.map(contract=>contract.matchedEvents)];
    for(const events of descriptors)for(const event of FINANCE_ABI){
      const observed=events.find(item=>item.name===event.name)!;
      expect(observed.topic0).toBe(getEventSelector(event));expect(observed.topicCount).toBe(2);
      expect(observed.batchIdLocation).toEqual({kind:'topic',index:1});
      expect(observed.dataWords).toBe(event.inputs.filter(input=>!input.indexed).length);
    }
  });
  it('runtime/implementation pins match retained observations on both chains',()=>{
    expect(sourceFor('finance',snapshot).seedHash).toBe(bscEvidence.requestedRange.targetHash);
    expect(sourceFor('finance',snapshot).seedBlock).toBe(String(bscEvidence.requestedRange.toBlock));
    expect(sourceFor('network',snapshot).seedHash).toBe(networkEvidence.providerReportedFinalized.hash);
    expect(sourceFor('network',snapshot).seedBlock).toBe(String(networkEvidence.providerReportedFinalized.number));
    for(const pin of sourceFor('finance',snapshot).contracts){
      const observed=bscEvidence.contractChecks.find(item=>item.address===pin.address)!;
      expect(pin).toEqual({address:observed.address,implementation:observed.observedImplementation,proxyCodeSha256:observed.runtimeCodeSha256,implementationCodeSha256:observed.implementationCodeSha256});
    }
    const pin=sourceFor('network',snapshot).contracts[0]!;
    expect(pin.implementation).toBe(networkEvidence.eip1967SlotObservation.candidateImplementation);
    expect(pin.proxyCodeSha256).toBe(networkEvidence.runtimeCode.sha256);
    expect(pin.implementationCodeSha256).toBe(networkEvidence.eip1967SlotObservation.codeSha256);
    expect(sourceFor('network',snapshot).compatibility).toContain('independent source match not established');
  });
  it('retains only task identity, never dynamic template/participant/fee fields',()=>{
    const source=sourceFor('network',snapshot);const taskId='0x'+'2'.repeat(64)as `0x${string}`;
    const topics=encodeEventTopics({abi:NETWORK_ABI,eventName:'SubmitTask',args:{submitter:'0x1111111111111111111111111111111111111111'}});
    const data=encodeAbiParameters([{type:'bytes32'},{type:'string'},{type:'address[]'},{type:'uint64'}],[taskId,'private-template-do-not-retain',['0x3333333333333333333333333333333333333333'],123n]);
    const result=projectLog({address:source.contracts[0]!.address,topics,data,blockNumber:'0xb',blockHash:hash,transactionHash:hash,logIndex:'0x0',removed:false},source,11n,11n).event;
    expect(result).toMatchObject({kind:'SubmitTask',taskId,timestamp:null});
    const serialized=JSON.stringify(result);expect(serialized).not.toContain('private-template');expect(serialized).not.toContain('3333333333333333333333333333333333333333');
    expect(serialized).not.toContain('submitter');expect(serialized).not.toContain('attestors');
  });
  it('runtime code hashing uses decoded bytes',()=>{expect(codeHash('0x60')).not.toBe(codeHash('0x3630'));});
  it('recognized upgrade logs quarantine before normal decoding',()=>{
    const source=sourceFor('network',snapshot);
    expect(()=>projectLog({address:source.contracts[0]!.address,topics:[UPGRADED_TOPIC],data:'0x',blockNumber:'0xb',blockHash:hash,transactionHash:hash,logIndex:'0x0',removed:false},source,11n,11n)).toThrow('IMPLEMENTATION_UPGRADE_IN_RANGE');
  });
  it.each([['AggregateFinalized',2n**64n],['StepAdvanced',256n],['Recovered',2n]]as const)('rejects noncanonical %s integer words', (name,word)=>{
    const source=sourceFor('finance',snapshot);const event=FINANCE_ABI.find(event=>event.name===name)!;
    expect(()=>projectLog({address:source.contracts[0]!.address,topics:[getEventSelector(event),'0x'+'0'.repeat(63)+'1'],data:'0x'+word.toString(16).padStart(64,'0'),blockNumber:'0xb',blockHash:hash,transactionHash:hash,logIndex:'0x0',removed:false},source,11n,11n)).toThrow('EVENT_DECODE_FAILED');
  });
  it('refuses unregistered provider overrides to preserve truthful provenance',()=>{
    const endpoint=sourceFor('finance',snapshot).endpoint;expect(registeredEndpoint('finance',snapshot)).toBe(endpoint);expect(registeredEndpoint('finance',snapshot,endpoint)).toBe(endpoint);
    for(const override of ['https://another-public-provider.invalid',endpoint+'/',endpoint+'?apikey=private'])expect(()=>registeredEndpoint('finance',snapshot,override)).toThrow('UNREGISTERED_RPC_SOURCE');
  });
});
