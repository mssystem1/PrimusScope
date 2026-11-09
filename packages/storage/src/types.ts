import type { FinanceEvent, NetworkEvent, ObservationSet } from '@primusscope/api-schema';

export type Domain = 'finance' | 'network';
export type Lease = { domain: Domain; token: string; owner: string; expiresAt: string };
export type Checkpoint = {
  domain: Domain; chainId: 56 | 8453; fromBlock: string; toBlock: string; nextBlock: string;
  blockHash: string; toTime: string; observedAt: string; quarantined: boolean; nextRetryAt: string | null;
};
export type CompletedRange = {
  fromBlock: string; toBlock: string; previousBlockHash: string; toBlockHash: string;
  toTime: string; observedAt: string; events: FinanceEvent[] | NetworkEvent[];
};
export type RunOutcome = 'idle' | 'advanced' | 'failed';
export type RunRecord = {
  outcome: RunOutcome; at: string; code?: string;
  targetFinalizedBlock?: string; sourceAsOf?: string;
  retryAfterSeconds?: number;
};
export type DomainStatus = Checkpoint & {
  lastAttemptAt: string | null; lastSuccessAt: string | null; lastOutcome: RunOutcome | null;
  lastErrorCode: string | null; targetFinalizedBlock: string | null; sourceAsOf: string | null;
  lagBlocks: string | null; asObservedAt: string | null;
  retryAfterSeconds: number | null;
};
export type IndexerStatus = {
  storage: 'sqlite'; publication: 'available' | 'quarantined' | 'empty'; snapshotId: string | null;
  domains: DomainStatus[];
};
export type ServingState = { snapshot: ObservationSet; status: IndexerStatus };
