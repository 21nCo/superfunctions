import { ElasticsearchAdapter, type ElasticsearchAdapterOptions } from "./elasticsearch";

export type OpenSearchAdapterOptions = Omit<ElasticsearchAdapterOptions, "engine">;

export class OpenSearchAdapter extends ElasticsearchAdapter {
  readonly name = "opensearch";

  constructor(options: OpenSearchAdapterOptions) {
    super({ ...options, engine: "opensearch" });
  }
}

