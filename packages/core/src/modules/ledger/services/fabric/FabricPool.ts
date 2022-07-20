import type { AgentConfig } from '../../../../agent/AgentConfig'
import type { Logger } from '../../../../logger'
import type { FileSystem } from '../../../../storage/FileSystem'
import type { Contract, GatewayOptions, Wallet, X509Identity } from 'fabric-network'
import type { LedgerRequest } from 'indy-sdk'

import FabricCAServices from 'fabric-ca-client'
import { Gateway, Wallets } from 'fabric-network'
import { readFileSync } from 'fs'

import { LedgerError } from '../../error/LedgerError'

export class FabricPool {
  private poolConfig: FabricPoolConfig
  private logger: Logger
  private fileSystem: FileSystem
  private chaincode?: Contract

  public constructor(agentConfig: AgentConfig) {
    if (agentConfig.ledgerType === 'fabric' && agentConfig.fabricConfig) {
      this.poolConfig = agentConfig.fabricConfig
    } else {
      throw new LedgerError('No fabric ledgers are configured')
    }
    this.logger = agentConfig.logger
    this.fileSystem = agentConfig.fileSystem
  }

  public async connect() {
    const ccpPath = await this.getCcpPath()
    if (!ccpPath) {
      throw new LedgerError('Cannot connect to ledger without connection profile file')
    }
    const poolConfig = this.poolConfig
    const ccp: Record<string, unknown> = JSON.parse(readFileSync(ccpPath, 'utf-8'))
    try {
      const fabricWallet = await this.setupWallet(ccp, poolConfig)
      const gateway = new Gateway()
      const gatewayOpts: GatewayOptions = {
        wallet: fabricWallet,
        identity: poolConfig.identity.id,
        discovery: { enabled: true, asLocalhost: true },
      }
      this.logger.debug(`Connecting to gateway`, { ccpPath })
      await gateway.connect(ccp, gatewayOpts)
      const network = await gateway.getNetwork(poolConfig.channel)
      this.chaincode = network.getContract(poolConfig.chaincode)
    } catch (error) {
      this.logger.debug(`Fabric Error: ${JSON.stringify(error)}`)
      throw new LedgerError(`Fabric connection failed`)
    }
  }

  public async submitWriteRequest(request: LedgerRequest) {
    try {
      const response = await this.chaincode?.submitTransaction('write', JSON.stringify(request))
      if (!response) {
        throw new LedgerError(`No response received from the ledger`)
      }
      return JSON.parse(response.toString())
    } catch (error) {
      this.logger.debug(`Fabric Error: ${JSON.stringify(error)}`)
      throw new LedgerError(`Invalid request`)
    }
  }

  public async submitReadRequest(request: LedgerReadRequest) {
    try {
      const response = await this.chaincode?.evaluateTransaction('read', JSON.stringify(request))
      if (!response) {
        throw new LedgerError(`No response received from the ledger`)
      }
      return JSON.parse(response.toString())
    } catch (error) {
      this.logger.debug(`Fabric Error: ${JSON.stringify(error)}`)
      throw new LedgerError(`Invalid request`)
    }
  }

  public async setupWallet(ccp: Record<string, any>, poolConfig: FabricPoolConfig): Promise<Wallet> {
    const wallet = await Wallets.newFileSystemWallet(poolConfig.walletPath)

    if ((await wallet.get(poolConfig.identity.id)) == undefined) {
      const orgName: string = ccp['client']['organization']
      const cas: string[] = ccp['organizations'][orgName]['certificateAuthorities']
      if (cas.length < 1) {
        throw new Error('connection profile contains zero certificate authorities')
      }

      const caName = cas[0]
      const ca = ccp['certificateAuthorities'][caName]
      const caClient = new FabricCAServices(ca.url, { trustedRoots: ca.tlsCACerts?.pem, verify: false }, ca.caName)

      const enrollment = await caClient.enroll({
        enrollmentID: poolConfig.identity.id,
        enrollmentSecret: poolConfig.identity.secret ? poolConfig.identity.secret : '',
      })

      const identity: X509Identity = {
        mspId: ccp['organizations'][orgName]['mspid'],
        type: 'X.509',
        credentials: {
          certificate: enrollment.certificate,
          privateKey: enrollment.key.toBytes(),
        },
      }
      await wallet.put(poolConfig.identity.id, identity)
    }
    return wallet
  }

  private async getCcpPath() {
    // If the path is already provided return it
    if (this.poolConfig.ccpPath) return this.poolConfig.ccpPath
    // Determine the connection profile path
    const ccpPath = this.fileSystem.basePath + `/afj/ccp.json`
    // Store ccp data if provided
    if (this.poolConfig.ccp) {
      await this.fileSystem.write(ccpPath, this.poolConfig.ccp)
      this.poolConfig.ccp = ccpPath
      return ccpPath
    }

    // No ccpPath
    return null
  }
}

export interface FabricPoolConfig {
  ccpPath?: string
  ccp?: string
  walletPath: string
  channel: string
  chaincode: string
  identity: {
    id: string
    secret?: string
  }
}

export interface LedgerReadRequest {
  type: '1' | '100' | '101' | '102' | '113' | '114'
  id: string
  from?: number
  to?: number
  timestamp?: number
}

export type LedgerResponse = LedgerSuccessResponse | LedgerErrorResponse

export interface LedgerSuccessResponse {
  operation: 'READ' | 'WRITE'
  type: '1' | '100' | '101' | '102' | '113' | '114'
  identifier: string
  data: any
}

export interface LedgerErrorResponse {
  operation: 'READ' | 'WRITE'
  type: '1' | '100' | '101' | '102' | '113' | '114'
  identifier: string
  reason: string
}
