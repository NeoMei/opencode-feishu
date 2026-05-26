// Main entry point - exports both standalone and plugin modes

export { startStandalone } from './standalone.js';
export { default as FeishuPlugin } from './plugin.js';
export { SetupWizard } from './setup/wizard.js';
export { ConfigManager } from './core/config.js';
export { ProfileManager } from './core/profile-manager.js';
export type { FeishuConfig } from './core/types.js';

// Services
export {
  BaseService,
  IMService,
  DocService,
  ChatService,
  ContactService,
  CalendarService,
  TaskService,
  ApprovalService,
} from './services/index.js';

// Types
export type {
  DocumentInfo,
  DocumentContent,
  DocumentSearchResult,
  ChatInfo,
  ChatSearchResult,
  ChatMember,
  UserInfo,
  UserSearchResult,
  MessageSearchResult,
  MessageReplyOptions,
  ResourceDownloadResult,
  ResourceUploadResult,
  CalendarInfo,
  CalendarEvent,
  CalendarSearchResult,
  EventSearchResult,
  FreeBusyResult,
  TaskInfo,
  TaskSearchResult,
  ApprovalInstance,
  ApprovalSearchResult,
  AppPermission,
  AppStatus,
} from './types/extended.js';
