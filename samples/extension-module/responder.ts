import type { DummyStateChangedEvent } from './dummy'
import type { Socket } from 'net'

import { Agent, ConsoleLogger, LogLevel } from '@aries-framework/core'
import { agentDependencies, HttpInboundTransport, WsInboundTransport } from '@aries-framework/node'
import express from 'express'
import { Server } from 'ws'

import { DummyModule, DummyEventTypes, DummyState } from './dummy'

const run = async () => {
  // Create transports
  const port = process.env.RESPONDER_PORT ? Number(process.env.RESPONDER_PORT) : 3002
  const autoAcceptRequests = true
  const app = express()
  const socketServer = new Server({ noServer: true })

  const httpInboundTransport = new HttpInboundTransport({ app, port })
  const wsInboundTransport = new WsInboundTransport({ server: socketServer })

  // Setup the agent
  const agent = new Agent({
    config: {
      label: 'Dummy-powered agent - responder',
      endpoints: [`http://localhost:${port}`],
      walletConfig: {
        id: 'responder',
        key: 'responder',
      },
      logger: new ConsoleLogger(LogLevel.debug),
      autoAcceptConnections: true,
    },
    modules: {
      dummy: new DummyModule({ autoAcceptRequests }),
    },
    dependencies: agentDependencies,
  })

  // Register transports
  agent.registerInboundTransport(httpInboundTransport)
  agent.registerInboundTransport(wsInboundTransport)

  // Allow to create invitation, no other way to ask for invitation yet
  app.get('/invitation', async (req, res) => {
    const { outOfBandInvitation } = await agent.oob.createInvitation()
    res.send(outOfBandInvitation.toUrl({ domain: `http://localhost:${port}/invitation` }))
  })

  // Now agent will handle messages and events from Dummy protocol

  //Initialize the agent
  await agent.initialize()

  httpInboundTransport.server?.on('upgrade', (request, socket, head) => {
    socketServer.handleUpgrade(request, socket as Socket, head, (socket) => {
      socketServer.emit('connection', socket, request)
    })
  })

  // If autoAcceptRequests is enabled, the handler will automatically respond
  // (no need to subscribe to event and manually accept)
  if (!autoAcceptRequests) {
    agent.events.on(DummyEventTypes.StateChanged, async (event: DummyStateChangedEvent) => {
      if (event.payload.dummyRecord.state === DummyState.RequestReceived) {
        await agent.modules.dummy.respond(event.payload.dummyRecord.id)
      }
    })
  }

  agent.config.logger.info(`Responder listening to port ${port}`)
}

void run()
