import axios from 'axios'
import assert from 'assert-js'
import { computeSafeAddress } from './computeSafeAddress'
import { ethers } from 'ethers'
import {
  encodeParams,
  encodeDataForCreateAndAddModules,
  encodeDataForMultiSend,
  signReceiverAddress
} from './utils'

import GnosisSafe from '@gnosis.pm/safe-contracts/build/contracts/GnosisSafe'
import ProxyFactory from '@gnosis.pm/safe-contracts/build/contracts/ProxyFactory'
import MultiSend from '@gnosis.pm/safe-contracts/build/contracts/MultiSend'
import CreateAndAddModules from '@gnosis.pm/safe-contracts/build/contracts/CreateAndAddModules'
import LinkdropModule from '../../contracts/build/LinkdropModule'
import RecoveryModule from '../../contracts/build/RecoveryModule.json'
import LinkdropFactory from '@linkdrop/contracts/build/LinkdropFactory'

import { computeLinkdropModuleAddress } from './computeLinkdropModuleAddress'
import { computeRecoveryModuleAddress } from './computeRecoveryModuleAddress'

import { getEnsOwner } from './ensUtils'

import { FIFSRegistrar } from '@ensdomains/ens'

const CALL_OP = 0
const DELEGATECALL_OP = 1

const ADDRESS_ZERO = ethers.constants.AddressZero

/**
 * Function to create new safe and claim linkdrop
 * @param {String} weiAmount Wei amount
 * @param {String} tokenAddress Token address
 * @param {String} tokenAmount Token amount
 * @param {String} expirationTime Link expiration timestamp
 * @param {String} linkKey Ephemeral key assigned to link
 * @param {String} linkdropMasterAddress Linkdrop master address
 * @param {String} linkdropSignerSignature Linkdrop signer signature
 * @param {String} campaignId Campaign id
 * @param {String} gnosisSafeMasterCopy Deployed gnosis safe mastercopy address
 * @param {String} proxyFactory Deployed proxy factory address
 * @param {String} owner Safe owner address
 * @param {String} name ENS name to register for safe
 * @param {String} linkdropModuleMasterCopy Deployed linkdrop module master copy address
 * @param {String} createAndAddModules Deployed createAndAddModules library address
 * @param {String} multiSend Deployed multiSend library address
 * @param {String} apiHost API host
 * @returns {Object} {success, txHash, safe, errors}
 */
export const claimAndCreate = async ({
  weiAmount,
  tokenAddress,
  tokenAmount,
  expirationTime,
  linkKey,
  linkdropMasterAddress,
  linkdropSignerSignature,
  campaignId,
  gnosisSafeMasterCopy,
  proxyFactory,
  owner,
  linkdropModuleMasterCopy,
  createAndAddModules,
  multiSend,
  apiHost,
  saltNonce,
  guardian,
  recoveryPeriod,
  recoveryModuleMasterCopy,
  gasPrice,
  ensName,
  ensDomain,
  ensAddress,
  jsonRpcUrl,
  linkdropFactory
}) => {
  const ensOwner = await getEnsOwner({
    ensName,
    ensDomain,
    ensAddress,
    jsonRpcUrl
  })
  assert.true(ensOwner === ADDRESS_ZERO, 'Provided name already has an owner')

  const provider = new ethers.providers.JsonRpcProvider(jsonRpcUrl)

  const linkdropModuleSetupData = encodeParams(LinkdropModule.abi, 'setup', [
    [owner]
  ])

  const linkdropModuleCreationData = encodeParams(
    ProxyFactory.abi,
    'createProxyWithNonce',
    [linkdropModuleMasterCopy, linkdropModuleSetupData, saltNonce]
  )

  const recoveryModuleSetupData = encodeParams(RecoveryModule.abi, 'setup', [
    [guardian],
    recoveryPeriod
  ])

  const recoveryModuleCreationData = encodeParams(
    ProxyFactory.abi,
    'createProxyWithNonce',
    [recoveryModuleMasterCopy, recoveryModuleSetupData, saltNonce]
  )

  const modulesCreationData = encodeDataForCreateAndAddModules([
    linkdropModuleCreationData,
    recoveryModuleCreationData
  ])

  const createAndAddModulesData = encodeParams(
    CreateAndAddModules.abi,
    'createAndAddModules',
    [proxyFactory, modulesCreationData]
  )

  const createAndAddModulesMultiSendData = encodeDataForMultiSend(
    DELEGATECALL_OP,
    createAndAddModules,
    0,
    createAndAddModulesData
  )

  let nestedTxData = '0x' + createAndAddModulesMultiSendData

  let multiSendData = encodeParams(MultiSend.abi, 'multiSend', [nestedTxData])

  let gnosisSafeData = encodeParams(GnosisSafe.abi, 'setup', [
    [owner], // owners
    1, // threshold
    multiSend, // to
    multiSendData, // data,
    ADDRESS_ZERO, // payment token address
    0, // payment amount
    ADDRESS_ZERO // payment receiver address
  ])

  let createSafeData = encodeParams(ProxyFactory.abi, 'createProxyWithNonce', [
    gnosisSafeMasterCopy,
    gnosisSafeData,
    saltNonce
  ])

  gasPrice = gasPrice || (await provider.getGasPrice()).toNumber()

  const estimate = (await provider.estimateGas({
    to: proxyFactory,
    data: createSafeData,
    gasPrice
  })).add(104000)

  const creationCosts = estimate.mul(gasPrice)

  gnosisSafeData = encodeParams(GnosisSafe.abi, 'setup', [
    [owner], // owners
    1, // threshold
    multiSend, // to
    multiSendData, // data,
    ADDRESS_ZERO, // payment token address
    creationCosts, // payment amount
    ADDRESS_ZERO // payment receiver address
  ])

  createSafeData = encodeParams(ProxyFactory.abi, 'createProxyWithNonce', [
    gnosisSafeMasterCopy,
    gnosisSafeData,
    saltNonce
  ])

  const createSafeMultiSendData = encodeDataForMultiSend(
    CALL_OP,
    proxyFactory,
    0,
    createSafeData
  )

  const safe = computeSafeAddress({
    owner,
    saltNonce,
    gnosisSafeMasterCopy: gnosisSafeMasterCopy,
    deployer: proxyFactory,
    to: multiSend,
    data: multiSendData,
    paymentAmount: creationCosts
  })

  const registerEnsData = encodeParams(FIFSRegistrar.abi, 'register', [
    ethers.utils.keccak256(ethers.utils.toUtf8Bytes(ensName)),
    safe
  ])

  const registrar = await getEnsOwner({ ensAddress, ensDomain, jsonRpcUrl })

  const registerEnsMultiSendData = encodeDataForMultiSend(
    CALL_OP,
    registrar,
    0,
    registerEnsData
  )

  const receiverSignature = await signReceiverAddress(linkKey, safe)
  const linkId = new ethers.Wallet(linkKey).address

  const claimData = encodeParams(LinkdropFactory.abi, 'claim', [
    weiAmount,
    tokenAddress,
    tokenAddress,
    expirationTime,
    linkId,
    linkdropMasterAddress,
    campaignId,
    linkdropSignerSignature,
    safe,
    receiverSignature
  ])

  const claimMultiSendData = encodeDataForMultiSend(
    CALL_OP,
    linkdropFactory,
    0,
    claimData
  )

  nestedTxData =
    '0x' +
    claimMultiSendData +
    createSafeMultiSendData +
    registerEnsMultiSendData

  multiSendData = encodeParams(MultiSend.abi, 'multiSend', [nestedTxData])

  const linkdropModule = computeLinkdropModuleAddress({
    owner,
    saltNonce,
    linkdropModuleMasterCopy,
    deployer: safe
  })

  const recoveryModule = computeRecoveryModuleAddress({
    guardians: [guardian],
    recoveryPeriod,
    saltNonce,
    recoveryModuleMasterCopy,
    deployer: safe
  })

  const response = await axios.post(`${apiHost}/api/v1/safes/claimAndCreate`, {
    data: multiSendData,
    gasPrice
  })
  const { success, txHash, errors } = response.data

  return {
    success,
    txHash,
    linkdropModule,
    recoveryModule,
    safe,
    creationCosts,
    errors
  }
}
