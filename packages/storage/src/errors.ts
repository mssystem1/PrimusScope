export class StorageError extends Error {
  constructor(public readonly code: string, message = 'The indexed observation store is unavailable.') {
    super(message);
    this.name = 'StorageError';
  }
}
