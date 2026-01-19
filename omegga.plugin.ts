import { OmeggaPlugin, OL, PS, PC, OmeggaPlayer } from 'omegga';
import CooldownProvider from './util.cooldown.js';
import { appendFileSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import https from "https";

// plugin config and storage
type Config = {
  'only-authorized': boolean;
  'authorized-users': { id: string; name: string }[];
  'authorized-roles': string[];
  'admin-roles': string[];
  cooldown: number;
  rpChatLogWebhookUrl?: string | null;
};

interface playerRoomPreference {
  room: Rooms;
  playerId: string;
}

interface uploadedLogEntry {
  uploaded: boolean;
  logName: string;
  uploadTime: Date;
}

type Storage = {
  playersInRPChat: string[];
  playerRoomPreferences: playerRoomPreference[];
  messagesToSendViaWebhook?: string[];
  currentFileForSpaceRPChat?: string | null;
  currentFileForFantasyRPChat?: string | null;
};

enum Rooms {
  fantasy,
  space
}

const PLAYER_PREFS_FILE_PATH = "playerRoomPreferences.json";
const UPLOADED_LOG_LIST = "uploadedLogList.json";

const fileRegex =
  /^(SPACE|FANTASY)-RPChatLog-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.md$/;

export default class Plugin implements OmeggaPlugin<Config, Storage> {
  omegga: OL;
  config: PC<Config>;
  store: PS<Storage>;

  merpaverseColour: string = "#1c62d4";

  constructor(omegga: OL, config: PC<Config>, store: PS<Storage>) {
    this.omegga = omegga;
    this.config = config;
    this.store = store;

    console.log("MERPaverse Config:", config);
  }

  formattedMessage(msg: string) {
    return `[<b><color="${this.merpaverseColour}">MERPaverse Manager</></>] ${msg}`;
  }

  msUntil(hour: number, minute = 0) {
    const now = new Date();
    const next = new Date();

    next.setHours(hour, minute, 0, 0);
    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }

    return next.getTime() - now.getTime();
  }

  async getStoredPlayerRoomPreferences() {
    try {
      const data = readFileSync(PLAYER_PREFS_FILE_PATH, "utf-8");
      const returnValue = JSON.parse(data) as playerRoomPreference[];
      console.log("Loaded stored room prefs: ", returnValue);
      return returnValue;
    } catch (err: any) {
      if (err.code === "ENOENT") {
        return [] as playerRoomPreference[]; // file not found
      }
      throw err; // other errors (invalid JSON, permission, etc.)
    }
  };

  async uploadLogs(player: OmeggaPlayer) {
    console.log("Uploading Logs");
    this.omegga.whisper(player, this.formattedMessage("Uploading RP Logs"));
    let currentFiles: uploadedLogEntry[] = [];

    try {
      const data = readFileSync(UPLOADED_LOG_LIST, "utf-8");
      currentFiles = JSON.parse(data) as uploadedLogEntry[];
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        console.error(err);
        return;
      }


      this.omegga.whisper(player, this.formattedMessage("Log list not found. Creating."));

      writeFileSync(UPLOADED_LOG_LIST, JSON.stringify(currentFiles), "utf-8");
    }

    const files = readdirSync("./", { withFileTypes: true }).filter(e => !e.isDirectory() && e.name.includes(".md")).map(item => item.name);
    const flatUploadedPaths = currentFiles.flatMap(e => e.logName);
    const filesToUpload = files.filter(e => !flatUploadedPaths.includes(e));

    filesToUpload.map(async (path) => {

      this.omegga.whisper(player, this.formattedMessage("Uploading " + path));
      const fileBytes = readFileSync(path, "utf-8");
      const formData = new FormData();
      const uploadDate = new Date();
      formData.append("content", `File Uploaded => ${uploadDate.toISOString()}`);
      formData.append("file", new Blob([fileBytes]), path.match(fileRegex)[0]);

      await fetch("https://discord.com/api/webhooks/1447548158686265395/gl8Hhj4xN80ohlAqEzk6yawxc4uGaeIGfl0GCJ8gjFjjHPpoDFaX41_ikaiHklVYKjVu", {
        method: "POST",
        body: formData
      });

      currentFiles.push({
        uploaded: true,
        logName: path,
        uploadTime: uploadDate
      });
    });

    writeFileSync(UPLOADED_LOG_LIST, JSON.stringify(currentFiles), "utf-8");
  }

  async init() {
    this.store.set("playersInRPChat", []);
    this.store.set("messagesToSendViaWebhook", []);
    this.store.set("playerRoomPreferences", []);

    const playerPrefs = await this.getStoredPlayerRoomPreferences();
    this.store.set("playerRoomPreferences", playerPrefs);

    const duration = Math.max(this.config.cooldown * 1000, 0);
    const cooldown = duration <= 0 ? () => true : CooldownProvider(duration);

    const authorized = (name: string) => {
      const player = this.omegga.getPlayer(name);
      return (
        !this.config['only-authorized'] ||
        player.isHost() ||
        this.config['authorized-users'].some(p => player.id === p.id) ||
        player
          .getRoles()
          .some(role => this.config['authorized-roles'].includes(role))
      );
    };

    const adminRoleAuth = (name: string) => {
      const player = this.omegga.getPlayer(name);
      return (
        player.isHost() ||
        player
          .getRoles()
          .some(role => this.config['admin-roles'].includes(role))
      );
    };

    this.omegga
      .on("leave", async (player: OmeggaPlayer) => {
        console.log(player.name + " has left");
        const players = await this.store.get("playersInRPChat");
        if (players.includes(player.id)) {
          this.store.set("playersInRPChat", players.filter(e => e != player.id));

          if (players.length < 1) {
            console.log("Clearing RP File Name");
            this.store.set("currentFileForSpaceRPChat", null);
            this.store.set("currentFileForFantasyRPChat", null);
          }
        }
      })
      .on("chat", async (name: string, message: string) => {
        const player = this.omegga.getPlayer(name);

        const players = await this.store.get("playersInRPChat");
        if (players.includes(player.id)) {
          this.handleRPChatMessages(player, message);
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
          await this.updatePlayerRoomPref(player, Rooms.space);
        }

        const message = OMEGGA_UTIL.chat.parseLinks(OMEGGA_UTIL.chat.sanitize(args.join(" ")));
        this.omegga.broadcast(`<b><color="${player.getNameColor()}">${player.name}</></> (<b>RP Command</>) ${message}`);
        this.handleRPChatMessages(player, message);
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
          case "upload":
            if (!adminRoleAuth(name)) {
              this.omegga.whisper(player, this.formattedMessage("Unauthorised"));
              return;
            }

            await this.uploadLogs(player);
            break;
          case "h":
            this.cmdHelp(player);
            break;
          case "aetherion":
          case "aeth":
            try {
              const value = Number.parseInt(args[0]);
              if (Number.isNaN(value)) {
                this.omegga.whisper(player, this.formattedMessage("amount MUST be a number"));
                return;
              }

              this.cmdAetherion(player, value);
            }
            catch (e) {
              console.error(e);
            }
            break;
          case "rp":
            try {
              const joinOption = args[0];
              this.cmdHandleChat(player, joinOption);
            }
            catch (e) {
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

        let players = await this.store.get("playersInRPChat");
        if (players.includes(player.id)) {
          const rpChatFormat = (sendingPlayer: OmeggaPlayer, msg: string) => {
            const sendingPlayerColour = sendingPlayer.getNameColor();
            return `[<b><color="${this.merpaverseColour}">OOC</></>] <color="${sendingPlayerColour}">${sendingPlayer.name}</>: ${msg}`;
          }

          this.omegga.broadcast(rpChatFormat(player, OMEGGA_UTIL.chat.parseLinks(OMEGGA_UTIL.chat.sanitize(contents.join(" ")))));
        } else {
          this.omegga.whisper(player, this.formattedMessage("Not in RP Chat"));
        }
      });

    return { registeredCommands: ['ooc', "dmerp", "me", "uploadLogs"] };
  }

  cmdAetherion(player: OmeggaPlayer, amount: number) {
    console.log("Entered cmdAetherion");
    for (let index = 0; index < amount; index++) {
      const planet = this.getRandomInt(1, 10)
      const size = this.getRandomInt(1, 4);

      let planetString = `${planet} (shouldn't see this)`;
      let sizeString = "";

      switch (planet) {
        case 5:
          planetString = "Eryndor 1";
          break;
        case 1:
          planetString = "Eryndor 1";
          break;
        case 2:
          planetString = "Eryndor 2";
          break;
        case 3:
          planetString = "Veylara";
          break;
        case 4:
          planetString = "Eryndor 4";
          break;
        case 6:
          planetString = "Eryndor 6";
          break;
        case 7:
          planetString = "Eryndor 7";
          break;
        case 8:
          planetString = "Eryndor 8";
          break;
        case 9:
          planetString = "Eryndor 9";
          break;
        case 10:
          planetString = "Eryndor 10";
          break;
      }

      switch (size) {
        case 1:
          sizeString = "Major Deposit";
          break;
        case 2:
          sizeString = "Minor Deposit";
          break;
        case 3:
          sizeString = "Minor Crystal";
          break;
        case 4:
          sizeString = "Major Crystal";
          break;
      }

      this.omegga.whisper(player, this.formattedMessage(`${sizeString}(${size}) on ${planetString}`));
    }
  }

  async handleRPChatMessages(player: OmeggaPlayer, message: string) {
    const writeToChatLog = async (event: Record<string, string>) => {
      const roomPrefs = await this.store.get("playerRoomPreferences");
      const playerPref = roomPrefs.find(e => e.playerId == player.id);

      const fileName = playerPref.room == Rooms.fantasy ? await this.store.get("currentFileForFantasyRPChat") : await this.store.get("currentFileForSpaceRPChat");

      const message = `${event.dateTime}\n[${event.user}]: ${event.message}`

      let currentMessages = await this.store.get("messagesToSendViaWebhook");
      currentMessages.push(message);
      this.store.set("messagesToSendViaWebhook", currentMessages);

      if (fileName != null) {
        appendFileSync(fileName, message + "\n", "utf8");
      }
      else {
        const currentDate = new Date();
        const newFileName = `${playerPref.room == Rooms.fantasy ? "FANTASY-" : "SPACE-"}RPChatLog-${this.formatDateForFilename(currentDate)}.md`;
        if (playerPref.room == Rooms.fantasy) {
          this.store.set("currentFileForFantasyRPChat", newFileName);
        } else {
          this.store.set("currentFileForSpaceRPChat", newFileName);
        }

        writeFileSync(newFileName, message, "utf8");
      }

      this.omegga.middlePrint(player, `<size="8"><color="${this.merpaverseColour}">MERPaverse</> Chat Message Logged</>`)
    }

    const currentDate = new Date();
    writeToChatLog({ dateTime: currentDate.toLocaleString("en-GB"), user: player.name, message: message });
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
    commandsList.map(message => {
      this.omegga.whisper(player, message);
    });
  }

  async cmdHandleChat(player: OmeggaPlayer, option: string) {
    let players = await this.store.get("playersInRPChat");

    if (option === null || option === undefined || option === "") {
      this.omegga.whisper(player, this.formattedMessage("Option <b>required</> for RP Command"));
      console.warn(player.name + " tried to do the RP command without an option.");
      return;
    }

    if (["join", "j"].includes(option.toLowerCase())) {
      if (players.includes(player.id)) {
        this.omegga.whisper(player, this.formattedMessage("You are already in the RP chat"));
        return;
      }

      players.push(player.id);
      console.log(`Player ${player.name} has joined RP Chat.`);
      this.updatePlayerRoomPref(player, Rooms.space);
      this.store.set("playersInRPChat", players);
      this.omegga.whisper(player, this.formattedMessage(`You have <color="#17ad3f">joined</> the RP Chat.`));

    } else if (["leave", "l"].includes(option.toLowerCase())) {
      players = players.filter(e => e != player.id);
      this.store.set("playersInRPChat", players);
      console.log(`Player ${player.name} has left RP Chat.`);
      this.omegga.whisper(player, this.formattedMessage(`You have <color="#ad1313">left</> the RP Chat.`));

      if (players.length < 1) {
        console.log("Clearing RP File Name");
        this.store.set("currentFileForSpaceRPChat", null);
      }
    } else if (["info", "i"].includes(option.toLowerCase())) {
      this.omegga.whisper(player, this.formattedMessage("Players currently in RP Chat:"));
      players.map((p) => {
        const pPlayer = this.omegga.getPlayer(p);
        this.omegga.whisper(player, `<color="${pPlayer.getNameColor()}">${pPlayer.name}</>`);
      });
    } else if (["clear", "c"].includes(option.toLowerCase())) {
      if (player.getRoles().includes("GM")) {
        this.store.set("playersInRPChat", null);
        try {
          const fileName = await this.store.get("currentFileForSpaceRPChat");
          appendFileSync(fileName, "]");

        } catch (e) {
          console.error("Last person left RP chat but file didn't exist.");
        } finally {
          this.store.set("currentFileForSpaceRPChat", null);
        }
      } else {
        this.omegga.whisper(player, this.formattedMessage("Unauthorised"));
      }
    } else if (["space", "s"].includes(option.toLowerCase())) {
      this.updatePlayerRoomPref(player, Rooms.space);
    } else if (["fantasy", "f"].includes(option.toLowerCase())) {
      this.updatePlayerRoomPref(player, Rooms.fantasy);
    }
  }

  async updatePlayerRoomPref(player: OmeggaPlayer, room: Rooms) {
    const roomPrefs = await this.store.get("playerRoomPreferences");
    const playerPref = roomPrefs.find(e => e.playerId == player.id);
    if (playerPref === undefined) {
      const updatedArray = [...roomPrefs, { playerId: player.id, room }];
      this.store.set("playerRoomPreferences", updatedArray);
      writeFileSync(PLAYER_PREFS_FILE_PATH, JSON.stringify(updatedArray), "utf-8");
    } else {
      playerPref.room = room;
      let updatedArray = roomPrefs.filter(e => e.playerId != player.id);
      updatedArray.push(playerPref);
      this.store.set("playerRoomPreferences", updatedArray);
      writeFileSync(PLAYER_PREFS_FILE_PATH, JSON.stringify(updatedArray), "utf-8");
    }

    room == Rooms.fantasy ? this.omegga.whisper(player, this.formattedMessage("You have joined the <b>Fantasy</> room.")) : this.omegga.whisper(player, this.formattedMessage("You have joined the <b>Space</> room."))
  }

  async cmdCombatRoll(player: OmeggaPlayer, av: number, ap: number) {
    const player1Name = `<color="${player.getNameColor()}">${player.name}</>`;
    this.omegga.broadcast(this.formattedMessage(`${player1Name} is making a combat roll (attacking).`));

    // player running the command
    let attacker = this.getRandomInt(3, 18);
    const defender = this.getRandomInt(3, 18);

    if (ap > av) {
      const difference = ap - av;
      this.omegga.broadcast(this.formattedMessage(`<color="#de6b00">AP</> > <color="#dbc60b">AV</> applying a +${difference} to attacker roll.`));
      attacker += difference;
      if (attacker > 18) {
        attacker = 18;
      }
    }

    if (attacker === 3) {
      this.omegga.broadcast(this.formattedMessage(`${player1Name} rolled a <b>Critical Fail</>. No damage taken.`));
    }
    else if (defender === 3) {
      this.omegga.broadcast(this.formattedMessage(`Defender rolled a <b>Critical Fail</>. Double damage taken.`));
    }
    else if (attacker === 18) {
      const critDamage = ap + 1;
      this.omegga.broadcast(this.formattedMessage(`${player1Name} rolled a <b>Critical Hit</>. Damage resolved at ${critDamage > 8 ? "Double Damage" : `<color="#de6b00">AP</>: ${critDamage}`}.`));
    }
    else if (defender >= attacker) {
      this.omegga.broadcast(this.formattedMessage(`${player1Name}: ${attacker} vs. Defender: ${defender}. No damage taken.`));
    } else {
      this.omegga.broadcast(this.formattedMessage(`${player1Name}: ${attacker} vs. Defender: ${defender}. Damage taken.`));
    }
  }

  getRandomInt(min: number, max: number): number {
    // Inclusive of both min and max
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  async stop() {
    // this.announcementTimeouts.map((timeout) => {
    //   clearTimeout(timeout);
    // });
  }
}
