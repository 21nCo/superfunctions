import { SendfnDatabaseAdapter, FindEventParams } from '../database/adapter';
import { CommunicationEvent, CreateEvent } from '../types';

export class EventTracker {
  constructor(private adapter: SendfnDatabaseAdapter) {}

  async recordEvent(data: CreateEvent): Promise<CommunicationEvent> {
    return this.adapter.recordEvent(data);
  }

  async getEvents(
    referenceId: string,
    referenceType: 'email' | 'push' | 'sms'
  ): Promise<CommunicationEvent[]> {
    return this.adapter.getEventsByReference(referenceId, referenceType);
  }

  async queryEvents(params: FindEventParams): Promise<CommunicationEvent[]> {
    return this.adapter.findEvents(params);
  }
}
