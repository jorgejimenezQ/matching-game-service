/**
 * Simple Express server running a socket.io server
 * to handle the communication between the server and the client
 *
 */
import express from 'express'
import cors from 'cors'
import { createServer } from 'http'
import { Server } from 'socket.io'
import Game from './Game.js'
import { captureRejectionSymbol } from 'events'
import { v4 } from 'uuid'

const app = express()
// app.use(cors())

const PORT = process.env.PORT || 8000

const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: {
    origin: '*',
  },
})

const games = {}
let connections = []

// const adminEventsEmitter = new EventEmitter()
const adminConnections = new Map()

io.use((socket, next) => {
  console.log('socket.handshake.auth', socket.handshake.auth)
  const { connectionId, admin, key } = socket.handshake.auth

  // If the connection has an admin key, it is an admin connection
  if (admin) {
    if (key === process.env.ADMIN_KEY) {
      adminEventsEmitter.emit('adminConnected', socket)
      adminConnections.set(socket.id, { socket })
    }
  }

  if (!connectionId) return next(new Error('invalid connectionId'))
  socket.connectionId = connectionId
  connections.push(connectionId)
  console.log('player connected: ' + connectionId)
  next()
})

io.on('connection', (socket) => {
  socket.on('disconnect', () => {
    // Remove the player from the game
    const game = games[socket.sessionId]
    console.log('player disconnected: ', games)
    if (game) {
      game.removePlayer(socket.connectionId)
      if (game.numberOfPlayers === 0) {
        delete games[socket.sessionId]
      }
    }

    // Filter out the disconnected player
    connections = connections.filter((connection) => connection !== socket.connectionId)

    if (adminConnections.has(socket.id)) {
      // Delete it
      adminConnections.delete(socket.id)
    }

    adminConnections.forEach((admin) => {
      admin.socket.emit('admin_updateData', { games: games, connections: connections })
    })
    console.log('player disconnected: ', games)
  })

  socket.on('playerReady', (callback) => {
    const game = games[socket.sessionId]
    if (!game) return
    const player = game.players[socket.connectionId]
    if (!player) return
    player.ready = true

    if (game.gameFull()) {
      // Check if both players are ready
      const playerKeys = Object.keys(game.players)
      const ready = playerKeys.every((key) => game.players[key].ready)
      const firstPlayer = playerKeys[Math.floor(Math.random() * playerKeys.length)]

      // If all players are ready, start the game
      if (ready) {
        // Start the game
        io.to(socket.sessionId).emit('startGame', {
          players: game.players,
          firstPlayer,
        })
      }
    }

    adminConnections.forEach((admin) => {
      admin.socket.emit('admin_updateData', { games: games, connections: connections })
    })

    callback({ players: player.connectionId })
  })

  // Finds a game for the player. If there is no game available, it creates a new one
  socket.on('join', (data, callback) => {
    const username = data.username
    const isInvite = data.isInvite
    const sessionId = data.sessionId
    const createInvite = data.createInvite
    let game = null

    // If the player is invited to a game, find the game
    // Otherwise, find an available game
    if (isInvite) game = games[sessionId]
    else if (!createInvite) game = findAvailableGame()

    if (!game) {
      game = new Game()
      games[game.sessionId] = game

      // Is this an invite?
      if (createInvite) game.isInvite = true
    }

    // If the player is already in the game, don't add them again
    if (!game.players[socket.connectionId])
      game.addPlayer(socket.connectionId, username, socket.connectionId)
    socket.join(game.sessionId)
    socket.sessionId = game.sessionId

    adminConnections.forEach((admin) => {
      console.log(admin.socket.connectionId)
      admin.socket.emit('admin_updateData', { games: games, connections: connections })
    })
    // Send the game to the player
    callback({ sessionId: game.sessionId, cardIndexes: game.cardIndexes })
  })

  socket.on('restartGame', () => {
    socket.emit('mainScene')
  })

  socket.on('turnOver', (data) => {
    socket.to(socket.sessionId).emit('playerTurn', data)
  })
  socket.on('match', () => {
    // Add score to the player
    const game = games[socket.sessionId]
    game.players[socket.connectionId].score++
    socket.to(socket.sessionId).emit('addScore')
    game.pairsRemaining--
    let winner = null

    // Is the game over?
    if (games[socket.sessionId].pairsRemaining === 0) {
      // Find the winner
      const playerKeys = Object.keys(game.players)
      const playerOne = game.players[playerKeys[0]]
      const playerTwo = game.players[playerKeys[1]]

      if (playerOne.score > playerTwo.score) winner = playerOne
      else if (playerOne.score === playerTwo.score) winner = 'draw'
      else winner = playerTwo

      // If a game invite set players to not ready, so they can play again
      if (game.isInvite) {
        game.players[playerKeys[0]].ready = false
        game.players[playerKeys[1]].ready = false
      }

      adminConnections.forEach((admin) => {
        admin.socket.emit('admin_updateData', { games: games, connections: connections })
      })

      // Wait two seconds before sending the winner
      setTimeout(() => {
        io.to(socket.sessionId).emit('gameOver', winner.connectionId)
        // Delete the game

        // If the game is not an invite, delete it
        if (!game.isInvite) delete games[socket.sessionId]
      }, 2000)

      return
    }
  })
  socket.on('cardClick', (data) => {
    socket.to(socket.sessionId).emit('flipCard', data)
  })

  socket.on('adminLogin', (data, callback) => {
    console.log(data)
    console.log(process.env.ADMIN_KEY)
    if (data == process.env.ADMIN_KEY) {
      const uid = v4()
      adminConnections.set(socket.connectionId, { socket, uid })
      callback({ success: true, message: null, games: games, connections: connections, uid: uid })
    } else {
      callback({ success: false, message: 'Unable to connect to admin server' })
    }
  })

  socket.on('admin_getServerInfo', (data, callback) => {
    console.log(data)
    const admin = adminConnections.get(socket.connectionId)
    if (admin && admin.uid === data) {
      callback({ success: true, message: null, games: games, connections: connections })
    } else {
      callback({ success: false, message: 'Unable to connect to admin server' })
    }
  })
})

// Returns a game with available players
const findAvailableGame = () => {
  const keys = Object.keys(games)
  let game = null
  keys.forEach((key) => {
    if (!games[key].gameFull() && !games[key].isInvite) {
      game = games[key]
    }
  })
  return game
}

const findInviteGame = (gameSession) => {
  const keys = Object.keys(games)
  let game = null
  keys.forEach((key) => {
    if (games[key].isInvite && games[key].sessionId === gameSession) {
      game = games[key]
    }
  })

  return game
}

/********************************** */
/********************************** */
httpServer.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`)
})
