import {PrimusPageCoreTLS} from '@primuslabs/zktls-page-core-sdk';
import {encodeAttestation} from '@primuslabs/zktls-page-core-sdk/dist/utils';
import {utils} from 'ethers';
import {SDK_INFO,type SDKProfile,type InspectionPolicy} from './sdk-tools';
import {inspectWithEngine} from './inspection-policy';
import {inspectCoreAttestation} from './primus-core-verifier';
export function inspectAttestation(raw:string,policy:InspectionPolicy,now=Date.now(),profile:SDKProfile='page'){
 if(profile==='core')return inspectCoreAttestation(raw,policy,now);
 return inspectWithEngine(raw,policy,now,{sdk:SDK_INFO,verify:att=>PrimusPageCoreTLS.prototype.verifyAttestation(att),encode:encodeAttestation,recover:utils.recoverAddress});
}
