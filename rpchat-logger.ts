import { OL, PS, PC, OmeggaPlayer } from 'omegga';
import fs from 'fs';
import { Config, Storage, Rooms, PLAYER_PREFS_FILE_PATH, playerRoomPreference } from './types';
import { sendMessageViaWebhook, sendFileViaWebhook, sendCachedRPChatLogs } from './util.webhook';

export function galacticTimeNow(base: { year: number; day: number; hour: number; setAt: number }) {
  const elapsedHours = Math.floor((Date.now() - base.setAt) / (1000 * 60 * 60));
  let hour = base.hour + elapsedHours;
  let day  = base.day  + Math.floor(hour / 24);
  let year = base.year + Math.floor(day  / 365);
  hour = hour % 24;
  day  = ((day % 365) + 365) % 365 || 365;
  return { year, day, hour };
}

function formatGST(base: { year: number; day: number; hour: number; setAt: number } | null | undefined): string {
  if (!base) return "GST unknown";
  const pad = (n: number) => n.toString().padStart(2, "0");
  const { year, day, hour } = galacticTimeNow(base);
  return `Year ${year}, Day ${pad(day)}, ${pad(hour)}:00 GST`;
}

export class RPChatLogger {
  private omegga: OL;
  private config: PC<Config>;
  private store: PS<Storage>;
  private merpaverseColour: string;
  private rpChatCacheFlushTimeout: NodeJS.Timeout | null = null;
  private rpChatCacheFlushIntervalMs: number;

  constructor(
    omegga: OL,
    config: PC<Config>,
    store: PS<Storage>,
    merpaverseColour: string,
    flushIntervalMs: number
  ) {
    this.omegga = omegga;
    this.config = config;
    this.store = store;
    this.merpaverseColour = merpaverseColour;
    this.rpChatCacheFlushIntervalMs = flushIntervalMs;
  }

  async getStoredPlayerRoomPreferences(): Promise<playerRoomPreference[]> {
    try {
      const data = fs.readFileSync(PLAYER_PREFS_FILE_PATH, "utf-8");
      return JSON.parse(data) as playerRoomPreference[];
    } catch (err: any) {
      if (err.code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }

  async handleRPChatMessages(player: OmeggaPlayer, message: string) {
    const writeToChatLog = async (event: Record<string, string>) => {
      const roomPrefs = await this.store.get("playerRoomPreferences");
      const playerPref = roomPrefs.find(e => e.playerId == player.id);

      const fileName = playerPref.room == Rooms.fantasy
        ? await this.store.get("currentFileForFantasyRPChat")
        : await this.store.get("currentFileForSpaceRPChat");
      const roomString = playerPref.room == Rooms.fantasy ? "Fantasy 🧙‍♂️" : "Space 🌕";
      const logLine = `${event.dateTime}\n[${event.user}]: ${event.message}\n`;
      const currentMessages = await this.store.get("messagesToSendViaWebhook") ?? [];
      const updatedMessages = [...currentMessages, `(**${roomString}**) ${logLine}`];
      this.store.set("messagesToSendViaWebhook", updatedMessages);

      if (!this.config.uploadFiles || this.config.sendChatAsWellAsFiles) {
        if (updatedMessages.join("\n").length >= 1900) {
          await this.flushCachedRPChatLogs();
          this.clearRPChatCacheFlushTimeout();
        } else if (updatedMessages.length >= this.config.rpChatLogCacheSize) {
          await this.flushCachedRPChatLogs();
          this.clearRPChatCacheFlushTimeout();
        } else {
          this.resetRPChatCacheFlushTimeout();
        }
      }

      if (fileName != null) {
        fs.appendFileSync(fileName, logLine + "\n", "utf8");
      } else {
        const currentDate = new Date();
        const newFileName = `${playerPref.room == Rooms.fantasy ? "FANTASY-" : "SPACE-"}RPChatLog-${this.formatDateForFilename(currentDate)}.md`;
        if (playerPref.room == Rooms.fantasy) {
          this.store.set("currentFileForFantasyRPChat", newFileName);
        } else {
          this.store.set("currentFileForSpaceRPChat", newFileName);
        }
        const gst = formatGST(await this.store.get("galacticTime"));
        const header = `# RP Chat Log — ${roomString}\nStarted: ${gst}\nReal time: ${new Date().toLocaleString("en-GB")}\n\n---\n\n`;
        fs.writeFileSync(newFileName, header + logLine, "utf8");
      }

      this.omegga.middlePrint(player, `<size="8"><color="${this.merpaverseColour}">MERPaverse</> Chat Message Logged</>`);
    };

    const currentDate = new Date();
    writeToChatLog({ dateTime: currentDate.toLocaleString("en-GB"), user: player.name, message });
  }

  formatDateForFilename(d: Date): string {
    const pad = (n: number) => n.toString().padStart(2, "0");
    const year = d.getFullYear();
    const month = pad(d.getMonth() + 1);
    const day = pad(d.getDate());
    const hours = pad(d.getHours());
    const minutes = pad(d.getMinutes());
    const seconds = pad(d.getSeconds());
    return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`;
  }

  async closeRPChatLogs() {
    const spaceFileName = await this.store.get("currentFileForSpaceRPChat");
    const fantasyFileName = await this.store.get("currentFileForFantasyRPChat");

    const gst = formatGST(await this.store.get("galacticTime"));
    const footer = `\n\n---\n\nEnded: ${gst}\nReal time: ${new Date().toLocaleString("en-GB")}\n-=-=- End of RP Chat Log =-=-`;

    if (spaceFileName) {
      fs.appendFileSync(spaceFileName, footer);
      this.store.set("currentFileForSpaceRPChat", null);

      if (this.config.uploadFiles) {
        const buf = fs.readFileSync(spaceFileName);
        const webhookUrl = this.config.fileFileAlternateWebhookUrl ?? this.config.rpChatLogWebhookUrl;
        if (webhookUrl) {
          const spaceDesc = `💾 Uploaded RP Log : ${spaceFileName} | Session ended ${gst}`;
          const res = await sendFileViaWebhook(webhookUrl, spaceFileName, buf, "text/markdown", spaceDesc);
          if (res.status >= 200 && res.status < 300) {
            console.log("Uploaded SPACE LOG OK:", res.status);
          } else {
            console.warn("Upload SPACE LOG failed:", res.status, res.body);
          }
        }
      }
    }

    if (fantasyFileName) {
      fs.appendFileSync(fantasyFileName, footer);
      this.store.set("currentFileForFantasyRPChat", null);

      if (this.config.uploadFiles) {
        const buf = fs.readFileSync(fantasyFileName);
        const webhookUrl = this.config.fileFileAlternateWebhookUrl ?? this.config.rpChatLogWebhookUrl;
        if (webhookUrl) {
          const fantasyDesc = `💾 Uploaded RP Log : ${fantasyFileName} | Session ended ${gst}`;
          const res = await sendFileViaWebhook(webhookUrl, fantasyFileName, buf, "text/markdown", fantasyDesc);
          if (res.status >= 200 && res.status < 300) {
            console.log("Uploaded FANTASY LOG OK:", res.status);
          } else {
            console.warn("Upload FANTASY LOG failed:", res.status, res.body);
          }
        }
      }
    }
  }

  async updatePlayerRoomPref(player: OmeggaPlayer, room: Rooms) {
    const roomPrefs = await this.store.get("playerRoomPreferences");
    const playerPref = roomPrefs.find(e => e.playerId == player.id);

    if (playerPref === undefined) {
      const updatedArray = [...roomPrefs, { playerId: player.id, room }];
      this.store.set("playerRoomPreferences", updatedArray);
      fs.writeFileSync(PLAYER_PREFS_FILE_PATH, JSON.stringify(updatedArray), "utf-8");
    } else {
      playerPref.room = room;
      const updatedArray = [...roomPrefs.filter(e => e.playerId != player.id), playerPref];
      this.store.set("playerRoomPreferences", updatedArray);
      fs.writeFileSync(PLAYER_PREFS_FILE_PATH, JSON.stringify(updatedArray), "utf-8");
    }

    room == Rooms.fantasy
      ? this.omegga.whisper(player, `[<b><color="${this.merpaverseColour}">MERPaverse Manager</></>] You have joined the <b>Fantasy</> room.`)
      : this.omegga.whisper(player, `[<b><color="${this.merpaverseColour}">MERPaverse Manager</></>] You have joined the <b>Space</> room.`);
  }

  clearRPChatCacheFlushTimeout() {
    if (this.rpChatCacheFlushTimeout) {
      clearTimeout(this.rpChatCacheFlushTimeout);
      this.rpChatCacheFlushTimeout = null;
    }
  }

  resetRPChatCacheFlushTimeout() {
    this.clearRPChatCacheFlushTimeout();
    this.rpChatCacheFlushTimeout = setTimeout(async () => {
      await this.flushCachedRPChatLogs();
      this.rpChatCacheFlushTimeout = null;
    }, this.rpChatCacheFlushIntervalMs);
  }

  async flushCachedRPChatLogs() {
    if (this.config.uploadFiles && !this.config.sendChatAsWellAsFiles) {
      return;
    }

    if (!this.config.rpChatLogWebhookUrl) {
      console.warn("No RP Chat Log Webhook URL configured, skipping log upload.");
      return;
    }

    const messagesToSend = await this.store.get("messagesToSendViaWebhook") ?? [];
    if (messagesToSend.length < 1) {
      return;
    }

    await sendCachedRPChatLogs(this.config.rpChatLogWebhookUrl, messagesToSend);
    this.store.set("messagesToSendViaWebhook", []);
  }
}
