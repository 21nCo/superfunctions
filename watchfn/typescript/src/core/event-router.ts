import EventEmitter from "events";

export class EventRouter extends EventEmitter {
  constructor() {
    super();
  }

  ingest(event: any) {
    this.emit("event", event);
  }
}
