/** Collision-free storage identity for document IDs that are only unique inside a dataset. */
export function documentStorageId(dataset: string, documentId: string): string {
  return `${dataset.length}:${dataset}${documentId}`;
}
