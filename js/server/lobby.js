// ============================================================================
// Lobby System — Multiplayer match orchestration
// ============================================================================
import { ARENA_WIDTH, ARENA_HEIGHT, MAX_TICKS, TICK_RATE } from "../shared/config.js";
import { SeededRNG } from "../shared/prng.js";

/**
 * Assign a balanced team id to a player joining a lobby. 2v2 fills the
 * smaller team; free-for-all and 1v1 give the lowest unused id. Using a raw
 * `players.length` here mis-assigns teams after anyone leaves and rejoins.
 */
function assignTeamId(lobby) {
    if (lobby.mode === "2v2") {
        const counts = [0, 0];
        for (const p of lobby.players) {
            if (p.teamId === 0 || p.teamId === 1) counts[p.teamId]++;
        }
        return counts[0] <= counts[1] ? 0 : 1;
    }
    const used = new Set(lobby.players.map(p => p.teamId));
    let t = 0;
    while (used.has(t)) t++;
    return t;
}
/** Generate a 128-bit unguessable lobby ID. Sequential IDs let attackers
 *  brute-force a lobby's URL and join/spoof the match mid-flight. */
function generateLobbyId() {
    // Prefer WebCrypto when available (browser + Node >= 19 globalThis.crypto).
    const c = (typeof globalThis !== "undefined" && globalThis.crypto) ? globalThis.crypto : null;
    if (c && typeof c.getRandomValues === "function") {
        const bytes = new Uint8Array(16);
        c.getRandomValues(bytes);
        let hex = "";
        for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
        return `lobby_${hex}`;
    }
    // Fallback: two Math.random ints (not cryptographic, but unguessable
    // within a reasonable attack budget on a PoC deployment).
    const a = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
    const b = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
    return `lobby_${a}${b}`;
}

export class LobbyManager {
    lobbies = new Map();
    matchRunner;
    matchmaking;
    rng;
    constructor(matchRunner, matchmaking, seed) {
        this.matchRunner = matchRunner;
        this.matchmaking = matchmaking;
        // Lobby-owned PRNG for reproducible match seeds when seeded explicitly.
        this.rng = new SeededRNG((seed ?? Date.now()) >>> 0);
    }
    /** Create a new lobby */
    createLobby(hostId, name, mode = "1v1_unranked") {
        // Retry on the astronomically unlikely collision.
        let id = generateLobbyId();
        while (this.lobbies.has(id)) id = generateLobbyId();
        const maxPlayers = mode === "2v2" ? 4 : mode === "ffa" ? 8 : 2;
        const lobby = {
            id,
            name,
            host: hostId,
            mode,
            maxPlayers,
            players: [{
                    playerId: hostId,
                    ready: false,
                    teamId: 0,
                }],
            status: "waiting",
            createdAt: Date.now(),
        };
        this.lobbies.set(id, lobby);
        return lobby;
    }
    /** Join an existing lobby */
    joinLobby(lobbyId, playerId) {
        const lobby = this.lobbies.get(lobbyId);
        if (!lobby)
            return null;
        if (lobby.status !== "waiting")
            return null;
        if (lobby.players.length >= lobby.maxPlayers)
            return null;
        if (lobby.players.some(p => p.playerId === playerId))
            return null;
        lobby.players.push({
            playerId,
            ready: false,
            teamId: assignTeamId(lobby),
        });
        return lobby;
    }
    /** Leave a lobby (cannot leave during an active match) */
    leaveLobby(lobbyId, playerId) {
        const lobby = this.lobbies.get(lobbyId);
        if (!lobby)
            return false;
        if (lobby.status === "in_match")
            return false;
        lobby.players = lobby.players.filter(p => p.playerId !== playerId);
        if (lobby.players.length === 0) {
            this.lobbies.delete(lobbyId);
        }
        else if (lobby.host === playerId) {
            lobby.host = lobby.players[0].playerId;
        }
        return true;
    }
    /** Submit a bot program for a player in a lobby */
    submitProgram(lobbyId, playerId, program, constants) {
        const lobby = this.lobbies.get(lobbyId);
        if (!lobby)
            return false;
        const player = lobby.players.find(p => p.playerId === playerId);
        if (!player)
            return false;
        player.program = program;
        player.constants = constants;
        player.ready = true;
        // Check if all players are ready
        if (lobby.players.length >= 2 && lobby.players.every(p => p.ready && p.program)) {
            lobby.status = "ready";
        }
        return true;
    }
    /** Start the match when all players are ready (only host can start) */
    startMatch(lobbyId, playerId) {
        const lobby = this.lobbies.get(lobbyId);
        if (!lobby || lobby.status !== "ready")
            return null;
        // Only the host can start the match
        if (playerId != null && playerId !== lobby.host)
            return null;
        const readyPlayers = lobby.players
            .filter(p => p.program && p.constants)
            .map(p => ({
            playerId: p.playerId,
            program: p.program,
            constants: p.constants,
            teamId: p.teamId,
        }));
        if (readyPlayers.length < 2)
            return null;
        lobby.status = "in_match";
        const response = this.matchRunner.runUnrankedMatchWithParticipants({
            participants: readyPlayers,
            config: {
                mode: lobby.mode,
                arenaWidth: ARENA_WIDTH,
                arenaHeight: ARENA_HEIGHT,
                maxTicks: MAX_TICKS,
                tickRate: TICK_RATE,
                seed: this.rng.nextInt(0, 2147483647),
            },
        });
        lobby.status = "completed";
        lobby.matchResult = response;
        return response;
    }
    /** Clean up completed/stale lobbies */
    cleanup(maxAgeMs = 3600000) {
        const now = Date.now();
        for (const [id, lobby] of this.lobbies) {
            if (lobby.status === "completed" || (now - lobby.createdAt > maxAgeMs)) {
                this.lobbies.delete(id);
            }
        }
    }
    /** List open lobbies */
    listLobbies() {
        return [...this.lobbies.values()].filter(l => l.status === "waiting");
    }
    getLobby(id) {
        return this.lobbies.get(id);
    }
}
