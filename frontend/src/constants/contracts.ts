import CustodianABI from '../abis/Custodian.json';
import FungibleOrderbookABI from '../abis/FungibleOrderbook.json';
import NonFungibleOrderbookABI from '../abis/NFTOrderbook.json';
import SettlementEngineABI from '../abis/SettlementEngine.json';
import LendingPoolABI from '../abis/MockLendingPool.json';
import ComplianceManagerABI from '../abis/ComplianceManager.json';

export const COMPLIANCE_MANAGER_CONTRACT = {
    address: import.meta.env.VITE_COMPLIANCE_MANAGER_ADDRESS as `0x${string}`,
    abi: ComplianceManagerABI.abi,
} as const;

export const CUSTODIAN_CONTRACT = {
  address: import.meta.env.VITE_CUSTODIAN_ADDRESS as `0x${string}`,
  abi: CustodianABI.abi,
} as const;

export const FUNGIBLE_ORDERBOOK_CONTRACT = {
  address: import.meta.env.VITE_FUNGIBLE_ORDERBOOK_ADDRESS as `0x${string}`,
  abi: FungibleOrderbookABI.abi,
} as const;

export const NFT_ORDERBOOK_CONTRACT = {
  address: import.meta.env.VITE_NFT_ORDERBOOK_ADDRESS as `0x${string}`,
  abi: NonFungibleOrderbookABI.abi,
} as const;

export const SETTLEMENT_ENGINE_CONTRACT = {
    address: import.meta.env.VITE_SETTLEMENT_ENGINE_ADDRESS as `0x${string}`,
    abi: SettlementEngineABI.abi,
} as const;

export const LENDING_POOL_CONTRACT = {
    address: import.meta.env.VITE_LENDING_POOL_ADDRESS as `0x${string}`,
    abi: LendingPoolABI.abi,
} as const;