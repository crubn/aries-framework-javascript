import type { Jws, JwsGeneralFormat } from './JwsTypes'
import type { AgentContext } from '../agent'
import type { Buffer } from '../utils'

import { AriesFrameworkError } from '../error'
import { injectable } from '../plugins'
import { JsonEncoder, TypedArrayEncoder } from '../utils'
import { WalletError } from '../wallet/error'

import { Key } from './Key'
import { KeyType } from './KeyType'

// TODO: support more key types, more generic jws format
const JWS_KEY_TYPE = 'OKP'
const JWS_CURVE = 'Ed25519'
const JWS_ALG = 'EdDSA'

@injectable()
export class JwsService {
  public async createJws(
    agentContext: AgentContext,
    { payload, verkey, header }: CreateJwsOptions
  ): Promise<JwsGeneralFormat> {
    const base64Payload = TypedArrayEncoder.toBase64URL(payload)
    const base64Protected = JsonEncoder.toBase64URL(this.buildProtected(verkey))
    const key = Key.fromPublicKeyBase58(verkey, KeyType.Ed25519)

    const signature = TypedArrayEncoder.toBase64URL(
      await agentContext.wallet.sign({ data: TypedArrayEncoder.fromString(`${base64Protected}.${base64Payload}`), key })
    )

    return {
      protected: base64Protected,
      signature,
      header,
    }
  }

  /**
   * Verify a JWS
   */
  public async verifyJws(agentContext: AgentContext, { jws, payload }: VerifyJwsOptions): Promise<VerifyJwsResult> {
    const base64Payload = TypedArrayEncoder.toBase64URL(payload)
    const signatures = 'signatures' in jws ? jws.signatures : [jws]

    if (signatures.length === 0) {
      throw new AriesFrameworkError('Unable to verify JWS: No entries in JWS signatures array.')
    }

    const signerVerkeys = []
    for (const jws of signatures) {
      const protectedJson = JsonEncoder.fromBase64(jws.protected)

      const isValidKeyType = protectedJson?.jwk?.kty === JWS_KEY_TYPE
      const isValidCurve = protectedJson?.jwk?.crv === JWS_CURVE
      const isValidAlg = protectedJson?.alg === JWS_ALG

      if (!isValidKeyType || !isValidCurve || !isValidAlg) {
        throw new AriesFrameworkError('Invalid protected header')
      }

      const data = TypedArrayEncoder.fromString(`${jws.protected}.${base64Payload}`)
      const signature = TypedArrayEncoder.fromBase64(jws.signature)

      const verkey = TypedArrayEncoder.toBase58(TypedArrayEncoder.fromBase64(protectedJson?.jwk?.x))
      const key = Key.fromPublicKeyBase58(verkey, KeyType.Ed25519)
      signerVerkeys.push(verkey)

      try {
        const isValid = await agentContext.wallet.verify({ key, data, signature })

        if (!isValid) {
          return {
            isValid: false,
            signerVerkeys: [],
          }
        }
      } catch (error) {
        // WalletError probably means signature verification failed. Would be useful to add
        // more specific error type in wallet.verify method
        if (error instanceof WalletError) {
          return {
            isValid: false,
            signerVerkeys: [],
          }
        }

        throw error
      }
    }

    return { isValid: true, signerVerkeys }
  }

  /**
   * @todo This currently only work with a single alg, key type and curve
   *    This needs to be extended with other formats in the future
   */
  private buildProtected(verkey: string) {
    return {
      alg: 'EdDSA',
      jwk: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: TypedArrayEncoder.toBase64URL(TypedArrayEncoder.fromBase58(verkey)),
      },
    }
  }
}

export interface CreateJwsOptions {
  verkey: string
  payload: Buffer
  header: Record<string, unknown>
}

export interface VerifyJwsOptions {
  jws: Jws
  payload: Buffer
}

export interface VerifyJwsResult {
  isValid: boolean
  signerVerkeys: string[]
}
