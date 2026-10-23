export interface StorageAdapter {
  add(event: any): Promise<void> | void;
  query(filter: (event: any) => boolean): Promise<any[]> | any[];
  getAll?(): Promise<any[]> | any[];
  clear?(): Promise<void> | void;
}
