import type { DeliveryRequestMessage, MessagesReceivedMessage, StatusRequestMessage } from './messages'
import type { InboundMessageContext } from '../../../../../agent/models/InboundMessageContext'
import type { EncryptedMessage } from '../../../../../types'

import { Dispatcher } from '../../../../../agent/Dispatcher'
import { OutboundMessageContext } from '../../../../../agent/models'
import { InjectionSymbols } from '../../../../../constants'
import { Attachment } from '../../../../../decorators/attachment/Attachment'
import { AriesFrameworkError } from '../../../../../error'
import { inject, injectable } from '../../../../../plugins'
import { MessageRepository } from '../../../../../storage/MessageRepository'
import { MediationRecipientService } from '../../../services'

import {
  DeliveryRequestHandler,
  MessageDeliveryHandler,
  MessagesReceivedHandler,
  StatusHandler,
  StatusRequestHandler,
} from './handlers'
import { MessageDeliveryMessage, StatusMessage } from './messages'

@injectable()
export class V2MessagePickupService {
  private messageRepository: MessageRepository
  private dispatcher: Dispatcher
  private mediationRecipientService: MediationRecipientService

  public constructor(
    @inject(InjectionSymbols.MessageRepository) messageRepository: MessageRepository,
    dispatcher: Dispatcher,
    mediationRecipientService: MediationRecipientService
  ) {
    this.messageRepository = messageRepository
    this.dispatcher = dispatcher
    this.mediationRecipientService = mediationRecipientService

    this.registerMessageHandlers()
  }

  public async processStatusRequest(messageContext: InboundMessageContext<StatusRequestMessage>) {
    // Assert ready connection
    const connection = messageContext.assertReadyConnection()

    if (messageContext.message.recipientKey) {
      throw new AriesFrameworkError('recipient_key parameter not supported')
    }

    const statusMessage = new StatusMessage({
      threadId: messageContext.message.threadId,
      messageCount: await this.messageRepository.getAvailableMessageCount(connection.id),
    })

    return new OutboundMessageContext(statusMessage, { agentContext: messageContext.agentContext, connection })
  }

  public async queueMessage(connectionId: string, message: EncryptedMessage) {
    await this.messageRepository.add(connectionId, message)
  }

  public async processDeliveryRequest(messageContext: InboundMessageContext<DeliveryRequestMessage>) {
    // Assert ready connection
    const connection = messageContext.assertReadyConnection()

    if (messageContext.message.recipientKey) {
      throw new AriesFrameworkError('recipient_key parameter not supported')
    }

    const { message } = messageContext

    // Get available messages from queue, but don't delete them
    const messages = await this.messageRepository.takeFromQueue(connection.id, message.limit, true)

    // TODO: each message should be stored with an id. to be able to conform to the id property
    // of delivery message
    const attachments = messages.map(
      (msg) =>
        new Attachment({
          data: {
            json: msg,
          },
        })
    )

    const outboundMessageContext =
      messages.length > 0
        ? new MessageDeliveryMessage({
            threadId: messageContext.message.threadId,
            attachments,
          })
        : new StatusMessage({
            threadId: messageContext.message.threadId,
            messageCount: 0,
          })

    return new OutboundMessageContext(outboundMessageContext, { agentContext: messageContext.agentContext, connection })
  }

  public async processMessagesReceived(messageContext: InboundMessageContext<MessagesReceivedMessage>) {
    // Assert ready connection
    const connection = messageContext.assertReadyConnection()

    const { message } = messageContext

    // TODO: Add Queued Message ID
    await this.messageRepository.takeFromQueue(
      connection.id,
      message.messageIdList ? message.messageIdList.length : undefined
    )

    const statusMessage = new StatusMessage({
      threadId: messageContext.message.threadId,
      messageCount: await this.messageRepository.getAvailableMessageCount(connection.id),
    })

    return new OutboundMessageContext(statusMessage, { agentContext: messageContext.agentContext, connection })
  }

  protected registerMessageHandlers() {
    this.dispatcher.registerMessageHandler(new StatusRequestHandler(this))
    this.dispatcher.registerMessageHandler(new DeliveryRequestHandler(this))
    this.dispatcher.registerMessageHandler(new MessagesReceivedHandler(this))
    this.dispatcher.registerMessageHandler(new StatusHandler(this.mediationRecipientService))
    this.dispatcher.registerMessageHandler(new MessageDeliveryHandler(this.mediationRecipientService))
  }
}
