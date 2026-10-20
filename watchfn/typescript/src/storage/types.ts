export interface StorageAdapter {
  add(event: any): Promise<void> | void;
  query(filter: (event: any) => boolean): Promise<any[]> | any[];
  /** Raw candidates in storage order; no semantic limit or aggregation. */
  iterateQuery?(options: any): AsyncIterable<any>;
  getAll?(): Promise<any[]> | any[];
  clear?(): Promise<void> | void;
}
