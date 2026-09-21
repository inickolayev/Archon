// Chat adapters
export { TelegramAdapter } from './chat/telegram';
export type {
  TelegramCallbackRequest,
  TelegramCallbackResponse,
  TelegramIncomingFile,
  TelegramMessageContext,
} from './chat/telegram';
export { TurnStatus, describeTool } from './chat/telegram';
export type { StatusTransport, TurnStatusOptions } from './chat/telegram';
export { SlackAdapter, SlackWorkflowBridge } from './chat/slack';

// Forge adapters
export { GitHubAdapter } from './forge/github';

// Community adapters
export { DiscordAdapter } from './community/chat/discord';
