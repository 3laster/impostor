// --- pełny plik ---
import { io } from "/socket.io/socket.io.esm.min.js"; // socket.io serwuje ESM od v4.7

const socket = io({ autoConnect: true });

// UI helpers
const $ = (sel) => document.querySelector(sel);
const show = (el) => el.classList.remove("hidden");
const hide = (el) => el.classList.add("hidden");
const setText = (el, t) => (el.textContent = t);

// Elements
const joinSec = $("#join");
const lobbySec = $("#lobby");
const gameSec = $("#game");

const nickInput = $("#nick");
const roomInput = $("#room");
const joinBtn = $("#btnJoin");
const joinError = $("#joinError");
const createBtn = $("#btnCreate");

const playersUl = $("#players");
const roomCodeBadge = $("#roomCodeBadge");
const copyBtn = $("#btnCopy");
const leaveBtn = $("#btnLeave");

const hostPanel = $("#hostPanel");
const nonHostHint = $("#nonHostHint");
const customWordInput = $("#customWord");
const startBtn = $("#btnStart");
const startError = $("#startError");

const roleP = $("#role");
const wordWrap = $("#wordWrap");
const wordDiv = $("#word");
const wordLen = $("#wordLen");
const backBtn = $("#btnBackToLobby");
const resetBtn = $("#btnReset");

const readyVoteBtn = $("#btnReadyVote");
const votingPanel = $("#votingPanel");
const voteList = $("#voteList");
const castVoteBtn = $("#btnCastVote");
const voteError = $("#voteError");

// Local state
let state = {
  roomCode: "",
  isHost: false
};

// Generate / fill room code
createBtn.addEventListener("click", () => {
  socket.emit("createRoomCode");
});

// Create callback
socket.on("roomCodeCreated", (code) => {
  roomInput.value = code;
  roomInput.focus();
});

// --- WSPÓLNE RENDEROWANIE LOBBY ---
function renderLobby({ roomCode, players, hostId, started }) {
  if (roomCode !== state.roomCode) return;

  playersUl.innerHTML = "";
  for (const p of players) {
    const li = document.createElement("li");
    li.textContent = p.name + (p.id === hostId ? " (host)" : "");
    playersUl.appendChild(li);
  }

  // jeśli host odszedł a my nim zostaliśmy
  if (socket.id === hostId) {
    state.isHost = true;
    hostPanel.classList.remove("hidden");
    nonHostHint.classList.add("hidden");
    resetBtn.classList.remove("hidden");
  }
}

// Join room
joinBtn.addEventListener("click", () => {
  const name = nickInput.value.trim();
  const roomCode = roomInput.value.trim().toUpperCase();

  joinError.textContent = "";
  if (!name) return (joinError.textContent = "Podaj nick.");
  if (!roomCode || roomCode.length < 4) return (joinError.textContent = "Podaj poprawny kod pokoju.");

  socket.emit("joinRoom", { roomCode, name }, (res) => {
    if (!res?.ok) {
      joinError.textContent = res?.error || "Nie udało się dołączyć.";
      return;
    }
    state.roomCode = roomCode;
    state.isHost = !!res.isHost;
    roomCodeBadge.textContent = roomCode;

    hide(joinSec);
    show(lobbySec);
    hostPanel.classList.toggle("hidden", !state.isHost);
    nonHostHint.classList.toggle("hidden", state.isHost);

    // Natychmiastowy snapshot lobby
    if (res.lobby) renderLobby(res.lobby);
  });
});

// Copy room code
copyBtn.addEventListener("click", async () => {
  const code = state.roomCode;
  try {
    await navigator.clipboard.writeText(code);
    copyBtn.textContent = "Skopiowano!";
    setTimeout(() => (copyBtn.textContent = "Kopiuj kod"), 1200);
  } catch {}
});

// Leave lobby
leaveBtn.addEventListener("click", () => {
  if (!state.roomCode) return;

  socket.emit("leaveRoom", { roomCode: state.roomCode }, () => {
    // lokalny reset stanu/UI
    state = { roomCode: "", isHost: false };
    playersUl.innerHTML = "";
    customWordInput.value = "";
    roomInput.value = "";
    joinError.textContent = "";

    hide(lobbySec);
    hide(gameSec);
    show(joinSec);
    resetBtn.classList.add("hidden");
    readyVoteBtn.disabled = false;
    readyVoteBtn.textContent = "Głosuj";
    votingPanel.classList.add("hidden");
    castVoteBtn.disabled = false;
    castVoteBtn.textContent = "Oddaj głos";
  });
});

// Lobby updates (używamy wspólnej funkcji)
socket.on("lobbyUpdate", (payload) => {
  renderLobby(payload);
});

// Start game
startBtn.addEventListener("click", () => {
  startError.textContent = "";
  socket.emit(
    "startGame",
    { roomCode: state.roomCode, customWord: customWordInput.value.trim() || null },
    (res) => {
      if (!res?.ok) startError.textContent = res?.error || "Błąd startu.";
    }
  );
});

// Receive role + word
socket.on("gameStarted", ({ role, word, wordLength }) => {
  setText(roleP, role === "impostor" ? "Jesteś IMPOSTOREM – nie znasz słowa!" : "Jesteś ZAŁOGANTEM.");
  if (word) {
    setText(wordDiv, word);
    setText(wordLen, `Długość słowa: ${wordLength}`);
    show(wordWrap);
  } else {
    hide(wordWrap);
    setText(wordLen, "");
  }

  hide(lobbySec);
  show(gameSec);
  resetBtn.classList.toggle("hidden", !state.isHost);

  // reset panelu głosowania na start rundy
  readyVoteBtn.disabled = false;
  readyVoteBtn.textContent = "Głosuj";
  votingPanel.classList.add("hidden");
  castVoteBtn.disabled = false;
  castVoteBtn.textContent = "Oddaj głos";
  voteList.innerHTML = "";
  voteError.textContent = "";
});

// Reset (host)
resetBtn.addEventListener("click", () => {
  socket.emit("resetGame", { roomCode: state.roomCode }, (res) => {
    // opcjonalnie pokaż info
  });
});

socket.on("gameReset", () => {
  customWordInput.value = "";
  hide(gameSec);
  show(lobbySec);
  // reset panelu głosowania
  readyVoteBtn.disabled = false;
  readyVoteBtn.textContent = "Głosuj";
  votingPanel.classList.add("hidden");
  castVoteBtn.disabled = false;
  castVoteBtn.textContent = "Oddaj głos";
  voteList.innerHTML = "";
  voteError.textContent = "";
});

// Back to lobby (lokalnie – jeśli runda trwa, to tylko podgląd)
backBtn.addEventListener("click", () => {
  hide(gameSec);
  show(lobbySec);
});

// ----- GŁOSOWANIE -----
let selectedTarget = null;

// Klik „Głosuj” (zgłoszenie gotowości do głosowania)
readyVoteBtn.addEventListener("click", () => {
  if (!state.roomCode) return;
  readyVoteBtn.disabled = true;
  readyVoteBtn.textContent = "Czekam na większość…";
  socket.emit("readyToVote", { roomCode: state.roomCode }, (res) => {
    if (!res?.ok) {
      readyVoteBtn.disabled = false;
      readyVoteBtn.textContent = "Głosuj";
    }
  });
});

// Licznik gotowości (opcjonalne UX)
socket.on("readyCount", ({ count, required }) => {
  if (readyVoteBtn.disabled) {
    readyVoteBtn.textContent = `Czekam na większość… (${count}/${required})`;
  }
});

// Start głosowania — render listy
socket.on("votingStarted", ({ players }) => {
  voteError.textContent = "";
  voteList.innerHTML = "";
  selectedTarget = null;

  votingPanel.classList.remove("hidden");

  players.forEach((p) => {
    if (p.id === socket.id) return; // pozwól/nie pozwól na głos na siebie
    const li = document.createElement("li");
    const label = document.createElement("label");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "voteTarget";
    radio.value = p.id;
    radio.addEventListener("change", () => (selectedTarget = p.id));
    label.appendChild(radio);
    label.appendChild(document.createTextNode(" " + p.name));
    li.appendChild(label);
    voteList.appendChild(li);
  });
});

// Oddanie głosu
castVoteBtn.addEventListener("click", () => {
  voteError.textContent = "";
  if (!selectedTarget) {
    voteError.textContent = "Wybierz gracza.";
    return;
  }
  socket.emit("castVote", { roomCode: state.roomCode, targetId: selectedTarget }, (res) => {
    if (!res?.ok) {
      voteError.textContent = res?.error || "Nie udało się oddać głosu.";
      return;
    }
    castVoteBtn.disabled = true;
  });
});

// Postęp głosowania (opcjonalny)
socket.on("voteProgress", ({ voted, total }) => {
  castVoteBtn.textContent = `Oddaj głos (${voted}/${total})`;
});

// Koniec głosowania — wynik
socket.on("votingEnded", ({ winnerId, winnerName, isImpostor, tally }) => {
  votingPanel.classList.add("hidden");
  castVoteBtn.disabled = false;
  castVoteBtn.textContent = "Oddaj głos";
  readyVoteBtn.disabled = false;
  readyVoteBtn.textContent = "Głosuj";

  if (winnerId) {
    alert(`Wybrany: ${winnerName} (${isImpostor ? "IMPOSTOR" : "nie impostor"})`);
  } else {
    alert("Remis — brak wyrzuconego gracza.");
  }
});

// Przyjazne defaulty
nickInput.addEventListener("keydown", (e) => e.key === "Enter" && roomInput.focus());
roomInput.addEventListener("keydown", (e) => e.key === "Enter" && joinBtn.click());
