import type { MessageHandler, MessageHandlerInboundMessage } from '../../../agent/MessageHandler'
import type { MessageSender } from '../../../agent/MessageSender'
import type { MessageRepository } from '../../../storage/MessageRepository'
import type { ConnectionService } from '../../connections/services'
import type { MediatorService } from '../services'

import { OutboundMessageContext } from '../../../agent/models'
import { InjectionSymbols } from '../../../constants'
import { V3ForwardMessage } from '../../message-pìckup/protocol/v3/V3ForwardMessage'
import { ForwardMessage } from '../messages'

export class ForwardHandler implements MessageHandler {
  private mediatorService: MediatorService
  private connectionService: ConnectionService
  private messageSender: MessageSender

  public supportedMessages = [ForwardMessage]

  public constructor(
    mediatorService: MediatorService,
    connectionService: ConnectionService,
    messageSender: MessageSender
  ) {
    this.mediatorService = mediatorService
    this.connectionService = connectionService
    this.messageSender = messageSender
  }

  public async handle(messageContext: MessageHandlerInboundMessage<ForwardHandler>) {
    const { encryptedMessage, mediationRecord } = await this.mediatorService.processForwardMessage(messageContext)
    const connectionRecord = await this.connectionService.getById(
      messageContext.agentContext,
      mediationRecord.connectionId
    )
    const messageRepository = messageContext.agentContext.dependencyManager.resolve(
      InjectionSymbols.MessageRepository
    ) as MessageRepository
    if (messageRepository.addForwardMessage) {
      const id = await messageRepository.addForwardMessage(connectionRecord.id, encryptedMessage)
      await this.messageSender.sendMessage(
        new OutboundMessageContext(
          new V3ForwardMessage({
            id: id,
            message: encryptedMessage,
          }),
          {
            agentContext: messageContext.agentContext,
            connection: connectionRecord,
          }
        )
      )
    } else {
      // The message inside the forward message is packed so we just send the packed
      // message to the connection associated with it
      await this.messageSender.sendPackage(messageContext.agentContext, {
        connection: connectionRecord,
        encryptedMessage,
      })
    }
  }
}
