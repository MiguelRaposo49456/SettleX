import CustodianABI from '../abis/Custodian.json';
import FungibleOrderbookABI from '../abis/FungibleOrderbook.json';
import NonFungibleOrderbookABI from '../abis/NFTOrderbook.json';
import SettlementEngineABI from '../abis/SettlementEngine.json';
import LendingPoolABI from '../abis/MockLendingPool.json';
import ComplianceManagerABI from '../abis/ComplianceManager.json';

import localDeployed from '../../../ignition/deployments/chain-31337/deployed_addresses.json'
import sepoliaDeployed from '../../../ignition/deployments/chain-11155111/deployed_addresses.json'

const deployed = import.meta.env.VITE_CHAIN_ID === '11155111' ? sepoliaDeployed : localDeployed

export const COMPLIANCE_MANAGER_CONTRACT = {
    address: deployed['Deployment#ComplianceManager'] as `0x${string}`,
    abi: ComplianceManagerABI.abi,
} as const;

export const CUSTODIAN_CONTRACT = {
  address: deployed['Deployment#Custodian'] as `0x${string}`,
  abi: CustodianABI.abi,
} as const;

export const FUNGIBLE_ORDERBOOK_CONTRACT = {
  address: deployed['Deployment#FungibleOrderbook'] as `0x${string}`,
  abi: FungibleOrderbookABI.abi,
} as const;

export const NFT_ORDERBOOK_CONTRACT = {
  address: deployed['Deployment#NFTOrderbook'] as `0x${string}`,
  abi: NonFungibleOrderbookABI.abi,
} as const;

export const SETTLEMENT_ENGINE_CONTRACT = {
    address: deployed['Deployment#SettlementEngine'] as `0x${string}`,
    abi: SettlementEngineABI.abi,
} as const;

export const LENDING_POOL_CONTRACT = {
    address: deployed['Deployment#MockLendingPool'] as `0x${string}`,
    abi: LendingPoolABI.abi,
} as const;