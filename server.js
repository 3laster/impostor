// --- pełny plik ---
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { customAlphabet } from "nanoid";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" }
});

const nanoid = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6);

app.use(express.static("public"));

/** Prosta „baza” w pamięci */
const rooms = new Map();
/*
  rooms: Map<roomCode, {
    hostId: string,
    started: boolean,
    word: string | null,
    players: Map<socketId, { name: string, isImpostor: boolean }>,
    phase: "lobby" | "round" | "voting",
    readySet: Set<string>,
    votes: Map<socketId, number>,
    hasVoted: Set<socketId>
  }>
*/

function getPlayersArray(room) {
  return Array.from(room.players.entries()).map(([id, p]) => ({
    id, name: p.name
  }));
}

function broadcastLobby(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  io.to(roomCode).emit("lobbyUpdate", {
    roomCode,
    players: getPlayersArray(room),
    hostId: room.hostId,
    started: room.started
  });
}

function majorityCount(room) {
  const n = room.players.size;
  return Math.floor(n / 2) + 1; // prosta większość
}

function beginVoting(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  room.phase = "voting";
  room.votes = new Map();
  room.hasVoted = new Set();
  const players = Array.from(room.players.entries()).map(([id, p]) => ({ id, name: p.name }));
  io.to(roomCode).emit("votingStarted", { roomCode, players });
}

function endVoting(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  // policz max (prosty wybór większościowy; remis = brak zwycięzcy)
  let winnerId = null, winnerCount = 0;
  for (const [targetId, count] of room.votes.entries()) {
    if (count > winnerCount) {
      winnerCount = count;
      winnerId = targetId;
    } else if (count === winnerCount) {
      // remis -> brak zwycięzcy
      winnerId = null;
    }
  }

  const tally = Object.fromEntries(room.votes.entries());
  const winner = winnerId ? room.players.get(winnerId) : null;

  io.to(roomCode).emit("votingEnded", {
    roomCode,
    winnerId,
    winnerName: winnerId ? winner?.name : null,
    isImpostor: winnerId ? !!winner?.isImpostor : null,
    tally
  });

  // wracamy do fazy rundy
  room.phase = "round";
  room.readySet.clear();
  room.votes.clear();
  room.hasVoted.clear();
}

io.on("connection", (socket) => {
  // Klient może poprosić o nowy kod pokoju
  socket.on("createRoomCode", () => {
    const code = nanoid();
    socket.emit("roomCodeCreated", code);
  });

  // Dołącz do pokoju
  socket.on("joinRoom", ({ roomCode, name }, ack) => {
    if (!roomCode || !name) return ack?.({ ok: false, error: "Brak danych." });

    // Utwórz pokój, jeśli nie istnieje
    if (!rooms.has(roomCode)) {
      rooms.set(roomCode, {
        hostId: socket.id,
        started: false,
        word: null,
        players: new Map(),
        phase: "lobby",
        readySet: new Set(),
        votes: new Map(),
        hasVoted: new Set()
      });
    }
    const room = rooms.get(roomCode);

    // Jeśli gra już trwa, nie wpuszczaj nowych
    if (room.started) {
      return ack?.({ ok: false, error: "Runda już trwa. Poczekaj na następną." });
    }

    socket.join(roomCode);
    room.players.set(socket.id, { name: String(name).slice(0, 24), isImpostor: false });

    // Jeśli host odszedł wcześniej, a pokój istniał — ustaw hosta, jeśli puste
    if (!room.hostId || !room.players.has(room.hostId)) {
      room.hostId = socket.id;
    }

    const lobby = {
      roomCode,
      players: getPlayersArray(room),
      hostId: room.hostId,
      started: room.started
    };
    broadcastLobby(roomCode);
    return ack?.({ ok: true, isHost: socket.id === room.hostId, lobby });
  });

  // Start gry (tylko host)
  socket.on("startGame", ({ roomCode, customWord }, ack) => {
    const room = rooms.get(roomCode);
    if (!room) return ack?.({ ok: false, error: "Pokój nie istnieje." });
    if (socket.id !== room.hostId) return ack?.({ ok: false, error: "Tylko host może startować grę." });
    if (room.started) return ack?.({ ok: false, error: "Gra już wystartowała." });

    const players = Array.from(room.players.keys());
    if (players.length < 3) {
      return ack?.({ ok: false, error: "Potrzebujesz min. 3 graczy." });
    }

    const words = [
      "rower", "tornado", "klawiatura", "pizza", "stadion", "teatr", "astronauta",
      "biblioteka", "dżungla", "mikrofon", "bank", "zamek", "lody", "robot", "most"
    ];
    const word = (customWord && String(customWord).trim()) || words[Math.floor(Math.random() * words.length)];

    // Wylosuj impostora
    const impostorId = players[Math.floor(Math.random() * players.length)];
    for (const [id, p] of room.players) {
      p.isImpostor = id === impostorId;
    }

    room.started = true;
    room.word = word;
    room.phase = "round";
    room.readySet.clear();
    room.votes.clear();
    room.hasVoted.clear();

    // Wyślij tajne role i słowa
    for (const [id, p] of room.players) {
      const payload = {
        role: p.isImpostor ? "impostor" : "crewmate",
        word: p.isImpostor ? null : word,
        wordLength: word.length
      };
      io.to(id).emit("gameStarted", payload);
    }
    broadcastLobby(roomCode);
    return ack?.({ ok: true });
  });

  // Zakończ/Reset (tylko host)
  socket.on("resetGame", ({ roomCode }, ack) => {
    const room = rooms.get(roomCode);
    if (!room) return ack?.({ ok: false, error: "Pokój nie istnieje." });
    if (socket.id !== room.hostId) return ack?.({ ok: false, error: "Tylko host może resetować." });

    room.started = false;
    room.word = null;
    room.phase = "lobby";
    room.readySet.clear();
    room.votes.clear();
    room.hasVoted.clear();
    for (const p of room.players.values()) p.isImpostor = false;

    io.to(roomCode).emit("gameReset");
    broadcastLobby(roomCode);
    return ack?.({ ok: true });
  });

  // Opuść pokój (na żądanie klienta)
  socket.on("leaveRoom", ({ roomCode }, ack) => {
    const room = rooms.get(roomCode);
    if (!room) return ack?.({ ok: true }); // nic do zrobienia

    if (room.players.has(socket.id)) {
      socket.leave(roomCode);
      room.players.delete(socket.id);

      if (room.players.size === 0) {
        rooms.delete(roomCode);
      } else {
        // jeśli host odszedł — wybierz nowego hosta
        if (room.hostId === socket.id) {
          const [newHostId] = room.players.keys();
          room.hostId = newHostId;
        }
        broadcastLobby(roomCode);
      }
    }
    return ack?.({ ok: true });
  });

  // Gotowość do głosowania
  socket.on("readyToVote", ({ roomCode }, ack) => {
    const room = rooms.get(roomCode);
    if (!room) return ack?.({ ok: false, error: "Pokój nie istnieje." });
    if (room.phase !== "round") return ack?.({ ok: false, error: "Nie w tej fazie." });
    if (!room.players.has(socket.id)) return ack?.({ ok: false, error: "Nie jesteś w tym pokoju." });

    room.readySet.add(socket.id);

    // licznik postępu
    io.to(roomCode).emit("readyCount", { count: room.readySet.size, required: majorityCount(room) });

    if (room.readySet.size >= majorityCount(room)) {
      beginVoting(roomCode);
    }
    return ack?.({ ok: true });
  });

  // Oddanie głosu
  socket.on("castVote", ({ roomCode, targetId }, ack) => {
    const room = rooms.get(roomCode);
    if (!room) return ack?.({ ok: false, error: "Pokój nie istnieje." });
    if (room.phase !== "voting") return ack?.({ ok: false, error: "Głosowanie nie trwa." });
    if (!room.players.has(socket.id)) return ack?.({ ok: false, error: "Nie jesteś w tym pokoju." });
    if (!room.players.has(targetId)) return ack?.({ ok: false, error: "Nieprawidłowy cel." });
    if (room.hasVoted.has(socket.id)) return ack?.({ ok: false, error: "Już głosowałeś." });

    room.hasVoted.add(socket.id);
    room.votes.set(targetId, (room.votes.get(targetId) || 0) + 1);

    // postęp
    io.to(roomCode).emit("voteProgress", {
      voted: room.hasVoted.size,
      total: room.players.size
    });

    // większość dla targetu
    if (room.votes.get(targetId) >= majorityCount(room)) {
      endVoting(roomCode);
      return ack?.({ ok: true });
    }

    // albo wszyscy zagłosowali
    if (room.hasVoted.size === room.players.size) {
      endVoting(roomCode);
      return ack?.({ ok: true });
    }

    return ack?.({ ok: true });
  });

  // Gdy ktoś się rozłącza
  socket.on("disconnect", () => {
    // Znajdź pokój, z którego odchodzi gracz
    for (const [roomCode, room] of rooms.entries()) {
      if (!room.players.has(socket.id)) continue;

      // Usuń gracza
      room.players.delete(socket.id);

      // Jeśli pusto — usuń pokój
      if (room.players.size === 0) {
        rooms.delete(roomCode);
        continue;
      }

      // Jeśli host odszedł — wybierz nowego hosta
      if (room.hostId === socket.id) {
        const [newHostId] = room.players.keys();
        room.hostId = newHostId;
      }

      // Jeżeli ktoś odpadł w trakcie "voting", sprawdź czy wszyscy już zagłosowali / większość
      if (room.phase === "voting") {
        room.readySet.delete(socket.id);
        room.hasVoted.delete(socket.id);
        let maxVotes = 0;
        for (const cnt of room.votes.values()) {
          if (cnt > maxVotes) maxVotes = cnt;
        }
        if (maxVotes >= majorityCount(room) || room.hasVoted.size === room.players.size) {
          endVoting(roomCode);
          continue;
        }
      }

      broadcastLobby(roomCode);
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`✔ Serwer działa na http://localhost:${PORT}`);
});
