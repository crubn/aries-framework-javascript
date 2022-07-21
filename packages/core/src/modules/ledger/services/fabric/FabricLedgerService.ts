import type { Logger } from '../../../../logger'
import type {
  LedgerService,
  SchemaTemplate,
  CredentialDefinitionTemplate,
  ParseRevocationRegistryDefinitionTemplate,
  ParseRevocationRegistryTemplate,
  ParseRevocationRegistryDeltaTemplate,
  IndyEndpointAttrib,
} from '../LedgerService'
import type { LedgerReadRequest, LedgerSuccessResponse } from './FabricPool'
import type { default as Indy, CredDef, LedgerRequest, NymRole } from 'indy-sdk'

import { Lifecycle, scoped } from 'tsyringe'

import { AgentConfig } from '../../../../agent/AgentConfig'
import { IndySdkError } from '../../../../error'
import { isIndyError } from '../../../../utils/indyError'
import { IndyWallet } from '../../../../wallet/IndyWallet'
import { IndyIssuerService } from '../../../indy'

import { FabricPool } from './FabricPool'

@scoped(Lifecycle.ContainerScoped)
export class FabricLedgerService implements LedgerService {
  private wallet: IndyWallet
  private indy: typeof Indy
  private logger: Logger

  private indyIssuer: IndyIssuerService
  private pool: FabricPool

  public constructor(wallet: IndyWallet, agentConfig: AgentConfig, indyIssuer: IndyIssuerService) {
    this.wallet = wallet
    this.indy = agentConfig.agentDependencies.indy
    this.logger = agentConfig.logger
    this.indyIssuer = indyIssuer
    this.pool = new FabricPool(agentConfig)
  }

  public async connectToPools() {
    await this.pool.connect()
  }

  public async registerPublicDid(
    submitterDid: string,
    targetDid: string,
    verkey: string,
    alias: string,
    role?: NymRole
  ) {
    try {
      this.logger.debug(`Register public did '${targetDid}' on ledger`)

      const request = await this.indy.buildNymRequest(submitterDid, targetDid, verkey, alias, role || null)

      const response = await this.submitWriteRequest(request, submitterDid)

      this.logger.debug(`Registered public did '${targetDid}' on ledger`, {
        response,
      })

      return targetDid
    } catch (error) {
      this.logger.error(`Error registering public did '${targetDid}' on ledger`, {
        error,
        submitterDid,
        targetDid,
        verkey,
        alias,
        role,
      })
      throw error
    }
  }

  public async getPublicDid(did: string) {
    this.logger.debug(`Get nym transaction for did '${did}' from ledger`)
    const response = await this.submitReadRequest({ type: '1', id: did })
    return response.data
  }

  public async getEndpointsForDid(did: string) {
    try {
      this.logger.debug(`Get endpoints for did '${did}' from ledger`)

      this.logger.debug(`Submitting get endpoint ATTRIB request for did '${did}' to ledger`)
      const response = await this.submitReadRequest({ type: '100', id: did })

      if (!response) return {}

      const endpoints = JSON.parse(response.data as string)?.endpoint as IndyEndpointAttrib
      this.logger.debug(`Got endpoints '${JSON.stringify(endpoints)}' for did '${did}' from ledger`, {
        response,
        endpoints,
      })

      return endpoints ?? {}
    } catch (error) {
      this.logger.error(`Error retrieving endpoints for did '${did}' from ledger`, {
        error,
      })

      throw isIndyError(error) ? new IndySdkError(error) : error
    }
  }

  public async registerSchema(did: string, schemaTemplate: SchemaTemplate) {
    try {
      this.logger.debug(`Register schema on ledger with did '${did}'`, schemaTemplate)
      const { name, attributes, version } = schemaTemplate
      const schema = await this.indyIssuer.createSchema({ originDid: did, name, version, attributes })

      const request = await this.indy.buildSchemaRequest(did, schema)

      const response = await this.submitWriteRequest(request, did)
      this.logger.debug(`Registered schema '${schema.id}' on ledger`, {
        response: response,
        schema,
      })

      return schema
    } catch (error) {
      this.logger.error(`Error registering schema for did '${did}' on ledger`, {
        error,
        did,
        schemaTemplate,
      })

      throw isIndyError(error) ? new IndySdkError(error) : error
    }
  }

  public async getSchema(schemaId: string) {
    try {
      this.logger.debug(`Getting schema '${schemaId}' from ledger`)
      const response = await this.submitReadRequest({ type: '101', id: schemaId })

      const schema = response.data
      this.logger.debug(`Got schema '${schemaId}' from ledger`, {
        schema,
      })

      return schema
    } catch (error) {
      this.logger.error(`Error retrieving schema '${schemaId}' from ledger`, {
        error,
        schemaId,
      })

      throw isIndyError(error) ? new IndySdkError(error) : error
    }
  }

  public async registerCredentialDefinition(
    did: string,
    credentialDefinitionTemplate: CredentialDefinitionTemplate
  ): Promise<CredDef> {
    try {
      this.logger.debug(`Registering credential definition on ledger with did '${did}'`, credentialDefinitionTemplate)
      const { schema, tag, signatureType, supportRevocation } = credentialDefinitionTemplate
      const credentialDefinition = await this.indyIssuer.createCredentialDefinition({
        issuerDid: did,
        schema,
        tag,
        signatureType,
        supportRevocation,
      })

      const request = await this.indy.buildCredDefRequest(did, credentialDefinition)
      request.operation.schemaId = schema.id

      const response = await this.submitWriteRequest(request, did)
      this.logger.debug(`Registered credential definition '${credentialDefinition.id}' on ledger`, {
        response: response,
      })

      return credentialDefinition
    } catch (error) {
      this.logger.error(
        `Error registering credential definition for schema '${credentialDefinitionTemplate.schema.id}' on ledger`,
        {
          error,
          did,
          credentialDefinitionTemplate,
        }
      )

      throw isIndyError(error) ? new IndySdkError(error) : error
    }
  }

  public async getCredentialDefinition(credentialDefinitionId: string) {
    this.logger.debug(`Retrieving credential definition '${credentialDefinitionId}'`)

    try {
      const response = await this.submitReadRequest({ type: '102', id: credentialDefinitionId })

      this.logger.debug(`Got credential definition '${credentialDefinitionId}' from ledger`, {
        response,
      })

      return response.data
    } catch (error) {
      this.logger.error(`Error retrieving credential definition '${credentialDefinitionId}' from ledger`, {
        error,
        credentialDefinitionId,
      })

      throw isIndyError(error) ? new IndySdkError(error) : error
    }
  }

  public async getRevocationRegistryDefinition(
    revocationRegistryDefinitionId: string
  ): Promise<ParseRevocationRegistryDefinitionTemplate> {
    this.logger.debug(`Using ledger to retrieve revocation registry definition '${revocationRegistryDefinitionId}'`)
    try {
      //TODO - implement a cache
      this.logger.trace(
        `Revocation Registry Definition '${revocationRegistryDefinitionId}' not cached, retrieving from ledger`
      )

      this.logger.trace(
        `Submitting get revocation registry definition request for revocation registry definition '${revocationRegistryDefinitionId}' to ledger`
      )
      const response = await this.submitReadRequest({
        type: '113',
        id: revocationRegistryDefinitionId,
      })
      this.logger.trace(`Got revocation registry definition '${revocationRegistryDefinitionId}' from ledger`, {
        response,
      })
      return response.data
    } catch (error) {
      this.logger.error(
        `Error retrieving revocation registry definition '${revocationRegistryDefinitionId}' from ledger`,
        {
          error,
          revocationRegistryDefinitionId: revocationRegistryDefinitionId,
        }
      )

      throw error
    }
  }

  //Retrieves the accumulated state of a revocation registry by id given a revocation interval from & to (used primarily for proof creation)
  public async getRevocationRegistryDelta(
    revocationRegistryDefinitionId: string,
    to: number = new Date().getTime(),
    from = 0
  ): Promise<ParseRevocationRegistryDeltaTemplate> {
    this.logger.debug(
      `Using ledger to retrieve revocation registry delta with revocation registry definition id: '${revocationRegistryDefinitionId}'`,
      {
        to,
        from,
      }
    )

    try {
      this.logger.trace(
        `Submitting get revocation registry delta request for revocation registry '${revocationRegistryDefinitionId}' to ledger`
      )

      const response = await this.submitReadRequest({
        type: '114',
        id: revocationRegistryDefinitionId,
        from: from,
        to: to,
      })
      this.logger.trace(`Got revocation registry delta'${revocationRegistryDefinitionId}' from ledger`, {
        response,
      })

      return response.data
    } catch (error) {
      this.logger.error(
        `Error retrieving revocation registry delta '${revocationRegistryDefinitionId}' from ledger, potentially revocation interval ends before revocation registry creation?"`,
        {
          error,
          revocationRegistryId: revocationRegistryDefinitionId,
        }
      )
      throw error
    }
  }

  //Retrieves the accumulated state of a revocation registry by id given a timestamp (used primarily for verification)
  public async getRevocationRegistry(
    revocationRegistryDefinitionId: string,
    timestamp: number
  ): Promise<ParseRevocationRegistryTemplate> {
    this.logger.debug(
      `Using ledger to retrieve revocation registry accumulated state with revocation registry definition id: '${revocationRegistryDefinitionId}'`,
      {
        timestamp,
      }
    )

    try {
      this.logger.trace(
        `Submitting get revocation registry request for revocation registry '${revocationRegistryDefinitionId}' to ledger`
      )
      const response = await this.submitReadRequest({
        type: '114',
        id: revocationRegistryDefinitionId,
        timestamp: timestamp,
      })
      this.logger.trace(`Got revocation registry '${revocationRegistryDefinitionId}' from ledger`, {
        response,
      })

      return response.data
    } catch (error) {
      this.logger.error(`Error retrieving revocation registry '${revocationRegistryDefinitionId}' from ledger`, {
        error,
        revocationRegistryId: revocationRegistryDefinitionId,
      })
      throw error
    }
  }

  private async submitWriteRequest(request: LedgerRequest, signDid: string): Promise<LedgerSuccessResponse> {
    const signedRequest = await this.signRequest(signDid, request)
    return await this.pool.submitWriteRequest(signedRequest)
  }

  private async submitReadRequest(request: LedgerReadRequest): Promise<LedgerSuccessResponse> {
    return await this.pool.submitReadRequest(request)
  }

  private async signRequest(did: string, request: LedgerRequest): Promise<LedgerRequest> {
    try {
      return this.indy.signRequest(this.wallet.handle, did, request)
    } catch (error) {
      throw isIndyError(error) ? new IndySdkError(error) : error
    }
  }
}
