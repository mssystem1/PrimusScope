import { describe, expect, it } from 'vitest';
import { CurlRpc, DEFAULT_RPC_LIMITS, numericRetryAfter } from './rpc';
import { parseOptions } from './cli';

describe('bounded transport and CLI inputs',()=>{
  it('accepts only one bounded numeric Retry-After from the final response',()=>{
    expect(numericRetryAfter('HTTP/1.1 200 Connection established\r\nRetry-After: 99\r\n\r\nHTTP/2 429 Too Many Requests\r\nRetry-After: 30\r\n',429)).toBe(30);
    for(const text of ['HTTP/2 429\nRetry-After: tomorrow\n','HTTP/2 429\nRetry-After: 86401\n','HTTP/2 429\nRetry-After: 1\nRetry-After: 2\n','HTTP/2 200\nRetry-After: 1\n'])expect(numericRetryAfter(text,429)).toBeUndefined();
  });
  it('rejects credential-bearing, insecure or malformed endpoints without echoing them',()=>{
    for(const endpoint of ['http://rpc.invalid','https://secret:password@rpc.invalid','https://rpc.invalid/#private','https://rpc.invalid/\nprivate']){
      try{new CurlRpc(endpoint);throw new Error('Expected failure');}catch(error){expect(String(error)).toBe('WorkerError: INVALID_ENDPOINT');}
    }
  });
  it('refuses value-moving methods before creating transport work',async()=>{
    const rpc=new CurlRpc('https://bsc-rpc.publicnode.com');
    await expect(rpc.call('eth_sendRawTransaction',['private-input'])).rejects.toThrow('INVALID_RPC_METHOD');expect(rpc.requestsMade).toBe(0);
  });
  it('enforces request/response/deadline option caps',()=>{
    for(const limits of [{maxRequests:0},{maxRequests:1001},{maxSeconds:601},{maxResponseBytes:5_000_001},{timeoutSeconds:31},{minIntervalMs:-1}])expect(()=>new CurlRpc('https://bsc-rpc.publicnode.com',{...DEFAULT_RPC_LIMITS,...limits})).toThrow('INVALID_LIMITS');
  });
  it('rejects duplicate/unknown flags and noncanonical/unbounded limits',()=>{
    for(const args of [['once','--url','https://private.invalid'],['once','--max-blocks','01'],['once','--max-blocks','10001'],['once','--domain','finance','--domain','network'],['once','--domain','unknown']])expect(()=>parseOptions(args)).toThrow('INVALID_OPTIONS');
    expect(parseOptions(['once','--domain','finance','--max-blocks','100'])).toMatchObject({command:'once',domain:'finance',maxBlocks:100});
  });
});
