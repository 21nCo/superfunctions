import { memoryAdapter } from '@superfunctions/db/adapters/memory';

/** One in-memory database the test and the container's `FILEFN_DATABASE` module share. */
export const sharedDatabase = memoryAdapter();

export const received: Array<Record<string, string | undefined>> = [];

export default function createDatabase(env: Record<string, string | undefined>) {
  received.push(env);
  return sharedDatabase;
}
