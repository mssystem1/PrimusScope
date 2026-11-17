// Verification-only extraction; the method block below is unchanged upstream SDK source.
const ethers_1=require('ethers');
const utils_1=require('./utils.cjs');
const env_1=require('./env.cjs');
class PrimusCoreTLSVerificationOnly {
    verifyAttestation(attestation) {
        const encodeData = (0, utils_1.encodeAttestation)(attestation);
        const signature = attestation.signatures[0];
        const result = ethers_1.ethers.utils.recoverAddress(encodeData, signature);
        const verifyResult = env_1.PADO_ADDRESS.toLowerCase() === result.toLowerCase();
        return verifyResult;
    }
}
exports.verifyAttestation=(attestation)=>PrimusCoreTLSVerificationOnly.prototype.verifyAttestation(attestation);
exports.encodeAttestation=utils_1.encodeAttestation;
exports.PADO_ADDRESS=env_1.PADO_ADDRESS;
