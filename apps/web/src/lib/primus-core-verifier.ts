import core from '../../../../vendor/primus-core-0.3.9/verify.cjs';
import {recoverAddress} from '@ethersproject/transactions';
import {CORE_SDK_INFO,type InspectionPolicy} from './sdk-tools';
import {inspectWithEngine} from './inspection-policy';
export function inspectCoreAttestation(raw:string,policy:InspectionPolicy,now=Date.now()){return inspectWithEngine(raw,policy,now,{sdk:CORE_SDK_INFO,verify:core.verifyAttestation,encode:core.encodeAttestation,recover:recoverAddress});}
