import type {
  Message,
  MessageHandler,
  ConsumerOptions,
  Subscription,
} from "./types.js";
export const copyMessage = (message: Message): Message =>
  ({
    ...structuredClone(
      Object.fromEntries(
        Object.entries(message).filter(
          ([, value]) => typeof value !== "function",
        ),
      ),
    ),
    ack: async () => {},
    nack: async () => {},
  }) as Message;
interface Member {
  id: string;
  handler: MessageHandler<any>;
  options: ConsumerOptions;
  paused: boolean;
  busy: Map<symbol, AbortController>;
  active: boolean;
  commits: Set<ReturnType<typeof setTimeout>>;
}
interface Pending {
  message: Message;
  member: Member;
  token: symbol;
}
interface Group {
  stream: string;
  name: string;
  cursor: number;
  members: Map<string, Member>;
  pending: Map<string, Pending>;
  retry: Message[];
  round: number;
  timer?: ReturnType<typeof setTimeout>;
  dispatching: boolean;
}
export class MemoryConsumerGroups {
  private groups = new Map<string, Group>();
  constructor(private history: (stream: string) => Message[]) {}
  private get(stream: string, name: string, fromBeginning = false): Group {
    const key = JSON.stringify([stream, name]);
    let group = this.groups.get(key);
    if (!group) {
      group = {
        stream,
        name,
        cursor: fromBeginning
          ? -1
          : (this.history(stream).at(-1)?.offset ?? -1),
        members: new Map(),
        pending: new Map(),
        retry: [],
        round: 0,
        dispatching: false,
      };
      this.groups.set(key, group);
    }
    return group;
  }
  create(stream: string, name: string) {
    this.get(stream, name);
  }
  count(stream: string) {
    return [...this.groups.values()].filter((group) => group.stream === stream)
      .length;
  }
  lag(stream: string): number {
    return [...this.groups.values()]
      .filter((group) => group.stream === stream)
      .reduce(
        (sum, group) =>
          sum +
          group.pending.size +
          group.retry.length +
          this.history(stream).filter(
            (message) => (message.offset ?? 0) > group.cursor,
          ).length,
        0,
      );
  }
  notify(stream: string) {
    for (const group of this.groups.values())
      if (group.stream === stream) this.dispatch(group);
  }
  private schedule(group: Group) {
    if (!group.timer)
      group.timer = setTimeout(() => {
        group.timer = undefined;
        this.dispatch(group);
      }, 20);
  }
  private dispatch(group: Group) {
    if (group.dispatching) return;
    group.dispatching = true;
    try {
      for (;;) {
        const members = [...group.members.values()].filter(
          (member) =>
            member.active &&
            !member.paused &&
            new Set([...member.busy.keys(), ...[...group.pending.values()].filter(p => p.member === member).map(p => p.token)]).size < (member.options.maxInFlight ?? 1),
        );
        if (!members.length) return;
        const message =
          group.retry.shift() ??
          this.history(group.stream).find(
            (message) => (message.offset ?? 0) > group.cursor,
          );
        if (!message) return;
        group.cursor = Math.max(group.cursor, message.offset ?? 0);
        const member = members[group.round++ % members.length],
          token = Symbol();
        group.pending.set(message.id, { message, member, token });
        const controller = new AbortController();
        member.busy.set(token, controller);
        const settle = async (requeue: boolean) => {
          if (group.pending.get(message.id)?.token !== token) return;
          group.pending.delete(message.id);
          if (requeue) group.retry.push(message);
          if (requeue) this.schedule(group);
          else this.dispatch(group);
        };
        const delivered = {
          ...copyMessage(message),
          signal: controller.signal,
          ack: () => settle(false),
          nack: (requeue = true) => settle(requeue),
        };
        void Promise.resolve()
          .then(() => { if (controller.signal.aborted) return; return member.handler(delivered); })
          .then(
            async () => {
              if (member.active && member.options.autoCommit !== false) {
                if ((member.options.commitInterval ?? 0) > 0) {
                  const timer = setTimeout(() => {
                    member.commits.delete(timer);
                    void settle(false);
                  }, member.options.commitInterval);
                  member.commits.add(timer);
                } else await settle(false);
              }
            },
            async () => {
              await settle(true);
            },
          )
          .finally(() => {
            member.busy.delete(token);
            if (!member.active) return;
            if (group.retry.length) this.schedule(group);
            else this.dispatch(group);
          });
      }
    } finally {
      group.dispatching = false;
    }
  }
  async subscribe(
    stream: string,
    name: string,
    id: string,
    handler: MessageHandler<any>,
    options: ConsumerOptions,
  ): Promise<Subscription> {
    if (
      !id ||
      !name ||
      !Number.isInteger(options.maxInFlight ?? 1) ||
      (options.maxInFlight ?? 1) < 1
    )
      throw new Error(
        "Consumer requires identity, group and positive maxInFlight",
      );
    if (
      options.commitInterval !== undefined &&
      (!Number.isFinite(options.commitInterval) || options.commitInterval < 0)
    )
      throw new Error("commitInterval must be nonnegative");
    const group = this.get(stream, name, options.fromBeginning);
    if (group.members.has(id))
      throw new Error("Consumer is already subscribed");
    const member: Member = {
      id,
      handler,
      options,
      paused: false,
      busy: new Map(),
      active: true,
      commits: new Set(),
    };
    group.members.set(id, member);
    this.dispatch(group);
    return {
      pause: async () => {
        member.paused = true;
      },
      resume: async () => {
        member.paused = false;
        this.dispatch(group);
      },
      unsubscribe: async () => {
        member.active = false;
        for (const controller of member.busy.values()) controller.abort();
        for (const timer of member.commits) clearTimeout(timer);
        member.commits.clear();
        group.members.delete(id);
        for (const [key, pending] of group.pending)
          if (pending.member === member) {
            group.pending.delete(key);
            group.retry.push(pending.message);
          }
        this.dispatch(group);
      },
    };
  }
  close() {
    for (const group of this.groups.values()) {
      if (group.timer) clearTimeout(group.timer);
      for (const member of group.members.values()) {
        member.active = false;
        for (const controller of member.busy.values()) controller.abort();
        for (const timer of member.commits) clearTimeout(timer);
      }
      group.members.clear();
      group.pending.clear();
      group.retry = [];
    }
    this.groups.clear();
  }
}
