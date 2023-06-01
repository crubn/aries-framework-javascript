import { Expose } from 'class-transformer'

import { AgentMessage } from '../../../../agent/AgentMessage'
import { ReturnRouteTypes } from '../../../../decorators/transport/TransportDecorator'
import { EncryptedMessage } from '../../../../types'
import { IsValidMessageType, parseMessageType } from '../../../../utils/messageType'

export interface V3ForwardMessageOptions {
  id: string
  message: EncryptedMessage
}

export class V3ForwardMessage extends AgentMessage {
  public constructor(options?: V3ForwardMessageOptions) {
    super()
    if (options) {
      this.id = options.id
      this.message = options.message
    }
    this.setReturnRouting(ReturnRouteTypes.all)
  }

  @IsValidMessageType(V3ForwardMessage.type)
  public readonly type = V3ForwardMessage.type.messageTypeUri
  public static readonly type = parseMessageType('https://didcomm.org/messagepickup/3.0/forward')

  @Expose()
  public message!: EncryptedMessage
}
