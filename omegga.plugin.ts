import { OmeggaPlugin, OL, PS, PC, OmeggaPlayer } from 'omegga';
import CooldownProvider from './util.cooldown.js';
import fs from 'fs';
import { Config, Storage, Rooms, LORE_FILE_PATH, DISCONNECTED_PLAYERS_FILE_PATH } from './types.js';
import { RPChatLogger, galacticTimeNow } from './rpchat-logger.js';
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
    this.store.set("initiativeOrder", []);
    this.store.set("currentInitiativeTurn", 0);

    // Restore disconnected players that haven't expired yet
    const now = Date.now();
    const loaded = this.loadDisconnectedPlayers();
    const stillValid = loaded.filter(e => (e.disconnectedAt + this.RP_CHAT_EXPIRY_MS) > now);
    if (stillValid.length < loaded.length) {
      this.saveDisconnectedPlayers(stillValid);
    }
    this.store.set("disconnectedRPChatPlayers", stillValid);
    this.store.set("playersInRPChat", stillValid.map(e => e.playerId));
    for (const entry of stillValid) {
      const remainingMs = (entry.disconnectedAt + this.RP_CHAT_EXPIRY_MS) - now;
      this.scheduleRPChatExpiry(entry.playerId, remainingMs);
    }

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
          const updatedDisconnected = disconnected.filter(e => e.playerId !== player.id);
          this.store.set("disconnectedRPChatPlayers", updatedDisconnected);
          this.saveDisconnectedPlayers(updatedDisconnected);
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
            const updatedDisconnected = [...disconnected, { playerId: player.id, disconnectedAt: Date.now() }];
            this.store.set("disconnectedRPChatPlayers", updatedDisconnected);
            this.saveDisconnectedPlayers(updatedDisconnected);
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
          case "r":
          case "roll":
            this.cmdRoll(player, args[0]);
            break;
          case "init":
          case "initiative":
            this.cmdInitiative(player, args[0]);
            break;
          case "lore":
            this.cmdLore(player, args[0]);
            break;
          case "time":
            this.cmdTime(player, args[0], args[1], args[2], args[3]);
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
        case 5: planetString = "Eryndor 1"; break;
        case 2: planetString = "Eryndor 2"; break;
        case 3: planetString = "Veylara"; break;
        case 4: planetString = "Eryndor 4"; break;
        case 6: planetString = "Eryndor 6"; break;
        case 7: planetString = "Eryndor 7"; break;
        case 8: planetString = "Eryndor 8"; break;
        case 9: planetString = "Eryndor 9"; break;
        case 10: planetString = "Eryndor 10"; break;
        default: planetString = `${planet} (shouldn't see this)`;
      }

      let sizeString: string;
      switch (size) {
        case 1: sizeString = "Major Deposit"; break;
        case 2: sizeString = "Minor Deposit"; break;
        case 3: sizeString = "Minor Crystal"; break;
        case 4: sizeString = "Major Crystal"; break;
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
      `> <color="#ff7300ff">option: combat</>  <color="#00b7ffff">args: (av) (ap)</>`,
      `> > Makes a combat roll. Shows the result to all players.`,
      `> <color="#ff7300ff">option: roll (r)</>  <color="#00b7ffff">args: (XdY+N) e.g. 2d6+3, d20</>`,
      `> > Rolls dice and broadcasts the result.`,
      `> <color="#ff7300ff">option: initiative (init)</>  <color="#00b7ffff">args: (roll, list, next, clear)</>`,
      `> > Manages combat initiative order. roll adds you to the list. list shows the current order. next and clear are GM only.`,
      `> <color="#ff7300ff">option: lore</>  <color="#00b7ffff">args: (topic)</>`,
      `> > Whispers a lore entry for the given topic.`,
      `> <color="#ff7300ff">option: time</>  <color="#00b7ffff">args: ([set &lt;year&gt; &lt;day&gt; &lt;hour&gt;])</>`,
      `> > Shows the current Galactic Standard Time (1:1 with IRL time). GMs can set it with the optional args.`,
      `> <color="#ff7300ff">option: lore</>  <color="#00b7ffff">args: list)</>`,
      `> > Whispers a list of lore topics`,
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

  private parseDice(notation: string): { rolls: number[]; modifier: number; total: number } | null {
    const match = notation?.match(/^(\d*)d(\d+)([+-]\d+)?$/i);
    if (!match) return null;
    const count = Math.max(1, parseInt(match[1] || '1'));
    const sides = parseInt(match[2]);
    const modifier = parseInt(match[3] || '0');
    if (count > 20 || sides < 2 || sides > 1000) return null;
    const rolls = Array.from({ length: count }, () => this.getRandomInt(1, sides));
    return { rolls, modifier, total: rolls.reduce((a, b) => a + b, 0) + modifier };
  }

  cmdRoll(player: OmeggaPlayer, notation: string) {
    if (!notation) {
      this.omegga.whisper(player, this.formattedMessage("Usage: <b>/dmerp roll 2d6+3</>"));
      return;
    }
    const result = this.parseDice(notation);
    if (!result) {
      this.omegga.whisper(player, this.formattedMessage(`Invalid dice notation: <b>${notation}</>. Example: <b>2d6+3</>`));
      return;
    }
    const { rolls, modifier, total } = result;
    const rollsStr = rolls.length > 1 ? `[${rolls.join(", ")}]` : `${rolls[0]}`;
    const modStr = modifier !== 0 ? ` ${modifier > 0 ? "+" : ""}${modifier}` : "";
    const player1Name = `<color="${player.getNameColor()}">${player.name}</>`;
    this.omegga.broadcast(this.formattedMessage(
      `${player1Name} rolled <b>${notation}</>: ${rollsStr}${modStr} = <b>${total}</>`
    ));
  }

  async cmdInitiative(player: OmeggaPlayer, subCmd: string) {
    const sub = (subCmd ?? "roll").toLowerCase();
    const isGM = player.getRoles().includes("GM") || player.isHost();

    if (sub === "roll") {
      const roll = this.getRandomInt(1, 20);
      const order = await this.store.get("initiativeOrder") ?? [];
      const updated = order.filter(e => e.playerId !== player.id);
      updated.push({ playerId: player.id, playerName: player.name, roll });
      updated.sort((a, b) => b.roll - a.roll);
      this.store.set("initiativeOrder", updated);
      this.store.set("currentInitiativeTurn", 0);
      const player1Name = `<color="${player.getNameColor()}">${player.name}</>`;
      this.omegga.broadcast(this.formattedMessage(`${player1Name} rolled initiative: <b>${roll}</>`));

    } else if (sub === "list" || sub === "l") {
      const order = await this.store.get("initiativeOrder") ?? [];
      if (order.length === 0) {
        this.omegga.whisper(player, this.formattedMessage("No initiative rolls yet."));
        return;
      }
      const turn = await this.store.get("currentInitiativeTurn") ?? 0;
      this.omegga.whisper(player, this.formattedMessage("Initiative order:"));
      order.forEach((entry, i) => {
        const marker = i === turn ? " <b>◀ current</>" : "";
        this.omegga.whisper(player, `  ${i + 1}. ${entry.playerName} — <b>${entry.roll}</>${marker}`);
      });

    } else if (sub === "next" || sub === "n") {
      if (!isGM) {
        this.omegga.whisper(player, this.formattedMessage("Only GMs can advance the turn."));
        return;
      }
      const order = await this.store.get("initiativeOrder") ?? [];
      if (order.length === 0) {
        this.omegga.whisper(player, this.formattedMessage("No initiative rolls yet."));
        return;
      }
      const turn = await this.store.get("currentInitiativeTurn") ?? 0;
      const next = (turn + 1) % order.length;
      this.store.set("currentInitiativeTurn", next);
      const current = order[next];
      this.omegga.broadcast(this.formattedMessage(`It is now <b>${current.playerName}</b>'s turn.`));

    } else if (sub === "clear" || sub === "c") {
      if (!isGM) {
        this.omegga.whisper(player, this.formattedMessage("Only GMs can clear initiative."));
        return;
      }
      this.store.set("initiativeOrder", []);
      this.store.set("currentInitiativeTurn", 0);
      this.omegga.broadcast(this.formattedMessage("Initiative order cleared."));

    } else {
      this.omegga.whisper(player, this.formattedMessage("Usage: <b>/dmerp initiative [roll|list|next|clear]</>"));
    }
  }

  cmdLore(player: OmeggaPlayer, topic: string) {
    if (!topic) {
      this.omegga.whisper(player, this.formattedMessage("Usage: <b>/dmerp lore &lt;topic&gt;</>"));
      return;
    }
    let entries: Record<string, string>;
    try {
      entries = JSON.parse(fs.readFileSync(LORE_FILE_PATH, "utf-8"));
    } catch {
      this.omegga.whisper(player, this.formattedMessage("Lore file not found or invalid."));
      return;
    }

    if (topic.toLowerCase() == "list") {
      this.omegga.whisper(player, this.formattedMessage(`Lore Topics:`));
      Object.keys(entries).map((key) => {
        this.omegga.whisper(player, this.formattedMessage(`> ${key}`));
      });
      return;
    }

    const key = Object.keys(entries).find(k => k.toLowerCase() === topic.toLowerCase());
    if (!key) {
      const available = Object.keys(entries).join(", ");
      this.omegga.whisper(player, this.formattedMessage(`Unknown topic <b>${topic}</>. Available: ${available}`));
      return;
    }
    this.omegga.whisper(player, this.formattedMessage(`<b>${key}</>:`));
    this.omegga.whisper(player, entries[key]);
  }

  async cmdTime(player: OmeggaPlayer, subCmd: string, yearArg: string, dayArg: string, hourArg: string) {
    const isGM = player.getRoles().includes("GM") || player.isHost();

    if (!subCmd || subCmd === "show") {
      const stored = await this.store.get("galacticTime");
      if (!stored) {
        this.omegga.whisper(player, this.formattedMessage("Galactic time has not been set. A GM must run <b>/dmerp time set &lt;year&gt; &lt;day&gt; &lt;hour&gt;</>"));
        return;
      }
      const { year, day, hour } = galacticTimeNow(stored);
      const pad = (n: number) => n.toString().padStart(2, "0");
      this.omegga.whisper(player, this.formattedMessage(
        `<b>Galactic Standard Time</> — Year <b>${year}</>, Day <b>${pad(day)}</>, Hour <b>${pad(hour)}:00 GST</>`
      ));

    } else if (subCmd === "set") {
      if (!isGM) {
        this.omegga.whisper(player, this.formattedMessage("Only GMs can set galactic time."));
        return;
      }
      const year = parseInt(yearArg);
      const day  = parseInt(dayArg);
      const hour = parseInt(hourArg);
      if (isNaN(year) || isNaN(day) || isNaN(hour) || day < 1 || day > 365 || hour < 0 || hour > 23) {
        this.omegga.whisper(player, this.formattedMessage("Usage: <b>/dmerp time set &lt;year&gt; &lt;day 1-365&gt; &lt;hour 0-23&gt;</>"));
        return;
      }
      this.store.set("galacticTime", { year, day, hour, setAt: Date.now() });
      const pad = (n: number) => n.toString().padStart(2, "0");
      this.omegga.broadcast(this.formattedMessage(
        `Galactic time set — Year <b>${year}</>, Day <b>${pad(day)}</>, Hour <b>${pad(hour)}:00 GST</>`
      ));

    } else {
      this.omegga.whisper(player, this.formattedMessage("Usage: <b>/dmerp time [set &lt;year&gt; &lt;day&gt; &lt;hour&gt;]</>"));
    }
  }

  private loadDisconnectedPlayers(): { playerId: string; disconnectedAt: number }[] {
    try {
      return JSON.parse(fs.readFileSync(DISCONNECTED_PLAYERS_FILE_PATH, "utf-8"));
    } catch (err: any) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
  }

  private saveDisconnectedPlayers(entries: { playerId: string; disconnectedAt: number }[]) {
    fs.writeFileSync(DISCONNECTED_PLAYERS_FILE_PATH, JSON.stringify(entries), "utf-8");
  }

  private scheduleRPChatExpiry(playerId: string, delayMs = this.RP_CHAT_EXPIRY_MS) {
    if (this.disconnectTimeouts.has(playerId)) {
      clearTimeout(this.disconnectTimeouts.get(playerId));
    }
    const timeout = setTimeout(async () => {
      this.disconnectTimeouts.delete(playerId);

      const players = await this.store.get("playersInRPChat");
      const updated = players.filter(e => e !== playerId);
      this.store.set("playersInRPChat", updated);

      const disconnected = await this.store.get("disconnectedRPChatPlayers") ?? [];
      const updatedDisconnected = disconnected.filter(e => e.playerId !== playerId);
      this.store.set("disconnectedRPChatPlayers", updatedDisconnected);
      this.saveDisconnectedPlayers(updatedDisconnected);

      console.log(`Player ${playerId} RP chat session expired.`);
      if (updated.length < 1) {
        this.rpChatLogger.closeRPChatLogs();
      }
    }, delayMs);
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
