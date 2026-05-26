import { BaseService } from './base-service.js';
import type { FeishuAPI } from '../feishu/api.js';
import type { TaskInfo, TaskSearchResult } from '../types/extended.js';

export class TaskService extends BaseService {
  constructor(api: FeishuAPI) {
    super(api);
  }

  async listTasks(options?: {
    pageSize?: number;
    pageToken?: string;
    completed?: boolean;
  }): Promise<TaskSearchResult> {
    return this.call('listTasks', async () => {
      const client = this.api.getClient();
      
      const params: Record<string, any> = {
        ...this.buildPagination(options?.pageSize || 100, options?.pageToken),
      };

      const res: any = await client.request({
        method: 'GET',
        url: '/open-apis/task/v2/tasks',
        params,
      });

      if (res.code !== 0) {
        throw new Error(`Failed to list tasks: ${res.msg || 'Unknown error'}`);
      }

      const data = res.data || {};
      return {
        tasks: (data.items || []).map((task: any) => this.parseTask(task)),
        hasMore: data.has_more || false,
        pageToken: data.page_token,
      };
    });
  }

  async getTask(taskId: string): Promise<TaskInfo> {
    this.validateRequired(taskId, 'taskId');

    return this.call('getTask', async () => {
      const client = this.api.getClient();
      
      const res: any = await client.request({
        method: 'GET',
        url: `/open-apis/task/v2/tasks/${encodeURIComponent(taskId)}`,
      });

      if (res.code !== 0) {
        throw new Error(`Failed to get task: ${res.msg || 'Unknown error'}`);
      }

      return this.parseTask(res.data);
    });
  }

  async createTask(task: Partial<TaskInfo>): Promise<TaskInfo> {
    this.validateRequired(task.summary || '', 'summary');

    return this.call('createTask', async () => {
      const client = this.api.getClient();
      
      const res: any = await client.request({
        method: 'POST',
        url: '/open-apis/task/v2/tasks',
        data: this.buildTaskPayload(task),
      });

      if (res.code !== 0) {
        throw new Error(`Failed to create task: ${res.msg || 'Unknown error'}`);
      }

      return this.parseTask(res.data);
    });
  }

  async updateTask(taskId: string, task: Partial<TaskInfo>): Promise<TaskInfo> {
    this.validateRequired(taskId, 'taskId');

    return this.call('updateTask', async () => {
      const client = this.api.getClient();
      
      const res: any = await client.request({
        method: 'PATCH',
        url: `/open-apis/task/v2/tasks/${encodeURIComponent(taskId)}`,
        data: this.buildTaskPayload(task),
      });

      if (res.code !== 0) {
        throw new Error(`Failed to update task: ${res.msg || 'Unknown error'}`);
      }

      return this.parseTask(res.data);
    });
  }

  async completeTask(taskId: string): Promise<TaskInfo> {
    this.validateRequired(taskId, 'taskId');

    return this.call('completeTask', async () => {
      return this.updateTask(taskId, { status: 'completed', completedTime: new Date().toISOString() });
    });
  }

  async deleteTask(taskId: string): Promise<void> {
    this.validateRequired(taskId, 'taskId');

    return this.call('deleteTask', async () => {
      const client = this.api.getClient();
      
      const res: any = await client.request({
        method: 'DELETE',
        url: `/open-apis/task/v2/tasks/${encodeURIComponent(taskId)}`,
      });

      if (res.code !== 0) {
        throw new Error(`Failed to delete task: ${res.msg || 'Unknown error'}`);
      }
    });
  }

  private parseTask(task: any): TaskInfo {
    if (!task) throw new Error('Task data is null');
    
    return {
      taskId: task.task_id,
      summary: task.summary || 'Untitled Task',
      description: task.description,
      dueTime: task.due?.timestamp || task.due_time,
      completedTime: task.completed_time,
      status: task.completed ? 'completed' : 'needs_action',
      creator: task.creator?.id,
      assignees: (task.assignees || []).map((a: any) => a.id),
      followers: (task.followers || []).map((f: any) => f.id),
    };
  }

  private buildTaskPayload(task: Partial<TaskInfo>): Record<string, any> {
    const payload: Record<string, any> = {};
    
    if (task.summary) payload.summary = task.summary;
    if (task.description !== undefined) payload.description = task.description;
    if (task.dueTime) payload.due = { timestamp: task.dueTime };
    if (task.assignees?.length) {
      payload.assignees = task.assignees.map(id => ({ id }));
    }
    if (task.followers?.length) {
      payload.followers = task.followers.map(id => ({ id }));
    }
    if (task.status === 'completed') {
      payload.completed = true;
    }
    
    return payload;
  }
}
