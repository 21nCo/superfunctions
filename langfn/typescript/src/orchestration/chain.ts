export type Step<TIn, TOut> = (input: TIn) => Promise<TOut>;

export class Chain<TIn, TOut> {
  constructor(private readonly _run: (input: TIn) => Promise<TOut>) {}

  async run(input: TIn): Promise<TOut> {
    return this._run(input);
  }

  static sequential<T = any>(steps: Step<any, any>[]): Chain<any, any> {
    return new Chain(async (input: any) => {
      let current = input;
      for (const step of steps) {
        current = await step(current);
      }
      return current;
    });
  }

  static parallel<T = any>(steps: Step<T, any>[]): Chain<T, any[]> {
    return new Chain(async (input: T) => {
      return Promise.all(steps.map(step => step(input)));
    });
  }

  static mapReduce<T = any, TMap = any, TReduce = any>(options: {
    map: (input: T) => Promise<TMap>;
    reduce: (inputs: TMap[]) => Promise<TReduce>;
  }): Chain<T[], TReduce> {
    return new Chain(async (inputs: T[]) => {
      const mapped = await Promise.all(inputs.map(options.map));
      return options.reduce(mapped);
    });
  }
}
