import type { InitConfig } from '@aries-framework/core'

import { readFileSync } from 'fs'
import { resolve } from 'path'

import {
  Agent,
  ConsoleLogger,
  HttpOutboundTransport,
  LogLevel,
  MediatorPickupStrategy,
  WsOutboundTransport,
} from '@aries-framework/core'
import { agentDependencies } from '@aries-framework/node'

// Agent similar to mobile agent, which doesn't have http inbound transport supported
export default class EdgeAgentBase {
  public agent!: Agent
  public agentConfig: InitConfig

  public constructor(walletId: string) {
    this.agentConfig = {
      label: 'Experiment Edge Agent::' + walletId,
      walletConfig: {
        id: walletId,
        key: 'pw',
      },
      indyLedgers: [
        {
          genesisPath: resolve(__dirname, 'trential.dev.ledger'),
          id: 'Trential Dev',
          isProduction: false,
        },
      ],
      logger: new ConsoleLogger(LogLevel.debug),
      mediatorConnectionsInvite: readFileSync(resolve(__dirname, '.invitation', 'mediator')).toString(),
      mediatorPickupStrategy: MediatorPickupStrategy.PickUpV2,
    }
  }

  public async start() {
    this.agent = new Agent(this.agentConfig, agentDependencies)

    const httpOutboundTransport = new HttpOutboundTransport()
    const wsOutboundTransport = new WsOutboundTransport()
    this.agent.registerOutboundTransport(httpOutboundTransport)
    this.agent.registerOutboundTransport(wsOutboundTransport)

    console.log(`Starting edge agent...`)
    await this.agent.initialize()
  }
}
