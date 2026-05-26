import { BaseService } from './base-service.js';
import type { FeishuAPI } from '../feishu/api.js';
import type { ApprovalInstance, ApprovalSearchResult } from '../types/extended.js';

export class ApprovalService extends BaseService {
  constructor(api: FeishuAPI) {
    super(api);
  }

  async listInstances(options?: {
    approvalCode?: string;
    status?: 'pending' | 'approved' | 'rejected' | 'transferred' | 'canceled';
    startTime?: string;
    endTime?: string;
    pageSize?: number;
    pageToken?: string;
  }): Promise<ApprovalSearchResult> {
    return this.call('listInstances', async () => {
      const client = this.api.getClient();
      
      const params: Record<string, any> = {
        ...this.buildPagination(options?.pageSize || 100, options?.pageToken),
      };
      if (options?.approvalCode) params.approval_code = options.approvalCode;
      if (options?.status) params.status = options.status;
      if (options?.startTime) params.start_time = options.startTime;
      if (options?.endTime) params.end_time = options.endTime;

      const res: any = await client.request({
        method: 'GET',
        url: '/open-apis/approval/v4/instances',
        params,
      });

      if (res.code !== 0) {
        throw new Error(`Failed to list approval instances: ${res.msg || 'Unknown error'}`);
      }

      const data = res.data || {};
      return {
        instances: (data.items || []).map((inst: any) => this.parseInstance(inst)),
        hasMore: data.has_more || false,
        pageToken: data.page_token,
      };
    });
  }

  async getInstance(instanceId: string): Promise<ApprovalInstance> {
    this.validateRequired(instanceId, 'instanceId');

    return this.call('getInstance', async () => {
      const client = this.api.getClient();
      
      const res: any = await client.request({
        method: 'GET',
        url: `/open-apis/approval/v4/instances/${encodeURIComponent(instanceId)}`,
      });

      if (res.code !== 0) {
        throw new Error(`Failed to get approval instance: ${res.msg || 'Unknown error'}`);
      }

      return this.parseInstance(res.data);
    });
  }

  async approveInstance(
    instanceId: string,
    comment?: string,
  ): Promise<void> {
    this.validateRequired(instanceId, 'instanceId');

    return this.call('approveInstance', async () => {
      const client = this.api.getClient();
      
      const res: any = await client.request({
        method: 'POST',
        url: `/open-apis/approval/v4/instances/${encodeURIComponent(instanceId)}/approve`,
        data: { comment },
      });

      if (res.code !== 0) {
        throw new Error(`Failed to approve instance: ${res.msg || 'Unknown error'}`);
      }
    });
  }

  async rejectInstance(
    instanceId: string,
    comment?: string,
  ): Promise<void> {
    this.validateRequired(instanceId, 'instanceId');

    return this.call('rejectInstance', async () => {
      const client = this.api.getClient();
      
      const res: any = await client.request({
        method: 'POST',
        url: `/open-apis/approval/v4/instances/${encodeURIComponent(instanceId)}/reject`,
        data: { comment },
      });

      if (res.code !== 0) {
        throw new Error(`Failed to reject instance: ${res.msg || 'Unknown error'}`);
      }
    });
  }

  async transferInstance(
    instanceId: string,
    transferTo: string,
    comment?: string,
  ): Promise<void> {
    this.validateRequired(instanceId, 'instanceId');
    this.validateRequired(transferTo, 'transferTo');

    return this.call('transferInstance', async () => {
      const client = this.api.getClient();
      
      const res: any = await client.request({
        method: 'POST',
        url: `/open-apis/approval/v4/instances/${encodeURIComponent(instanceId)}/transfer`,
        data: {
          transfer_to: transferTo,
          comment,
        },
      });

      if (res.code !== 0) {
        throw new Error(`Failed to transfer instance: ${res.msg || 'Unknown error'}`);
      }
    });
  }

  private parseInstance(inst: any): ApprovalInstance {
    if (!inst) throw new Error('Instance data is null');
    
    return {
      instanceId: inst.instance_id,
      approvalCode: inst.approval_code,
      status: inst.status || 'pending',
      createTime: inst.create_time,
      updateTime: inst.update_time,
      requester: inst.requester?.id,
      approvers: (inst.task_list || []).map((node: any) => ({
        nodeId: node.node_id,
        nodeName: node.node_name,
        status: node.status || 'pending',
        approvers: (node.approvers || []).map((app: any) => ({
          openId: app.open_id,
          userId: app.user_id,
          name: app.name,
          status: app.status || 'pending',
          comment: app.comment,
          operateTime: app.operate_time,
        })),
      })),
      formData: inst.form,
    };
  }
}
