import fs from "node:fs";
import path from "node:path";
class ChannelState {
  constructor(stateDir, accountId) {
    this.stateDir = stateDir;
    this.accountId = accountId;
    this.syncFile = path.join(stateDir, `${accountId}.sync.json`);
    this.contextTokensFile = path.join(stateDir, `${accountId}.context-tokens.json`);
    this.sessionsFile = path.join(stateDir, "sessions.json");
    fs.mkdirSync(stateDir, { recursive: true });
  }
  /** The getupdates cursor, seeded once from the OpenClaw sync file. */
  loadSyncBuf(seedFrom) {
    const mine = this.#readJson(this.syncFile);
    if (mine && typeof mine.get_updates_buf === "string") return mine.get_updates_buf;
    if (seedFrom) {
      const theirs = this.#readJson(seedFrom);
      if (theirs && typeof theirs.get_updates_buf === "string") {
        this.saveSyncBuf(theirs.get_updates_buf);
        return theirs.get_updates_buf;
      }
    }
    return "";
  }
  saveSyncBuf(buf) {
    this.#writeJson(this.syncFile, { get_updates_buf: buf ?? "", updatedAt: Date.now() });
  }
  /** Per-user context token (must be echoed when replying to that user). */
  loadContextTokens() {
    const raw = this.#readJson(this.contextTokensFile);
    return raw && typeof raw === "object" ? raw : {};
  }
  saveContextToken(userId, token) {
    const tokens = this.loadContextTokens();
    tokens[userId] = token;
    this.#writeJson(this.contextTokensFile, tokens);
  }
  /** WeChat peer key → DSH session id mapping. */
  loadSessionMap() {
    const raw = this.#readJson(this.sessionsFile);
    return raw && typeof raw === "object" ? raw : {};
  }
  saveSessionMapEntry(peerKey, sessionId, { cwd, agentPreset } = {}) {
    const map = this.loadSessionMap();
    map[peerKey] = {
      sessionId,
      cwd: cwd ?? null,
      agentPreset: agentPreset ?? null,
      createdAt: map[peerKey]?.createdAt ?? Date.now(),
      updatedAt: Date.now()
    };
    this.#writeJson(this.sessionsFile, map);
  }
  removeSessionMapEntry(peerKey) {
    const map = this.loadSessionMap();
    delete map[peerKey];
    this.#writeJson(this.sessionsFile, map);
  }
  #readJson(file) {
    try {
      if (!fs.existsSync(file)) return void 0;
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      return void 0;
    }
  }
  #writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
    fs.renameSync(tmp, file);
  }
}
export {
  ChannelState
};
