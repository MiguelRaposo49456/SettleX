import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseEther, formatEther } from 'viem';
import CustodianABI from '../abis/Custodian.json';
import LendingPoolABI from '../abis/MockLendingPool.json';

const CUSTODIAN_ADDR = import.meta.env.VITE_CUSTODIAN_ADDRESS;
const LENDING_POOL_ADDR = import.meta.env.VITE_LENDING_POOL_ADDRESS;
const ETH_ADR = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

export function useVault() {
  const { address } = useAccount();

  // Read native ETH balance in Custodian
  const { data: ethBalance, refetch: refetchEth } = useReadContract({
    address: CUSTODIAN_ADDR as `0x${string}`,
    abi: CustodianABI.abi,
    functionName: 'balanceOf',
    args: [address, ETH_ADR],
  });

  // Read locked ETH balance
  const { data: lockedEth } = useReadContract({
    address: CUSTODIAN_ADDR as `0x${string}`,
    abi: CustodianABI.abi,
    functionName: 'lockedBalanceOf',
    args: [address, ETH_ADR],
  });

  const { writeContractAsync, data: hash } = useWriteContract();
  const { isLoading: isProcessing } = useWaitForTransactionReceipt({ hash });

  const deposit = async (amount: string) => {
    return await writeContractAsync({
      address: CUSTODIAN_ADDR as `0x${string}`,
      abi: CustodianABI.abi,
      functionName: 'depositETH',
      value: parseEther(amount),
    });
  };

  const withdraw = async (amount: string) => {
    return await writeContractAsync({
      address: CUSTODIAN_ADDR as `0x${string}`,
      abi: CustodianABI.abi,
      functionName: 'withdrawETH',
      args: [parseEther(amount)],
    });
  };

  return { 
    ethBalance: ethBalance ? formatEther(ethBalance as bigint) : '0',
    lockedEth: lockedEth ? formatEther(lockedEth as bigint) : '0',
    deposit, 
    withdraw,
    isProcessing,
    refetchEth
  };
}