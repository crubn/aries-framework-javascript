import {
    Agent,
    AutoAcceptProof,
    BaseEvent,
    CredentialMetadataKeys,
    HandshakeProtocol,
    LogLevel,
    OutOfBandDidCommService,
    OutOfBandInvitation,
    PresentationPreview,
    PresentationPreviewAttribute,
    ProofEventTypes,
    ProofRecord, 
    ProofRepository,
    ProofRequest,
    ProofService,
    ProofState,
    ProposePresentationMessage} from '@aries-framework/core'
import EdgeAgentBase from "./edge-agent";
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { TestLogger } from 'packages/core/tests/logger';

const holder = new EdgeAgentBase("alice")
holder.agentConfig.logger = new TestLogger(LogLevel.debug)
// holder.agentConfig.concurrency = 2
// holder.agentConfig.logger = undefined

const credentialId = '618570e9-49c4-4923-8dd5-6213096e0a40'

const service = {
    "id": "#inline-0",
    "serviceEndpoint": "http://localhost:3001",
    "type": "did-communication",
    "recipientKeys": [
      "did:key:z6Mko8MPqoFUgdyaB3UGgZsqFeJGrPCawGW9VgoSHVcR8iMB"
    ],
    "routingKeys": [
      "did:key:z6MknWo6Ksk3U8v4Jtqw5yPp6pFz7FuoA26KVuCvEkXdehYR"
    ]
}

holder.start()
.then(async ()=>{
    const agent = holder.agent
    agent.events.on(ProofEventTypes.ProofStateChanged, handlePresentProof(agent))
    await createProposal(agent, credentialId, ["name","age"])
})

async function createProposal(agent: Agent, credId: string, revealedFields: string[]){
    const cred = await agent.credentials.getById(credId)
    if (!cred){
        throw new Error('credential not found')
    }
    const md = cred.metadata.get(CredentialMetadataKeys.IndyCredential)
    if (!md){
        return
    }
    const credDefId = md.credentialDefinitionId
    const attributes: PresentationPreviewAttribute[] = []

    const aux: {[x:string]: boolean} = {}
    revealedFields.forEach((name)=>{
        aux[name] = true
    })

    if (!cred.credentialAttributes){
        return
    }
    
    cred.credentialAttributes.forEach((attr)=>{
        if (aux[attr.name]){
            attributes.push(new PresentationPreviewAttribute({
                name: attr.name,
                mimeType: attr.mimeType,
                credentialDefinitionId: credDefId
            }))
        }
    })
    // const multiUseInvitation = await agent.oob.createInvitation({
    //     handshakeProtocols: [HandshakeProtocol.Connections],
    //     autoAcceptConnection: true,
    //     multiUseInvitation: true,
    // })
    // console.log(JSON.stringify(multiUseInvitation.outOfBandInvitation.toJSON(), null, 2))
    // return

    const proposalMessage = new ProposePresentationMessage({
        presentationProposal: new PresentationPreview({
            attributes: attributes
        })
    })

    const proofRecord = new ProofRecord({
        threadId: proposalMessage.threadId,
        parentThreadId: proposalMessage.thread?.parentThreadId,
        state: ProofState.ProposalSent,
        proposalMessage: proposalMessage,
        autoAcceptProof: AutoAcceptProof.Always,
    })
    const proofRepository = agent.dependencyManager.resolve(ProofRepository)
    await proofRepository.save(proofRecord)

    const oobInvitation = new OutOfBandInvitation({
        label: agent.config.label,
        handshakeProtocols: [HandshakeProtocol.Connections],
        services: [ new OutOfBandDidCommService(service)]
    })
    oobInvitation.addRequest(proposalMessage)

    // const oobMessage = await agent.oob.createInvitation({
    //     messages: [proposalMessage],
    //     handshakeProtocols: [HandshakeProtocol.Connections],
    //     autoAcceptConnection: true,
    //   })
    
    const oobInvitationUrl = oobInvitation.toUrl({ domain: service.serviceEndpoint })

    writeFileSync(
        resolve(__dirname, '.invitation', 'proactive-proof'),
        oobInvitationUrl
    )
    console.log("Proactive proof created")
}

function handlePresentProof(agent: Agent){
    const proofRepository = agent.dependencyManager.resolve(ProofRepository)
    const proofService = agent.dependencyManager.resolve(ProofService)
    return async (event: BaseEvent)=>{
        const requestRecord = event.payload.proofRecord as ProofRecord
        if (requestRecord.state == ProofState.RequestReceived){
            const proofRecords = await proofRepository.findByQuery({threadId: requestRecord.threadId})
            const proposalRecord = proofRecords.find((record)=>{
                return record.state == ProofState.ProposalSent
            })
            if (!proposalRecord){
                return
            }
            proposalRecord.requestMessage = requestRecord.requestMessage
            proposalRecord.state = ProofState.RequestReceived
            proposalRecord.connectionId = requestRecord.connectionId
            await Promise.all([
                proofRepository.update(proposalRecord),
                proofRepository.deleteById(requestRecord.id)
            ])

            const indyProofRequest = proposalRecord.requestMessage?.indyProofRequest
            const presentationProposal = proposalRecord.proposalMessage?.presentationProposal

            const retrievedCredentials = await proofService.getRequestedCredentialsForProofRequest(indyProofRequest as ProofRequest, {
                presentationProposal: presentationProposal
            })
            const requestedCredentials = proofService.autoSelectCredentialsForProofRequest(retrievedCredentials)
            await agent.proofs.acceptRequest(proposalRecord.id, requestedCredentials)
        }
    }
}