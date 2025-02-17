import type { AgentDependencies } from './AgentDependencies'
import type { AgentModulesInput } from './AgentModules'
import type { AgentMessageReceivedEvent } from './Events'
import type { InboundTransport } from '../transport/InboundTransport'
import type { OutboundTransport } from '../transport/OutboundTransport'
import type { InitConfig } from '../types'
import type { Subscription } from 'rxjs'

import { Subject } from 'rxjs'
import { mergeMap, takeUntil } from 'rxjs/operators'

import { CacheRepository } from '../cache'
import { InjectionSymbols } from '../constants'
import { SigningProviderToken } from '../crypto'
import { JwsService } from '../crypto/JwsService'
import { AriesFrameworkError } from '../error'
import { DependencyManager } from '../plugins'
import { DidCommMessageRepository, StorageUpdateService, StorageVersionRepository } from '../storage'
import { InMemoryMessageRepository } from '../storage/InMemoryMessageRepository'
import { IndyStorageService } from '../storage/IndyStorageService'
import { IndyWallet } from '../wallet/IndyWallet'

import { AgentConfig } from './AgentConfig'
import { extendModulesWithDefaultModules } from './AgentModules'
import { BaseAgent } from './BaseAgent'
import { Dispatcher } from './Dispatcher'
import { EnvelopeService } from './EnvelopeService'
import { EventEmitter } from './EventEmitter'
import { AgentEventTypes } from './Events'
import { FeatureRegistry } from './FeatureRegistry'
import { MessageHandlerRegistry } from './MessageHandlerRegistry'
import { MessageReceiver } from './MessageReceiver'
import { MessageSender } from './MessageSender'
import { TransportService } from './TransportService'
import { AgentContext, DefaultAgentContextProvider } from './context'

interface AgentOptions<AgentModules extends AgentModulesInput> {
  config: InitConfig
  modules?: AgentModules
  dependencies: AgentDependencies
}

// Any makes sure you can use Agent as a type without always needing to specify the exact generics for the agent
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class Agent<AgentModules extends AgentModulesInput = any> extends BaseAgent<AgentModules> {
  public messageSubscription: Subscription

  public constructor(options: AgentOptions<AgentModules>, dependencyManager = new DependencyManager()) {
    const agentConfig = new AgentConfig(options.config, options.dependencies)
    const modulesWithDefaultModules = extendModulesWithDefaultModules(agentConfig, options.modules)

    // Register internal dependencies
    dependencyManager.registerSingleton(MessageHandlerRegistry)
    dependencyManager.registerSingleton(EventEmitter)
    dependencyManager.registerSingleton(MessageSender)
    dependencyManager.registerSingleton(MessageReceiver)
    dependencyManager.registerSingleton(TransportService)
    dependencyManager.registerSingleton(Dispatcher)
    dependencyManager.registerSingleton(EnvelopeService)
    dependencyManager.registerSingleton(FeatureRegistry)
    dependencyManager.registerSingleton(JwsService)
    dependencyManager.registerSingleton(CacheRepository)
    dependencyManager.registerSingleton(DidCommMessageRepository)
    dependencyManager.registerSingleton(StorageVersionRepository)
    dependencyManager.registerSingleton(StorageUpdateService)

    // This is a really ugly hack to make tsyringe work without any SigningProviders registered
    // It is currently impossible to use @injectAll if there are no instances registered for the
    // token. We register a value of `default` by default and will filter that out in the registry.
    // Once we have a signing provider that should always be registered we can remove this. We can make an ed25519
    // signer using the @stablelib/ed25519 library.
    dependencyManager.registerInstance(SigningProviderToken, 'default')

    dependencyManager.registerInstance(AgentConfig, agentConfig)
    dependencyManager.registerInstance(InjectionSymbols.AgentDependencies, agentConfig.agentDependencies)
    dependencyManager.registerInstance(InjectionSymbols.Stop$, new Subject<boolean>())
    dependencyManager.registerInstance(InjectionSymbols.FileSystem, new agentConfig.agentDependencies.FileSystem())

    // Register possibly already defined services
    if (!dependencyManager.isRegistered(InjectionSymbols.Wallet)) {
      dependencyManager.registerContextScoped(InjectionSymbols.Wallet, IndyWallet)
    }
    if (!dependencyManager.isRegistered(InjectionSymbols.Logger)) {
      dependencyManager.registerInstance(InjectionSymbols.Logger, agentConfig.logger)
    }
    if (!dependencyManager.isRegistered(InjectionSymbols.StorageService)) {
      dependencyManager.registerSingleton(InjectionSymbols.StorageService, IndyStorageService)
    }
    if (!dependencyManager.isRegistered(InjectionSymbols.MessageRepository)) {
      dependencyManager.registerSingleton(InjectionSymbols.MessageRepository, InMemoryMessageRepository)
    }

    // Register all modules. This will also include the default modules
    dependencyManager.registerModules(modulesWithDefaultModules)

    // TODO: contextCorrelationId for base wallet
    // Bind the default agent context to the container for use in modules etc.
    dependencyManager.registerInstance(
      AgentContext,
      new AgentContext({
        dependencyManager,
        contextCorrelationId: 'default',
      })
    )

    // If no agent context provider has been registered we use the default agent context provider.
    if (!dependencyManager.isRegistered(InjectionSymbols.AgentContextProvider)) {
      dependencyManager.registerSingleton(InjectionSymbols.AgentContextProvider, DefaultAgentContextProvider)
    }

    super(agentConfig, dependencyManager)

    const stop$ = this.dependencyManager.resolve<Subject<boolean>>(InjectionSymbols.Stop$)

    // Listen for new messages (either from transports or somewhere else in the framework / extensions)
    this.messageSubscription = this.eventEmitter
      .observable<AgentMessageReceivedEvent>(AgentEventTypes.AgentMessageReceived)
      .pipe(
        takeUntil(stop$),
        mergeMap((e) =>
          this.messageReceiver
            .receiveMessage(e.payload.message, {
              connection: e.payload.connection,
              contextCorrelationId: e.payload.contextCorrelationId,
            })
            .catch((error) => {
              this.logger.error('Failed to process message', { error })
            })
        )
      )
      .subscribe()
  }

  public registerInboundTransport(inboundTransport: InboundTransport) {
    this.messageReceiver.registerInboundTransport(inboundTransport)
  }

  public get inboundTransports() {
    return this.messageReceiver.inboundTransports
  }

  public registerOutboundTransport(outboundTransport: OutboundTransport) {
    this.messageSender.registerOutboundTransport(outboundTransport)
  }

  public get outboundTransports() {
    return this.messageSender.outboundTransports
  }

  public get events() {
    return this.eventEmitter
  }

  /**
   * Agent's feature registry
   */
  public get features() {
    return this.featureRegistry
  }

  public async initialize(offline = false) {
    await super.initialize()

    // set the pools on the ledger.
    this.ledger.setPools(this.ledger.config.indyLedgers)
    // As long as value isn't false we will async connect to all genesis pools on startup
    if (this.ledger.config.connectToIndyLedgersOnStartup) {
      this.ledger.connectToPools().catch((error) => {
        this.logger.warn('Error connecting to ledger, will try to reconnect when needed.', { error })
      })
    }

    for (const transport of this.inboundTransports) {
      await transport.start(this)
    }

    for (const transport of this.outboundTransports) {
      await transport.start(this)
    }

    if (!offline) {
      // Connect to mediator through provided invitation if provided in config
      // Also requests mediation ans sets as default mediator
      // Because this requires the connections module, we do this in the agent constructor
      if (this.mediationRecipient.config.mediatorInvitationUrl) {
        this.logger.debug('Provision mediation with invitation', {
          mediatorInvitationUrl: this.mediationRecipient.config.mediatorInvitationUrl,
        })
        const mediationConnection = await this.getMediationConnection(
          this.mediationRecipient.config.mediatorInvitationUrl
        )
        await this.mediationRecipient.provision(mediationConnection)
      }
      await this.mediator.initialize()
      await this.mediationRecipient.initialize()
    }

    this._isInitialized = true
  }

  public async shutdown() {
    const stop$ = this.dependencyManager.resolve<Subject<boolean>>(InjectionSymbols.Stop$)
    // All observables use takeUntil with the stop$ observable
    // this means all observables will stop running if a value is emitted on this observable
    stop$.next(true)

    // Stop transports
    const allTransports = [...this.inboundTransports, ...this.outboundTransports]
    const transportPromises = allTransports.map((transport) => transport.stop())
    await Promise.all(transportPromises)

    if (this.wallet.isInitialized) {
      await this.wallet.close()
    }

    this._isInitialized = false
  }

  protected async getMediationConnection(mediatorInvitationUrl: string) {
    const outOfBandInvitation = await this.oob.parseInvitation(mediatorInvitationUrl)
    const outOfBandRecord = await this.oob.findByReceivedInvitationId(outOfBandInvitation.id)
    const [connection] = outOfBandRecord ? await this.connections.findAllByOutOfBandId(outOfBandRecord.id) : []

    if (!connection) {
      this.logger.debug('Mediation connection does not exist, creating connection')
      // We don't want to use the current default mediator when connecting to another mediator
      const routing = await this.mediationRecipient.getRouting({ useDefaultMediator: false })

      this.logger.debug('Routing created', routing)
      const { connectionRecord: newConnection } = await this.oob.receiveInvitation(outOfBandInvitation, {
        routing,
      })
      this.logger.debug(`Mediation invitation processed`, { outOfBandInvitation })

      if (!newConnection) {
        throw new AriesFrameworkError('No connection record to provision mediation.')
      }

      return this.connections.returnWhenIsConnected(newConnection.id)
    } else if (outOfBandRecord && !connection.isReady) {
      this.logger.debug('Retrying connection with mediator')
      const routing = await this.mediationRecipient.getRouting({ useDefaultMediator: false })
      const { connectionRecord: newConnection } = await this.oob.acceptInvitation(outOfBandRecord.id, {
        routing,
        autoAcceptConnection: true,
      })
      if (!newConnection) {
        throw new AriesFrameworkError('No connection record to provision mediation.')
      }
      return this.connections.returnWhenIsConnected(newConnection.id)
    }
    return connection
  }
}
