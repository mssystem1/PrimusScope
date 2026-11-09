export const knownTask = {
  chainId: 8453,
  contractAddress: "0x151cb5ed5d10a42b607bb172b27bdf6f884b9707",
  taskId:
    "0x6d4d7f398eceeebb821e386856d8a270b63575044deba45c308d40cb8bde2697",
};

export const knownTaskPath = `/network/tasks/${knownTask.chainId}/${knownTask.contractAddress}/${knownTask.taskId}`;

export const knownTransaction =
  "0x1f914ea7d8911df8b8e012fcb9da289819df48bf6ddbe88e66d8a0eec039dd99";

export const absentTaskId = `0x${"ff".repeat(32)}`;

export const knownFinanceBatch = {
  contractAddress: "0xe76f5202ef8eeb462ec784fe51d69e9a8a0b56c1",
  batchId: "146",
};

export const knownFinanceBatchPath = `/finance/batches/${knownFinanceBatch.contractAddress}/${knownFinanceBatch.batchId}`;

export const financeRouteIds = [
  "united-stables-confidential-vault",
  "encrypted-usdt-confidential-vault",
] as const;
