import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {runInspection} from './run-inspection';
import {emptyInspectionPolicy} from './sdk-tools';
class FakeWorker{
 static current:FakeWorker;listeners=new Map<string,((event:any)=>void)[]>();postMessage=vi.fn();terminate=vi.fn();
 constructor(public path:string){FakeWorker.current=this;}
 addEventListener(type:string,listener:(event:any)=>void){this.listeners.set(type,[...(this.listeners.get(type)??[]),listener]);}
 emit(type:string,event:any){for(const listener of this.listeners.get(type)??[])listener(event);}
}
beforeEach(()=>vi.stubGlobal('Worker',FakeWorker));afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
it('sends input only after worker readiness and terminates the worker after its bounded response',async()=>{
 const pending=runInspection('LOCAL_PRIVATE_INPUT',emptyInspectionPolicy,new AbortController().signal),worker=FakeWorker.current;
 expect(worker.postMessage).not.toHaveBeenCalled();expect(worker.path).toMatch(/^\/sdk\/primus-page-verifier-[a-f0-9]+\.js$/);
 worker.emit('message',{data:{ready:true}});const id=worker.postMessage.mock.calls[0][0].id;
 const result={outcome:'rejected'};worker.emit('message',{data:{id,result}});expect(await pending).toBe(result);expect(worker.terminate).toHaveBeenCalledOnce();
});
it('terminates and rejects on cancellation without waiting for a stale result',async()=>{
 const abort=new AbortController(),pending=runInspection('LOCAL_PRIVATE_INPUT',emptyInspectionPolicy,abort.signal),worker=FakeWorker.current;
 abort.abort();await expect(pending).rejects.toThrow('CANCELLED');expect(worker.terminate).toHaveBeenCalledOnce();
});
it('bounds worker lifetime even if no response arrives',async()=>{
 vi.useFakeTimers();const pending=runInspection('LOCAL_PRIVATE_INPUT',emptyInspectionPolicy,new AbortController().signal);const rejection=expect(pending).rejects.toThrow('TIMEOUT');
 await vi.advanceTimersByTimeAsync(15000);await rejection;expect(FakeWorker.current.terminate).toHaveBeenCalledOnce();
});
it('suppresses worker errors and returns a fixed code without serializing exception details',async()=>{
 const pending=runInspection('LOCAL_PRIVATE_INPUT',emptyInspectionPolicy,new AbortController().signal),preventDefault=vi.fn();
 FakeWorker.current.emit('error',{message:'DO_NOT_FORWARD_PRIVATE_DETAIL',preventDefault});await expect(pending).rejects.toThrow('SDK_ERROR');expect(preventDefault).toHaveBeenCalledOnce();expect(FakeWorker.current.terminate).toHaveBeenCalledOnce();
});
