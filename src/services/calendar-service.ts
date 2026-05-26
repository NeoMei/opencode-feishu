import { BaseService } from './base-service.js';
import type { FeishuAPI } from '../feishu/api.js';
import type { 
  CalendarInfo, 
  CalendarEvent, 
  CalendarSearchResult, 
  EventSearchResult,
  FreeBusyResult 
} from '../types/extended.js';

export class CalendarService extends BaseService {
  constructor(api: FeishuAPI) {
    super(api);
  }

  async listCalendars(options?: {
    pageSize?: number;
    pageToken?: string;
  }): Promise<CalendarSearchResult> {
    return this.call('listCalendars', async () => {
      const client = this.api.getClient();
      
      const res: any = await client.request({
        method: 'GET',
        url: '/open-apis/calendar/v4/calendars',
        params: this.buildPagination(options?.pageSize || 100, options?.pageToken),
      });

      if (res.code !== 0) {
        throw new Error(`Failed to list calendars: ${res.msg || 'Unknown error'}`);
      }

      const data = res.data || {};
      return {
        calendars: (data.calendars || []).map((cal: any) => ({
          calendarId: cal.calendar?.calendar_id || cal.calendar_id,
          name: cal.calendar?.name || cal.name || 'Untitled',
          description: cal.calendar?.description || cal.description,
          isPrimary: cal.calendar?.is_primary || cal.is_primary,
          isPublic: cal.calendar?.is_public || cal.is_public,
        })),
        hasMore: data.has_more || false,
        pageToken: data.page_token,
      };
    });
  }

  async getPrimaryCalendar(): Promise<CalendarInfo> {
    return this.call('getPrimaryCalendar', async () => {
      const client = this.api.getClient();
      
      const res: any = await client.request({
        method: 'GET',
        url: '/open-apis/calendar/v4/calendars/primary',
      });

      if (res.code !== 0) {
        throw new Error(`Failed to get primary calendar: ${res.msg || 'Unknown error'}`);
      }

      const cal = res.data || {};
      return {
        calendarId: cal.calendar_id,
        name: cal.name || 'Primary Calendar',
        description: cal.description,
        isPrimary: true,
        isPublic: cal.is_public,
      };
    });
  }

  async listEvents(
    calendarId: string,
    options?: {
      startTime?: string;
      endTime?: string;
      pageSize?: number;
      pageToken?: string;
    },
  ): Promise<EventSearchResult> {
    this.validateRequired(calendarId, 'calendarId');

    return this.call('listEvents', async () => {
      const client = this.api.getClient();
      
      const params: Record<string, any> = {
        ...this.buildPagination(options?.pageSize || 500, options?.pageToken),
      };
      if (options?.startTime) params.start_time = options.startTime;
      if (options?.endTime) params.end_time = options.endTime;

      const res: any = await client.request({
        method: 'GET',
        url: `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events`,
        params,
      });

      if (res.code !== 0) {
        throw new Error(`Failed to list events: ${res.msg || 'Unknown error'}`);
      }

      const data = res.data || {};
      return {
        events: (data.items || []).map((evt: any) => this.parseEvent(evt)),
        hasMore: data.has_more || false,
        pageToken: data.page_token,
      };
    });
  }

  async getEvent(calendarId: string, eventId: string): Promise<CalendarEvent> {
    this.validateRequired(calendarId, 'calendarId');
    this.validateRequired(eventId, 'eventId');

    return this.call('getEvent', async () => {
      const client = this.api.getClient();
      
      const res: any = await client.request({
        method: 'GET',
        url: `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      });

      if (res.code !== 0) {
        throw new Error(`Failed to get event: ${res.msg || 'Unknown error'}`);
      }

      return this.parseEvent(res.data);
    });
  }

  async createEvent(
    calendarId: string,
    event: Partial<CalendarEvent>,
  ): Promise<CalendarEvent> {
    this.validateRequired(calendarId, 'calendarId');
    this.validateRequired(event.summary || '', 'summary');

    return this.call('createEvent', async () => {
      const client = this.api.getClient();
      
      const res: any = await client.request({
        method: 'POST',
        url: `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events`,
        data: this.buildEventPayload(event),
      });

      if (res.code !== 0) {
        throw new Error(`Failed to create event: ${res.msg || 'Unknown error'}`);
      }

      return this.parseEvent(res.data);
    });
  }

  async updateEvent(
    calendarId: string,
    eventId: string,
    event: Partial<CalendarEvent>,
  ): Promise<CalendarEvent> {
    this.validateRequired(calendarId, 'calendarId');
    this.validateRequired(eventId, 'eventId');

    return this.call('updateEvent', async () => {
      const client = this.api.getClient();
      
      const res: any = await client.request({
        method: 'PATCH',
        url: `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        data: this.buildEventPayload(event),
      });

      if (res.code !== 0) {
        throw new Error(`Failed to update event: ${res.msg || 'Unknown error'}`);
      }

      return this.parseEvent(res.data);
    });
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    this.validateRequired(calendarId, 'calendarId');
    this.validateRequired(eventId, 'eventId');

    return this.call('deleteEvent', async () => {
      const client = this.api.getClient();
      
      const res: any = await client.request({
        method: 'DELETE',
        url: `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      });

      if (res.code !== 0) {
        throw new Error(`Failed to delete event: ${res.msg || 'Unknown error'}`);
      }
    });
  }

  async queryFreeBusy(
    openIds: string[],
    startTime: string,
    endTime: string,
  ): Promise<FreeBusyResult[]> {
    if (!openIds?.length) throw new Error('openIds is required');
    this.validateRequired(startTime, 'startTime');
    this.validateRequired(endTime, 'endTime');

    return this.call('queryFreeBusy', async () => {
      const client = this.api.getClient();
      
      const res: any = await client.request({
        method: 'POST',
        url: '/open-apis/calendar/v4/freebusy/list',
        data: {
          user_id_type: 'open_id',
          user_ids: openIds,
          start_time: startTime,
          end_time: endTime,
        },
      });

      if (res.code !== 0) {
        throw new Error(`Failed to query freebusy: ${res.msg || 'Unknown error'}`);
      }

      const data = res.data || {};
      return (data.freebusy_list || []).map((item: any) => ({
        openId: item.user_id,
        busyTimes: (item.freebusy || []).map((fb: any) => ({
          start: fb.start_time,
          end: fb.end_time,
        })),
      }));
    });
  }

  private parseEvent(evt: any): CalendarEvent {
    if (!evt) throw new Error('Event data is null');
    
    return {
      eventId: evt.event_id,
      summary: evt.summary || 'Untitled Event',
      description: evt.description,
      startTime: evt.start_time?.timestamp || evt.start_time,
      endTime: evt.end_time?.timestamp || evt.end_time,
      location: evt.location?.name || evt.location,
      attendees: (evt.attendees || []).map((att: any) => ({
        openId: att.user_id,
        userId: att.user_id,
        email: att.email,
        displayName: att.display_name,
        responseStatus: att.response_status,
        isOptional: att.is_optional,
        isResource: att.is_resource,
      })),
      recurrence: evt.recurrence,
      status: evt.status,
    };
  }

  private buildEventPayload(event: Partial<CalendarEvent>): Record<string, any> {
    const payload: Record<string, any> = {};
    
    if (event.summary) payload.summary = event.summary;
    if (event.description) payload.description = event.description;
    if (event.startTime) {
      payload.start_time = { timestamp: event.startTime };
    }
    if (event.endTime) {
      payload.end_time = { timestamp: event.endTime };
    }
    if (event.location) {
      payload.location = { name: event.location };
    }
    if (event.attendees?.length) {
      payload.attendees = event.attendees.map(att => ({
        user_id: att.openId || att.userId,
        email: att.email,
        is_optional: att.isOptional,
      }));
    }
    if (event.recurrence) {
      payload.recurrence = event.recurrence;
    }
    
    return payload;
  }
}
