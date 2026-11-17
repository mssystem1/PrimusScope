"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isValidNumericString = isValidNumericString;
exports.isValidLetterString = isValidLetterString;
exports.isValidNumberString = isValidNumberString;
exports.isValidTimestampString = isValidTimestampString;
exports.getInstanceProperties = getInstanceProperties;
exports.encodeAttestation = encodeAttestation;
exports.encodeRequest = encodeRequest;
exports.encodeResponse = encodeResponse;
exports.sendRequest = sendRequest;
const { ethers } = require("ethers");
function isValidNumericString(value) {
    const regex = /^[0-9]*$/;
    return typeof value === 'string' && regex.test(value);
}
function isValidLetterString(value) {
    const regex = /^[A-Za-z]+$/;
    return typeof value === 'string' && regex.test(value);
}
function isValidNumberString(value) {
    const regex = /^(0\.(0*[1-9]\d{0,5})|[1-9]\d*(\.\d{1,6})?)$/;
    return typeof value === 'string' && regex.test(value);
}
function isValidTimestampString(value) {
    // Check if the value is of string type  
    if (typeof value !== 'string') {
        return false;
    }
    // Attempt to parse the string into a number  
    const timestamp = Number(value);
    // Check if the parsed number is finite (not NaN or Infinity)  
    if (!Number.isFinite(timestamp)) {
        return false;
    }
    // Check if the number is within a reasonable timestamp range (optional but recommended)  
    // JavaScript timestamps are typically milliseconds since 1970-01-01T00:00:00.000Z  
    // Minimum value is -62135596800000 (milliseconds since 1601-01-01T00:00:00.000Z, but many environments do not support such early times)  
    // Maximum value is Number.MAX_SAFE_INTEGER (2^53 - 1, approximately 9007199254740991 milliseconds, corresponding to the year 275760)  
    // Note: JavaScript Date objects can handle timestamps beyond this range, but may lose precision  
    const MIN_TIMESTAMP = -62135596800000; // Can be adjusted as needed  
    const MAX_TIMESTAMP = Number.MAX_SAFE_INTEGER;
    return timestamp >= MIN_TIMESTAMP && timestamp <= MAX_TIMESTAMP;
}
function getInstanceProperties(instance) {
    const properties = {};
    Object.keys(instance).forEach(key => {
        // Only copy the attributes, not the methods
        if (typeof instance[key] !== 'function') {
            properties[key] = instance[key];
        }
    });
    return properties;
}
function encodeAttestation(att) {
    const encodedData = ethers.utils.solidityPack(["address", "bytes32", "bytes32", "string", "string", "uint64", "string"], [att.recipient, encodeRequest(att.request), encodeResponse(att.reponseResolve),
        att.data, att.attConditions, att.timestamp, att.additionParams]);
    return ethers.utils.keccak256(encodedData);
}
function encodeRequest(request) {
    const encodedData = ethers.utils.solidityPack(["string", "string", "string", "string"], [request.url, request.header, request.method, request.body]);
    return ethers.utils.keccak256(encodedData);
}
function encodeResponse(reponse) {
    let encodeData = "0x";
    for (let i = 0; i < reponse.length; i++) {
        encodeData = ethers.utils.solidityPack(["bytes", "string", "string", "string"], [encodeData, reponse[i].keyName, reponse[i].parseType, reponse[i].parsePath]);
    }
    return ethers.utils.keccak256(encodeData);
}
async function sendRequest(url, options) {
    try {
        const response = await fetch(url, options);
        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }
        return await response.json();
    }
    catch (error) {
        console.error('Request failed:', error);
        throw error;
    }
}
//# sourceMappingURL=utils.js.map