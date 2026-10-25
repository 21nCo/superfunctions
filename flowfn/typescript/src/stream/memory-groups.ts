import { DeliveryLease } from "./delivery-lease.js";
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
  message: Pick<Message, "id" | "partition" | "offset">;
  member: Member;
  token: symbol;
  deadline?: number;
  expiry?: ReturnType<typeof setTimeout>;
  lease?: DeliveryLease;
}
interface Group {
  stream: string;
  name: string;
  cursor: number;
  partitions: Map<number, number>;
  members: Map<string, Member>;
  pending: Map<string, Pending>;
  retry: string[];
  round: number;
  timer?: ReturnType<typeof setTimeout>;
  dispatching: boolean;
}
export class MemoryConsumerGroups {
  private groups = new Map<string, Group>();
  constructor(private history: (stream: string) => Message[], private partitionCount: (stream: string) => number | undefined = () => undefined) {}
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
        partitions: new Map(),
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
          [...group.pending.values()].filter(p => this.history(stream).some(m => m.id === p.message.id)).length +
          group.retry.length +
          this.history(stream).filter(
            (message) => (message.offset ?? 0) > this.cursor(group, message),
          ).length,
        0,
      );
  }
  private cursor(group: Group, message: Message): number {
    return this.partitionCount(group.stream) === undefined ? group.cursor : group.partitions.get(message.partition!) ?? group.cursor;
  }
  private clearPending(pending: Pending): void {
    if (pending.expiry) clearTimeout(pending.expiry);
    pending.lease?.stop();
  }
  trim(stream: string): void {
    const retained = new Set(this.history(stream).map(m => m.id));
    for (const group of this.groups.values()) if (group.stream === stream) {
      group.retry = group.retry.filter(id => retained.has(id));
    }
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
        const partitioned = this.partitionCount(group.stream) !== undefined;
        const available = (message: Message) => !partitioned || ![...group.pending.values()].some(p => p.message.partition === message.partition);
        const history = this.history(group.stream);
        const retryIndex = group.retry.findIndex(id => { const m = history.find(m => m.id === id); return m !== undefined && available(m); });
        const retryId = retryIndex >= 0 ? group.retry.splice(retryIndex, 1)[0] : undefined;
        const message = retryId !== undefined ? history.find(m => m.id === retryId) :
          history.find(message => (message.offset ?? 0) > this.cursor(group, message) && available(message));
        if (!message) return;
        if (partitioned) group.partitions.set(message.partition!, Math.max(this.cursor(group, message), message.offset ?? 0));
        else group.cursor = Math.max(group.cursor, message.offset ?? 0);
        const member = members[group.round++ % members.length], token = Symbol();
        const pending: Pending = { message: { id: message.id, partition: message.partition, offset: message.offset }, member, token };
        group.pending.set(message.id, pending);
        const duration = member.options.visibilityTimeout ?? 30000;
        const arm = () => {
          if (pending.expiry) clearTimeout(pending.expiry);
          pending.deadline = performance.now() + duration;
          pending.expiry = setTimeout(() => {
            if (group.pending.get(message.id)?.token !== token) return;
            group.pending.delete(message.id);
            pending.lease?.abort();
            if (this.history(group.stream).some(m => m.id === message.id)) group.retry.push(message.id);
            this.dispatch(group);
          }, duration);
        };
        arm();
        pending.lease = new DeliveryLease(duration, performance.now(), async () => {
          if (group.pending.get(message.id)?.token !== token || performance.now() >= pending.deadline! || !this.history(group.stream).some(m => m.id === message.id)) return false;
          arm(); return true;
        }, () => {});
        const controller = pending.lease.controller;
        member.busy.set(token, controller);
        const settle = async (requeue: boolean) => {
          if (group.pending.get(message.id)?.token !== token) return;
          if (pending.deadline !== undefined && performance.now() >= pending.deadline) return;
          group.pending.delete(message.id);
          this.clearPending(pending);
          if (requeue && this.history(group.stream).some(m => m.id === message.id)) group.retry.push(message.id);
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
            pending.lease?.stop();
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
    if (options.visibilityTimeout !== undefined && (!Number.isFinite(options.visibilityTimeout) || options.visibilityTimeout <= 0))
      throw new Error("visibilityTimeout must be positive");
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
            pending.lease?.abort();
            this.clearPending(pending);
            if (this.history(group.stream).some(m => m.id === pending.message.id)) group.retry.push(pending.message.id);
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
      for (const pending of group.pending.values()) { pending.lease?.abort(); this.clearPending(pending); }
      group.pending.clear();
      group.retry = [];
    }
    this.groups.clear();
  }
}
