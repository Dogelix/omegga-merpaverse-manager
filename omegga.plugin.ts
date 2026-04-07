import { OmeggaPlugin, OL, PS, PC, OmeggaPlayer } from 'omegga';
import CooldownProvider from './util.cooldown.js';
import { Config, Storage, Rooms } from './types.js';
import { RPChatLogger } from './rpchat-logger.js';
import { sendMessageViaWebhook } from './util.webhook.js';

export default class Plugin implements OmeggaPlugin<Config, Storage> {
  omegga: OL;
  config: PC<Config>;
  store: PS<Storage>;

  private merpaverseColour: string = "#1c62d4";
  private rpChatLogger: RPChatLogger;
  private disconnectTimeouts = new Map<string, NodeJS.Timeout>();

  private readonly RP_CHAT_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

  constructor(omegga: OL, config: PC<Config>, store: PS<Storage>) {
    this.omegga = omegga;
    this.config = config;
    this.store = store;

    console.log("MERPaverse Config:", config);
  }

  formattedMessage(msg: string) {
    return `[<b><color="${this.merpaverseColour}">MERPaverse Manager</></>] ${msg}`;
  }

  getRandomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  async init() {
    this.store.set("playersInRPChat", []);
    this.store.set("messagesToSendViaWebhook", []);
    this.store.set("playerRoomPreferences", []);
    this.store.set("disconnectedRPChatPlayers", []);

    const flushIntervalMs = Math.max(this.config.rpChatLogTimeoutMins * 60 * 1000, 0);
    this.rpChatLogger = new RPChatLogger(this.omegga, this.config, this.store, this.merpaverseColour, flushIntervalMs);

    const playerPrefs = await this.rpChatLogger.getStoredPlayerRoomPreferences();
    this.store.set("playerRoomPreferences", playerPrefs);

    const duration = Math.max(this.config.cooldown * 1000, 0);
    const cooldown = duration <= 0 ? () => true : CooldownProvider(duration);

    if (this.config.rpChatLogWebhookUrl) {
      await sendMessageViaWebhook(this.config.rpChatLogWebhookUrl, `🤖 **MERPaverse** Manager initialized! 🤖`);

      if (this.config.uploadFiles) {
        if (this.config.fileFileAlternateWebhookUrl) {
          await sendMessageViaWebhook(this.config.rpChatLogWebhookUrl, `⚠️ Files will be uploaded to alternate channel ⚠️`);
          if (this.config.sendChatAsWellAsFiles) {
            await sendMessageViaWebhook(this.config.rpChatLogWebhookUrl, `ℹ️ sendChatAsWellAsFiles is enabled, chat messages will also be sent. ℹ️`);
            await sendMessageViaWebhook(this.config.rpChatLogWebhookUrl, `⚠️ Chat cache size: ${this.config.rpChatLogCacheSize} ⚠️`);
            await sendMessageViaWebhook(this.config.rpChatLogWebhookUrl, `⚠️ Chat timeout (mins): ${this.config.rpChatLogTimeoutMins ?? 5} ⚠️`);
          }
        }
      } else {
        await sendMessageViaWebhook(this.config.rpChatLogWebhookUrl, `⚠️ Chat cache size: ${this.config.rpChatLogCacheSize} ⚠️`);
        await sendMessageViaWebhook(this.config.rpChatLogWebhookUrl, `⚠️ Chat timeout (mins): ${this.config.rpChatLogTimeoutMins ?? 5} ⚠️`);
      }
    }

    const authorized = (name: string) => {
      const player = this.omegga.getPlayer(name);
      return (
        !this.config['only-authorized'] ||
        player.isHost() ||
        this.config['authorized-users'].some(p => player.id === p.id) ||
        player.getRoles().some(role => this.config['authorized-roles'].includes(role))
      );
    };

    this.omegga
      .on("join", async (player: OmeggaPlayer) => {
        const disconnected = await this.store.get("disconnectedRPChatPlayers") ?? [];
        if (disconnected.some(e => e.playerId === player.id)) {
          if (this.disconnectTimeouts.has(player.id)) {
            clearTimeout(this.disconnectTimeouts.get(player.id));
            this.disconnectTimeouts.delete(player.id);
          }
          this.store.set("disconnectedRPChatPlayers", disconnected.filter(e => e.playerId !== player.id));
          this.omegga.middlePrint(player, this.formattedMessage(`You have <color="#17ad3f">joined</> the RP Chat.`))
        }
      })
      .on("leave", async (player: OmeggaPlayer) => {
        console.log(player.name + " has left");
        const players = await this.store.get("playersInRPChat");
        if (players.includes(player.id)) {
          // Keep in playersInRPChat — mark disconnected and start 1-hour expiry
          const disconnected = await this.store.get("disconnectedRPChatPlayers") ?? [];
          if (!disconnected.some(e => e.playerId === player.id)) {
            this.store.set("disconnectedRPChatPlayers", [...disconnected, { playerId: player.id, disconnectedAt: Date.now() }]);
          }
          this.scheduleRPChatExpiry(player.id);
        }
      })
      .on("chat", async (name: string, message: string) => {
        const player = this.omegga.getPlayer(name);
        const players = await this.store.get("playersInRPChat");
        if (players.includes(player.id)) {
          this.rpChatLogger.handleRPChatMessages(player, message);
        }
      })
      .on("cmd:me", async (name: string, ...args) => {
        const player = this.omegga.getPlayer(name);

        if (!authorized(name)) {
          this.omegga.whisper(player, this.formattedMessage("Unauthorised"));
          return;
        }
        if (!cooldown(name)) {
          this.omegga.whisper(player, this.formattedMessage("Commands on cooldown."));
          return;
        }

        const roomPrefs = await this.store.get("playerRoomPreferences");
        const playerPref = roomPrefs.find(e => e.playerId == player.id);
        if (playerPref === undefined) {
          await this.rpChatLogger.updatePlayerRoomPref(player, Rooms.space);
        }

        const message = OMEGGA_UTIL.chat.parseLinks(OMEGGA_UTIL.chat.sanitize(args.join(" ")));
        this.omegga.broadcast(`<b><color="${player.getNameColor()}">${player.name}</></> (<b>RP Command</>) ${message}`);
        this.rpChatLogger.handleRPChatMessages(player, message);
      })
      .on("cmd:dmerp", async (name: string, option: string, ...args) => {
        const player = this.omegga.getPlayer(name);

        if (!authorized(name)) {
          this.omegga.whisper(player, this.formattedMessage("Unauthorised"));
          return;
        }
        if (!cooldown(name)) {
          this.omegga.whisper(player, this.formattedMessage("Commands on cooldown."));
          return;
        }

        switch (option) {
          case "h":
            this.cmdHelp(player);
            break;
          case "aetherion":
          case "aeth":
            this.omegga.whisper(player, this.formattedMessage("'aetherion'/'aeth' is deprecated."));
            break;
          case "rp":
            try {
              this.cmdHandleRPOptions(player, args[0]);
            } catch (e) {
              console.error(e);
            }
            break;
          case "s":
          case "stat":
            this.omegga.whisper(player, this.formattedMessage("Stat command deprecated."));
            break;
          case "c":
          case "combat":
            try {
              const av = Number.parseInt(args[0]);
              const ap = Number.parseInt(args[1]);
              if (Number.isNaN(av) || Number.isNaN(ap)) {
                this.omegga.whisper(player, this.formattedMessage("AV or AP was not a <b>WHOLE</b> number."));
              }
              this.cmdCombatRoll(player, av, ap);
            } catch (ex) {
              console.error("An eror occured in dmerp:combat", ex);
            }
            break;
        }
      })
      .on("cmd:ooc", async (name: string, ...contents) => {
        const player = this.omegga.getPlayer(name);

        if (!authorized(name)) {
          this.omegga.whisper(player, this.formattedMessage("Unauthorised"));
          return;
        }

        const players = await this.store.get("playersInRPChat");
        if (players.includes(player.id)) {
          const colour = player.getNameColor();
          this.omegga.broadcast(
            `[<b><color="${this.merpaverseColour}">OOC</></>] <color="${colour}">${player.name}</>: ` +
            OMEGGA_UTIL.chat.parseLinks(OMEGGA_UTIL.chat.sanitize(contents.join(" ")))
          );
        } else {
          this.omegga.whisper(player, this.formattedMessage("Not in RP Chat"));
        }
      });

    return { registeredCommands: ['ooc', "dmerp", "me", "uploadLogs"] };
  }

  cmdAetherion(player: OmeggaPlayer, amount: number) {
    console.log("Entered cmdAetherion");
    for (let index = 0; index < amount; index++) {
      const planet = this.getRandomInt(1, 10);
      const size = this.getRandomInt(1, 4);

      let planetString: string;
      switch (planet) {
        case 1:
        case 5:  planetString = "Eryndor 1"; break;
        case 2:  planetString = "Eryndor 2"; break;
        case 3:  planetString = "Veylara"; break;
        case 4:  planetString = "Eryndor 4"; break;
        case 6:  planetString = "Eryndor 6"; break;
        case 7:  planetString = "Eryndor 7"; break;
        case 8:  planetString = "Eryndor 8"; break;
        case 9:  planetString = "Eryndor 9"; break;
        case 10: planetString = "Eryndor 10"; break;
        default: planetString = `${planet} (shouldn't see this)`;
      }

      let sizeString: string;
      switch (size) {
        case 1:  sizeString = "Major Deposit"; break;
        case 2:  sizeString = "Minor Deposit"; break;
        case 3:  sizeString = "Minor Crystal"; break;
        case 4:  sizeString = "Major Crystal"; break;
      }

      this.omegga.whisper(player, this.formattedMessage(`${sizeString}(${size}) on ${planetString}`));
    }
  }

  async cmdHelp(player: OmeggaPlayer) {
    const commandsList = [
      `<color="#ffee00ff">/dmerp option args</>`,
      `> <color="#ff7300ff">option: h</>  <color="#00b7ffff">args: </>`,
      `> > Returns this help list`,
      `> <color="#ff7300ff">option: rp</>  <color="#00b7ffff">args: ('join/j','leave/l' or 'info/i')</>`,
      `> > Allows you to join the RP mode where all your chat messages will be logged unless you use <b>/ooc message</>`,
      `> <color="#ff7300ff">option: rp</>  <color="#00b7ffff">args: ('fantasy/f' or 'space/s')</>`,
      `> > Allows you to join the RP rooms for better logging.`,
      `> <color="#ff7300ff">option: stat</>  <color="#00b7ffff">args: ('large/l','medium/m' or 'small/s') (av) (ap)</>`,
      `> > Creates a glowing stat brick of your desired size with the AV/AP values applied. Just place.`,
      `> <color="#ff7300ff">option: combat</>  <color="#00b7ffff">args: (av) (ap)</>`,
      `> > Makes a combat roll, as if you are attacking. It then shows the results.`,
      `<color="#ffee00ff">/me message</>`,
      `> > Directly logs to the RP chat log without joining.`,
      `<color="#ffee00ff">/ooc message</>`,
      `> > Stops this message from being logged when you are in rp mode`,
    ];

    this.omegga.whisper(player, this.formattedMessage("Command list:"));
    commandsList.map(message => this.omegga.whisper(player, message));
  }

  async cmdHandleRPOptions(player: OmeggaPlayer, option: string) {
    let players = await this.store.get("playersInRPChat");

    if (!option) {
      this.omegga.whisper(player, this.formattedMessage("Option <b>required</> for RP Command"));
      console.warn(player.name + " tried to do the RP command without an option.");
      return;
    }

    const opt = option.toLowerCase();

    if (["join", "j"].includes(opt)) {
      if (players.includes(player.id)) {
        this.omegga.whisper(player, this.formattedMessage("You are already in the RP chat"));
        return;
      }

      players.push(player.id);
      console.log(`Player ${player.name} has joined RP Chat.`);

      const roomPrefs = await this.store.get("playerRoomPreferences");
      const playerPref = roomPrefs.find(e => e.playerId == player.id);
      if (playerPref === undefined) {
        await this.rpChatLogger.updatePlayerRoomPref(player, Rooms.space);
      }

      this.store.set("playersInRPChat", players);
      this.omegga.whisper(player, this.formattedMessage(`You have <color="#17ad3f">joined</> the RP Chat.`));
      playerPref?.room == Rooms.fantasy
        ? this.omegga.whisper(player, this.formattedMessage("You have joined the <b>Fantasy</> room."))
        : this.omegga.whisper(player, this.formattedMessage("You have joined the <b>Space</> room."));

    } else if (["leave", "l"].includes(opt)) {
      players = players.filter(e => e != player.id);
      this.store.set("playersInRPChat", players);
      console.log(`Player ${player.name} has left RP Chat.`);
      this.omegga.whisper(player, this.formattedMessage(`You have <color="#ad1313">left</> the RP Chat.`));
      if (players.length < 1) {
        this.rpChatLogger.closeRPChatLogs();
      }

    } else if (["info", "i"].includes(opt)) {
      this.omegga.whisper(player, this.formattedMessage("Players currently in RP Chat:"));
      players.map((p) => {
        const pPlayer = this.omegga.getPlayer(p);
        this.omegga.whisper(player, `<color="${pPlayer.getNameColor()}">${pPlayer.name}</>`);
      });

    } else if (["clear", "c"].includes(opt)) {
      if (player.getRoles().includes("GM")) {
        this.store.set("playersInRPChat", null);
        this.rpChatLogger.closeRPChatLogs();
        this.omegga.whisper(player, this.formattedMessage("RP Chat cleared."));
      } else {
        this.omegga.whisper(player, this.formattedMessage("Unauthorised"));
      }

    } else if (["space", "s"].includes(opt)) {
      this.rpChatLogger.updatePlayerRoomPref(player, Rooms.space);
    } else if (["fantasy", "f"].includes(opt)) {
      this.rpChatLogger.updatePlayerRoomPref(player, Rooms.fantasy);
    }
  }

  async cmdCombatRoll(player: OmeggaPlayer, av: number, ap: number) {
    const player1Name = `<color="${player.getNameColor()}">${player.name}</>`;
    this.omegga.broadcast(this.formattedMessage(`${player1Name} is making a combat roll (attacking).`));

    let attacker = this.getRandomInt(3, 18);
    const defender = this.getRandomInt(3, 18);

    if (ap > av) {
      const difference = ap - av;
      this.omegga.broadcast(this.formattedMessage(`<color="#de6b00">AP</> > <color="#dbc60b">AV</> applying a +${difference} to attacker roll.`));
      attacker = Math.min(attacker + difference, 18);
    }

    if (attacker === 3) {
      this.omegga.broadcast(this.formattedMessage(`${player1Name} rolled a <b>Critical Fail</>. No damage taken.`));
    } else if (defender === 3) {
      this.omegga.broadcast(this.formattedMessage(`Defender rolled a <b>Critical Fail</>. Double damage taken.`));
    } else if (attacker === 18) {
      const critDamage = ap + 1;
      this.omegga.broadcast(this.formattedMessage(`${player1Name} rolled a <b>Critical Hit</>. Damage resolved at ${critDamage > 8 ? "Double Damage" : `<color="#de6b00">AP</>: ${critDamage}`}.`));
    } else if (defender >= attacker) {
      this.omegga.broadcast(this.formattedMessage(`${player1Name}: ${attacker} vs. Defender: ${defender}. No damage taken.`));
    } else {
      this.omegga.broadcast(this.formattedMessage(`${player1Name}: ${attacker} vs. Defender: ${defender}. Damage taken.`));
    }
  }

  private scheduleRPChatExpiry(playerId: string) {
    if (this.disconnectTimeouts.has(playerId)) {
      clearTimeout(this.disconnectTimeouts.get(playerId));
    }
    const timeout = setTimeout(async () => {
      this.disconnectTimeouts.delete(playerId);

      const players = await this.store.get("playersInRPChat");
      const updated = players.filter(e => e !== playerId);
      this.store.set("playersInRPChat", updated);

      const disconnected = await this.store.get("disconnectedRPChatPlayers") ?? [];
      this.store.set("disconnectedRPChatPlayers", disconnected.filter(e => e.playerId !== playerId));

      console.log(`Player ${playerId} RP chat session expired after 1 hour.`);
      if (updated.length < 1) {
        this.rpChatLogger.closeRPChatLogs();
      }
    }, this.RP_CHAT_EXPIRY_MS);
    this.disconnectTimeouts.set(playerId, timeout);
  }

  async stop() {
    for (const timeout of this.disconnectTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.disconnectTimeouts.clear();
    this.rpChatLogger.clearRPChatCacheFlushTimeout();
    await this.rpChatLogger.flushCachedRPChatLogs();
    await this.rpChatLogger.closeRPChatLogs();
  }
}
