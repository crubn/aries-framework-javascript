import EdgeAgentBase from './edge-agent'
import { AutoAcceptProof, BaseEvent, LogLevel, PresentationMessage, ProofEventTypes, ProofRecord, ProofState } from '@aries-framework/core'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { TestLogger } from 'packages/core/tests/logger'

const verifier = new EdgeAgentBase("bob")

verifier.agentConfig.autoAcceptProofs = AutoAcceptProof.Always
verifier.agentConfig.logger = new TestLogger(LogLevel.debug)
// verifier.agentConfig.logger = undefined

verifier.start()
.then(async ()=>{
    const agent = verifier.agent
    agent.events.on(ProofEventTypes.ProofStateChanged, (event: BaseEvent)=>{
        const record = event.payload.proofRecord as ProofRecord
        if (record.state == ProofState.Done){
            const attrsMetadata = record.proposalMessage?.presentationProposal.attributes
            const presentation = new PresentationMessage(record.presentationMessage as PresentationMessage)
            const attrs = presentation.indyProof?.requested_proof.revealed_attrs
      
            if (!attrs) {
              return
            }
            const revealedAttr = attrsMetadata?.map((md) => {
              return {
                key: md.name,
                mimeType: md.mimeType,
                value: attrs[md.referent as string].raw,
              }
            })
            console.log("Received proof presentation")
            console.log(JSON.stringify(revealedAttr))
        }
    })
    const invitation = readFileSync(resolve(__dirname,'.invitation', 'proactive-proof')).toString()
    await agent.oob.receiveInvitationFromUrl(invitation, {autoAcceptConnection: true, reuseConnection: false})
})