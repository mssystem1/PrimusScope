import { createHash } from 'node:crypto';
import { DecimalStringSchema, FinanceEventSchema, IsoTimestampSchema, SourceSchema, type FinanceEvent } from '@primusscope/api-schema';
import { MAX_BLOB_PUBLICATION_BYTES, validatePublication, type HostedPublication } from '@primusscope/storage/publication';
import { WorkerError } from './registry';

export type FinanceHistory = {
  fromBlock: string;
  fromTime: string;
  toBlock: string;
  toTime: string;
  complete: true;
  events: FinanceEvent[];
  source: { id: string; label: string; kind: 'rpc'; url: string };
};

function eventIdentity(event: FinanceEvent) {
  return [event.contractAddress.toLowerCase(), event.transactionHash.toLowerCase(), event.logIndex].join(':');
}

function agrees(first: FinanceEvent, second: FinanceEvent) {
  return first.blockNumber === second.blockNumber && first.blockHash.toLowerCase() === second.blockHash.toLowerCase()
    && first.timestamp === second.timestamp && first.kind === second.kind && first.batchId === second.batchId;
}

export function prependFinanceHistory(current: HostedPublication, history: FinanceHistory, now: string): HostedPublication {
  const { snapshot } = current;
  const { finance } = snapshot;
  const { coverage } = finance;
  if (history.complete !== true || !coverage.completeForRegisteredContracts
    || !DecimalStringSchema.safeParse(history.fromBlock).success || !DecimalStringSchema.safeParse(history.toBlock).success
    || !IsoTimestampSchema.safeParse(history.fromTime).success || !IsoTimestampSchema.safeParse(history.toTime).success
    || coverage.fromTime === null) throw new WorkerError('INVALID_FINANCE_HISTORY');
  const from = BigInt(history.fromBlock), to = BigInt(history.toBlock);
  const currentFrom = BigInt(coverage.fromBlock), currentTo = BigInt(coverage.toBlock);
  const fromTime = Date.parse(history.fromTime), toTime = Date.parse(history.toTime);
  const currentFromTime = Date.parse(coverage.fromTime), currentToTime = Date.parse(coverage.toTime);
  if (from >= currentFrom || to < currentFrom || to > currentTo
    || fromTime > currentFromTime || toTime < currentFromTime || toTime > currentToTime
    || (to === currentFrom && toTime !== currentFromTime)
    || (to === currentTo && toTime !== currentToTime)) throw new WorkerError('FINANCE_HISTORY_BOUNDARY_MISMATCH');

  const source = SourceSchema.safeParse(history.source);
  if (!source.success || source.data.kind !== 'rpc') throw new WorkerError('INVALID_FINANCE_HISTORY_SOURCE');
  const registered = snapshot.sources.find(entry => entry.id === source.data.id);
  if (registered && (registered.kind !== source.data.kind || registered.label !== source.data.label || registered.url !== source.data.url)) {
    throw new WorkerError('FINANCE_HISTORY_SOURCE_COLLISION');
  }

  const contracts = new Set(coverage.contractAddresses.map(address => address.toLowerCase()));
  const events = new Map(finance.events.map(event => [eventIdentity(event), event]));
  const unmatchedOverlap = new Set(finance.events.filter(event => BigInt(event.blockNumber) <= to).map(eventIdentity));
  const additions: FinanceEvent[] = [];
  for (const input of history.events) {
    const parsed = FinanceEventSchema.safeParse(input);
    if (!parsed.success || parsed.data.timestamp === null || parsed.data.sourceId !== source.data.id
      || !contracts.has(parsed.data.contractAddress.toLowerCase())) throw new WorkerError('INVALID_FINANCE_HISTORY_EVENT');
    const event = parsed.data, block = BigInt(event.blockNumber), timestamp = Date.parse(event.timestamp!);
    if (block < from || block > to || timestamp < fromTime || timestamp > toTime
      || (block === from && timestamp !== fromTime) || (block === to && timestamp !== toTime)
      || (block < currentFrom && timestamp > currentFromTime) || (block >= currentFrom && timestamp < currentFromTime)
      || (block === currentFrom && timestamp !== currentFromTime)) throw new WorkerError('INVALID_FINANCE_HISTORY_EVENT');
    const identity = eventIdentity(event), previous = events.get(identity);
    if (previous) {
      if (!agrees(previous, event)) throw new WorkerError('FINANCE_HISTORY_EVENT_CONFLICT');
      unmatchedOverlap.delete(identity);
      continue;
    }
    if (block >= currentFrom) throw new WorkerError('FINANCE_HISTORY_OVERLAP_MISMATCH');
    events.set(identity, event);
    additions.push(event);
  }
  if (unmatchedOverlap.size > 0) throw new WorkerError('FINANCE_HISTORY_OVERLAP_MISMATCH');
  additions.sort((first, second) => first.blockNumber === second.blockNumber
    ? Number(BigInt(first.logIndex) - BigInt(second.logIndex))
    : Number(BigInt(first.blockNumber) - BigInt(second.blockNumber)));
  const newCoverage = { ...coverage, fromBlock: history.fromBlock, fromTime: history.fromTime };
  if (source.data.id !== coverage.sourceId && !coverage.additionalSourceIds?.includes(source.data.id)) {
    newCoverage.additionalSourceIds = [...(coverage.additionalSourceIds ?? []), source.data.id];
  }

  const { snapshotId: _previousId, ...body } = {
    ...snapshot,
    generatedAt: now,
    finance: {
      ...finance,
      coverage: newCoverage,
      events: [...additions, ...finance.events],
    },
    sources: registered ? snapshot.sources : [...snapshot.sources, source.data],
  };
  return validatePublication({
    ...current,
    snapshot: { ...body, snapshotId: createHash('sha256').update(JSON.stringify(body)).digest('hex') },
    checkpoints: current.checkpoints.map(checkpoint => checkpoint.domain === 'finance'
      ? { ...checkpoint, fromBlock: history.fromBlock } : checkpoint),
  }, MAX_BLOB_PUBLICATION_BYTES);
}
