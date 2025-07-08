const express = require("express");
const { initializeApp } = require("firebase/app");
const {
  getDatabase,
  ref,
  set,
  onValue,
  remove,
  update,
} = require("firebase/database");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const path = require("path");

const app = express();

app.use(express.static(path.join(__dirname, "public")));
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyB4glQi5Lrq-npooa64Ea3cMhdndyZ-Yzw",
  authDomain: "neon-tic-tac-toe-multiplayer.firebaseapp.com",
  databaseURL:
    "https://neon-tic-tac-toe-multiplayer-default-rtdb.firebaseio.com",
  projectId: "neon-tic-tac-toe-multiplayer",
  storageBucket: "neon-tic-tac-toe-multiplayer.firebasestorage.app",
  messagingSenderId: "573997273297",
  appId: "1:573997273297:web:dfa4d1dd31bf0a245d35f0",
};

// Initialize Firebase
const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp);

// Middleware
app.use(cors());
app.use(express.json());

// API Endpoints
app.get("/health", (req, res) => {
  res.status(200).json({ status: "OK" });
});

// Socket.IO connection handling
io.on("connection", (socket) => {
  console.log("New client connected:", socket.id);

  // Create new room
  socket.on("createRoom", async (roomId, playerId, callback) => {
    try {
      const roomRef = ref(db, `rooms/${roomId}`);
      await set(roomRef, {
        players: {
          [playerId]: { symbol: "X", socketId: socket.id },
        },
        board: Array(9).fill(""),
        currentPlayer: "X",
        gameActive: true,
        createdAt: Date.now(),
      });
      socket.join(roomId);
      callback({ success: true, symbol: "X" });
      io.to(roomId).emit("roomUpdate", {
        roomId,
        players: { [playerId]: "X" },
      });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  // Join existing room
  socket.on("joinRoom", async (roomId, playerId, callback) => {
    try {
      const roomRef = ref(db, `rooms/${roomId}`);
      const snapshot = await new Promise((resolve) =>
        onValue(roomRef, resolve, { onlyOnce: true })
      );
      const roomData = snapshot.val();

      if (!roomData) {
        callback({ success: false, error: "Room does not exist" });
        return;
      }

      if (Object.keys(roomData.players).length >= 2) {
        callback({ success: false, error: "Room is full" });
        return;
      }

      await update(roomRef, {
        [`players/${playerId}`]: { symbol: "O", socketId: socket.id },
      });

      socket.join(roomId);
      callback({ success: true, symbol: "O" });

      // Notify all players in room
      io.to(roomId).emit("roomUpdate", {
        roomId,
        players: {
          ...roomData.players,
          [playerId]: "O",
        },
      });

      // Start game if two players
      if (Object.keys(roomData.players).length === 1) {
        io.to(roomId).emit("gameStart", {
          board: roomData.board,
          currentPlayer: "X",
        });
      }
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  // Handle player move
  socket.on("makeMove", async ({ roomId, cellIndex, playerId }) => {
    try {
      const roomRef = ref(db, `rooms/${roomId}`);
      const snapshot = await new Promise((resolve) =>
        onValue(roomRef, resolve, { onlyOnce: true })
      );
      let roomData = snapshot.val();

      if (
        !roomData ||
        !roomData.gameActive ||
        roomData.board[cellIndex] !== ""
      ) {
        return;
      }

      if (roomData.players[playerId].symbol !== roomData.currentPlayer) {
        return;
      }

      // Update board
      roomData.board[cellIndex] = roomData.currentPlayer;
      roomData.currentPlayer = roomData.currentPlayer === "X" ? "O" : "X";

      await update(roomRef, {
        board: roomData.board,
        currentPlayer: roomData.currentPlayer,
      });

      // Broadcast move to all players in room
      io.to(roomId).emit("moveMade", {
        board: roomData.board,
        currentPlayer: roomData.currentPlayer,
        cellIndex,
        symbol: roomData.players[playerId].symbol,
      });

      // Check for win or draw
      const result = checkGameStatus(roomData.board);
      if (result.winner || result.draw) {
        await update(roomRef, { gameActive: false });
        io.to(roomId).emit("gameEnd", result);
      }
    } catch (error) {
      console.error("Error making move:", error);
    }
  });

  // Reset game
  socket.on("resetGame", async (roomId) => {
    try {
      const roomRef = ref(db, `rooms/${roomId}`);
      await update(roomRef, {
        board: Array(9).fill(""),
        currentPlayer: "X",
        gameActive: true,
      });

      io.to(roomId).emit("gameReset", {
        board: Array(9).fill(""),
        currentPlayer: "X",
      });
    } catch (error) {
      console.error("Error resetting game:", error);
    }
  });

  // Handle disconnect
  socket.on("disconnect", async () => {
    console.log("Client disconnected:", socket.id);
    // Find and remove player from room
    const roomsRef = ref(db, "rooms");
    const snapshot = await new Promise((resolve) =>
      onValue(roomsRef, resolve, { onlyOnce: true })
    );
    const rooms = snapshot.val();

    if (rooms) {
      for (const roomId in rooms) {
        const room = rooms[roomId];
        for (const playerId in room.players) {
          if (room.players[playerId].socketId === socket.id) {
            await remove(ref(db, `rooms/${roomId}/players/${playerId}`));
            io.to(roomId).emit("playerDisconnected", playerId);
            // Delete room if empty
            const updatedSnapshot = await new Promise((resolve) =>
              onValue(ref(db, `rooms/${roomId}`), resolve, { onlyOnce: true })
            );
            if (!updatedSnapshot.val()?.players) {
              await remove(ref(db, `rooms/${roomId}`));
            }
          }
        }
      }
    }
  });
});

// Check game status (same logic as frontend)
function checkGameStatus(board) {
  const winPatterns = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
  ];

  for (let pattern of winPatterns) {
    const [a, b, c] = pattern;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a], pattern };
    }
  }

  return { winner: null, draw: board.every((cell) => cell !== "") };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
