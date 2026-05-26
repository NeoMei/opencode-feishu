/**
 * Extended types for Feishu services
 * Based on lark-cli shortcuts analysis
 */

// ── Document Types ──

export interface DocumentInfo {
  documentId: string;
  title: string;
  url?: string;
  type: 'doc' | 'docx' | 'wiki' | 'sheet';
  createTime?: string;
  updateTime?: string;
  ownerId?: string;
}

export interface DocumentBlock {
  blockId: string;
  blockType: string;
  content?: string;
  children?: DocumentBlock[];
  [key: string]: any;
}

export interface DocumentContent {
  documentId: string;
  title: string;
  content?: string; // Raw content (XML/Markdown/Text based on docFormat)
  revisionId?: number;
  blocks?: DocumentBlock[];
  markdown?: string; // Deprecated, use content instead
}

export interface DocumentSearchResult {
  documents: DocumentInfo[];
  hasMore: boolean;
  pageToken?: string;
}

// ── Chat/Group Types ──

export interface ChatInfo {
  chatId: string;
  name: string;
  description?: string;
  ownerId?: string;
  memberCount?: number;
  chatType?: 'p2p' | 'group';
  createTime?: string;
}

export interface ChatSearchResult {
  chats: ChatInfo[];
  hasMore: boolean;
  pageToken?: string;
}

export interface ChatMember {
  openId: string;
  userId?: string;
  name?: string;
  role?: 'owner' | 'admin' | 'member';
}

// ── User/Contact Types ──

export interface UserInfo {
  openId: string;
  unionId?: string;
  userId?: string;
  name: string;
  enName?: string;
  email?: string;
  mobile?: string;
  avatar?: string;
  department?: string;
  tenantKey?: string;
}

export interface UserSearchResult {
  users: UserInfo[];
  hasMore: boolean;
  pageToken?: string;
}

// ── Message Types ──

export interface MessageSearchResult {
  messages: FeishuMessage[];
  hasMore: boolean;
  pageToken?: string;
}

export interface MessageReplyOptions {
  chatId: string;
  content: string;
  msgType?: string;
  replyInThread?: boolean;
  rootId?: string;
}

// ── Resource Types ──

export interface ResourceDownloadResult {
  filePath: string;
  fileName: string;
  mimeType: string;
  size: number;
}

export interface ResourceUploadResult {
  fileKey: string;
  fileName: string;
  mimeType: string;
}

// ── Permission Types ──

export interface AppPermission {
  scope: string;
  name: string;
  description: string;
  granted: boolean;
}

export interface AppStatus {
  appId: string;
  botEnabled: boolean;
  published: boolean;
  permissions: AppPermission[];
}

// ── Calendar Types ──

export interface CalendarInfo {
  calendarId: string;
  name: string;
  description?: string;
  isPrimary?: boolean;
  isPublic?: boolean;
}

export interface CalendarEvent {
  eventId: string;
  summary: string;
  description?: string;
  startTime: string;
  endTime: string;
  location?: string;
  attendees?: CalendarAttendee[];
  recurrence?: string;
  status?: string;
}

export interface CalendarAttendee {
  openId?: string;
  userId?: string;
  email?: string;
  displayName?: string;
  responseStatus?: 'needs_action' | 'accept' | 'decline' | 'tentative';
  isOptional?: boolean;
  isResource?: boolean;
}

export interface CalendarSearchResult {
  calendars: CalendarInfo[];
  hasMore: boolean;
  pageToken?: string;
}

export interface EventSearchResult {
  events: CalendarEvent[];
  hasMore: boolean;
  pageToken?: string;
}

export interface FreeBusyResult {
  openId: string;
  busyTimes: { start: string; end: string }[];
}

// ── Task Types ──

export interface TaskInfo {
  taskId: string;
  summary: string;
  description?: string;
  dueTime?: string;
  completedTime?: string;
  status: 'needs_action' | 'completed';
  creator?: string;
  assignees?: string[];
  followers?: string[];
}

export interface TaskSearchResult {
  tasks: TaskInfo[];
  hasMore: boolean;
  pageToken?: string;
}

// ── Approval Types ──

export interface ApprovalInstance {
  instanceId: string;
  approvalCode: string;
  status: 'pending' | 'approved' | 'rejected' | 'transferred' | 'canceled';
  createTime: string;
  updateTime?: string;
  requester?: string;
  approvers?: ApprovalNode[];
  formData?: Record<string, any>;
}

export interface ApprovalNode {
  nodeId: string;
  nodeName?: string;
  status: 'pending' | 'approved' | 'rejected' | 'transferred';
  approvers?: ApprovalApprover[];
}

export interface ApprovalApprover {
  openId?: string;
  userId?: string;
  name?: string;
  status: 'pending' | 'approved' | 'rejected' | 'transferred';
  comment?: string;
  operateTime?: string;
}

export interface ApprovalSearchResult {
  instances: ApprovalInstance[];
  hasMore: boolean;
  pageToken?: string;
}

// Import existing types
import type { FeishuConfig, FeishuMessage, CardContent } from '../core/types.js';

export type { FeishuConfig, FeishuMessage, CardContent };
