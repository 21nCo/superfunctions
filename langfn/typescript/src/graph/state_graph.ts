export const END = "__end__";

export type NodeFn<TState> = (state: TState) => Promise<TState>;
export type RouteFn<TState> = (state: TState) => string;

export class CompiledGraph<TState> {
  constructor(
    private readonly config: {
      initialState: TState;
      nodes: Map<string, NodeFn<TState>>;
      edges: Map<string, string>;
      conditionalEdges: Map<string, RouteFn<TState>>;
      entrypoint: string;
    }
  ) {}

  async invoke(state?: Partial<TState>, options: { maxSteps?: number } = {}): Promise<TState> {
    const maxSteps = options.maxSteps ?? 100;
    let currentState: TState = { ...this.config.initialState, ...state };
    let currentNode = this.config.entrypoint;

    for (let i = 0; i < maxSteps; i++) {
      const fn = this.config.nodes.get(currentNode);
      if (!fn) throw new Error(`Unknown node: ${currentNode}`);

      currentState = await fn(currentState);

      const router = this.config.conditionalEdges.get(currentNode);
      if (router) {
        const nextNode = router(currentState);
        if (nextNode === END) return currentState;
        currentNode = nextNode;
        continue;
      }

      const nextNode = this.config.edges.get(currentNode);
      if (!nextNode || nextNode === END) return currentState;
      currentNode = nextNode;
    }

    throw new Error("Graph exceeded max steps");
  }
}

export class StateGraph<TState> {
  private nodes = new Map<string, NodeFn<TState>>();
  private edges = new Map<string, string>();
  private conditionalEdges = new Map<string, RouteFn<TState>>();
  private entrypoint?: string;

  constructor(private readonly initialState: TState) {}

  addNode(name: string, fn: NodeFn<TState>): this {
    this.nodes.set(name, fn);
    return this;
  }

  addEdge(from: string, to: string): this {
    this.edges.set(from, to);
    return this;
  }

  addConditionalEdge(from: string, router: RouteFn<TState>): this {
    this.conditionalEdges.set(from, router);
    return this;
  }

  setEntryPoint(name: string): this {
    this.entrypoint = name;
    return this;
  }

  compile(): CompiledGraph<TState> {
    if (!this.entrypoint) throw new Error("Entrypoint not set");
    return new CompiledGraph({
      initialState: this.initialState,
      nodes: this.nodes,
      edges: this.edges,
      conditionalEdges: this.conditionalEdges,
      entrypoint: this.entrypoint
    });
  }
}
