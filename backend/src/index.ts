import express, { Request, Response } from "express";
import { createServer } from "http";
import { Server, Socket } from "socket.io";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// In-memory storage for boards
const boards: { [roomId: string]: { lines: any[]; shapes: any[] } } = {};

// User management
interface User {
  id: string;
  name: string;
  color: string;
  cursor: { x: number; y: number } | null;
  isActive: boolean;
  lastSeen: number;
  socketId: string;
}

const rooms: { [roomId: string]: User[] } = {};

// Predefined colors for users to ensure variety
const userColors = [
  "#FF6B6B",
  "#4ECDC4",
  "#45B7D1",
  "#96CEB4",
  "#FFEAA7",
  "#DDA0DD",
  "#98D8C8",
  "#F7DC6F",
  "#BB8FCE",
  "#85C1E9",
  "#F39C12",
  "#E74C3C",
  "#9B59B6",
  "#3498DB",
  "#1ABC9C",
];

// Get next available color for a room
const getNextAvailableColor = (roomId: string): string => {
  const room = rooms[roomId] || [];
  const usedColors = room.map((u) => u.color);

  for (const color of userColors) {
    if (!usedColors.includes(color)) {
      return color;
    }
  }

  // If all colors are used, generate a random one
  return `#${Math.floor(Math.random() * 16777215).toString(16)}`;
};

// Test route
app.get("/", (req: Request, res: Response) => {
  res.send("Collaborative Whiteboard Backend is running");
});

io.on("connection", (socket: Socket) => {
  console.log(`User connected: ${socket.id}`);
  let currentUser: User | null = null;
  let currentRoom: string | null = null;

  socket.on("joinRoom", ({ roomId, user }: { roomId: string; user: User }) => {
    socket.join(roomId);
    currentRoom = roomId;

    // Add user to room
    if (!rooms[roomId]) {
      rooms[roomId] = [];
    }

    // Check if user already exists in the room
    const existingUserIndex = rooms[roomId].findIndex((u) => u.id === user.id);

    if (existingUserIndex !== -1) {
      // User exists, update their socket and status
      const existingUser = rooms[roomId][existingUserIndex];
      if (existingUser) {
        existingUser.socketId = socket.id;
        existingUser.lastSeen = Date.now();
        existingUser.isActive = true;
        existingUser.cursor = user.cursor || existingUser.cursor;

        currentUser = existingUser;

        console.log(
          `User ${user.name} (${user.id}) reconnected to room ${roomId}`
        );
      }
    } else {
      // Assign a unique color if user doesn't have one or if it conflicts
      let userColor = user.color;
      if (!userColor || rooms[roomId].some((u) => u.color === userColor)) {
        userColor = getNextAvailableColor(roomId);
      }

      const userWithSocket: User = {
        ...user,
        color: userColor,
        socketId: socket.id,
        lastSeen: Date.now(),
        isActive: true,
      };

      currentUser = userWithSocket;
      rooms[roomId].push(userWithSocket);

      console.log(
        `User ${user.name} (${user.id}) joined room ${roomId} with color ${userColor}`
      );
    }

    console.log(`Room ${roomId} now has ${rooms[roomId].length} users`);

    // Initialize board if it doesn't exist
    if (!boards[roomId]) {
      boards[roomId] = { lines: [], shapes: [] };
    }

    // Send existing board state
    socket.emit("loadBoard", boards[roomId]);

    // Send current user list to the joining user
    socket.emit("userList", rooms[roomId]);

    // Notify other users in the room
    socket.to(roomId).emit("userJoined", currentUser);
  });

  socket.on(
    "cursorMove",
    ({
      roomId,
      userId,
      cursor,
    }: {
      roomId: string;
      userId: string;
      cursor: { x: number; y: number };
    }) => {
      if (currentRoom !== roomId || !currentUser) return;

      const room = rooms[roomId];
      if (!room) return;

      // Find and update user's cursor in the room
      const userIndex = room.findIndex((u) => u.id === userId);
      if (userIndex >= 0 && userIndex < room.length) {
        const targetUser = room[userIndex];
        if (targetUser) {
          targetUser.cursor = cursor;
          targetUser.lastSeen = Date.now();

          // Broadcast cursor update to other users in the room
          socket.to(roomId).emit("cursorUpdate", { userId, cursor });
        }
      }
    }
  );

  socket.on(
    "leaveRoom",
    ({ roomId, userId }: { roomId: string; userId: string }) => {
      const room = rooms[roomId];
      if (!room) return;

      rooms[roomId] = room.filter((u) => u.id !== userId);
      const updatedRoom = rooms[roomId];
      const remaining = Array.isArray(updatedRoom) ? updatedRoom.length : 0;

      console.log(
        `User ${userId} left room ${roomId}. Room now has ${remaining} users`
      );

      // Notify other users
      socket.to(roomId).emit("userLeft", userId);
    }
  );

  socket.on(
    "draw",
    ({ roomId, strokeData }: { roomId: string; strokeData: any }) => {
      // Add stroke to board
      if (!boards[roomId]) {
        boards[roomId] = { lines: [], shapes: [] };
      }

      // Determine if it's a line or shape and add to appropriate array
      if (strokeData.tool === "pen" || strokeData.points) {
        boards[roomId].lines.push(strokeData);
      } else if (
        strokeData.type === "rectangle" ||
        strokeData.type === "circle"
      ) {
        boards[roomId].shapes.push(strokeData);
      }

      // Broadcast to other users in the room
      socket.to(roomId).emit("draw", strokeData);
    }
  );

  socket.on("clearBoard", ({ roomId }: { roomId: string }) => {
    // Clear the board
    boards[roomId] = { lines: [], shapes: [] };

    // Broadcast clear to all users in the room
    io.to(roomId).emit("clearBoard");
  });

  socket.on(
    "updateBoard",
    ({
      roomId,
      lines,
      shapes,
    }: {
      roomId: string;
      lines: any[];
      shapes: any[];
    }) => {
      // Update the board with new state
      boards[roomId] = { lines, shapes };

      // Broadcast the updated board to all users in the room
      socket.to(roomId).emit("updateBoard", { lines, shapes });
    }
  );

  socket.on("disconnect", () => {
    console.log(`User disconnected: ${socket.id}`);

    // Clean up user from room
    const roomId = currentRoom;
    const user = currentUser;
    if (!roomId || !user) return;

    const room = rooms[roomId];
    if (!room) return;

    // Check if this socket is still the current one for this user
    const userInRoom = room.find((u) => u.id === user.id);
    if (userInRoom && userInRoom.socketId === socket.id) {
      // This is the current socket, remove the user
      rooms[roomId] = room.filter((u) => u.id !== user.id);
      const updatedRoom = rooms[roomId];
      const remaining = Array.isArray(updatedRoom) ? updatedRoom.length : 0;
      console.log(
        `User ${user.name} disconnected from room ${roomId}. Room now has ${remaining} users`
      );

      // Notify other users
      socket.to(roomId).emit("userLeft", user.id);
    } else {
      // This is an old socket, just log it
      console.log(`Old socket ${socket.id} disconnected for user ${user.name}`);
    }
  });
});

const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// Periodic cleanup of inactive users
setInterval(() => {
  const now = Date.now();
  const timeout = 30000; // 30 seconds

  Object.keys(rooms).forEach((roomId) => {
    const room = rooms[roomId];
    if (!room) return;

    const activeUsers = room.filter((user) => now - user.lastSeen < timeout);

    if (activeUsers.length !== room.length) {
      rooms[roomId] = activeUsers;
      console.log(
        `Room ${roomId}: Cleaned up inactive users. Now has ${activeUsers.length} active users.`
      );

      // Notify remaining users about cleanup
      io.to(roomId).emit("userList", activeUsers);
    }
  });
}, 10000); // Check every 10 seconds
