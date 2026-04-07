export type Config = {
  'only-authorized': boolean;
  'authorized-users': { id: string; name: string }[];
  'authorized-roles': string[];
  'admin-roles': string[];
  cooldown: number;
  rpChatLogWebhookUrl?: string | null;
  fileFileAlternateWebhookUrl?: string | null;
  uploadFiles: boolean;
  sendChatAsWellAsFiles: boolean;
  rpChatLogTimeoutMins: number;
  rpChatLogCacheSize: number;
};

export interface playerRoomPreference {
  room: Rooms;
  playerId: string;
}

export type Storage = {
  playersInRPChat: string[];
  playerRoomPreferences: playerRoomPreference[];
  disconnectedRPChatPlayers?: { playerId: string; disconnectedAt: number }[];
  initiativeOrder?: { playerId: string; playerName: string; roll: number }[];
  currentInitiativeTurn?: number;
  galacticTime?: { year: number; day: number; hour: number; setAt: number } | null;
  messagesToSendViaWebhook?: string[];
  currentFileForSpaceRPChat?: string | null;
  currentFileForFantasyRPChat?: string | null;
  cachedRPChatLogs?: string[];
};

export enum Rooms {
  fantasy,
  space
}

export const PLAYER_PREFS_FILE_PATH = "playerRoomPreferences.json";
export const UPLOADED_LOG_LIST = "uploadedLogList.json";
export const LORE_FILE_PATH = "lore.json";

export const fileRegex =
  /^(SPACE|FANTASY)-RPChatLog-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.md$/;
