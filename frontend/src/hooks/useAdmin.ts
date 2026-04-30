import { useReadContract, useWriteContract, useAccount } from 'wagmi';
import SettlementABI from '../abis/SettlementEngine.json';
import ComplianceABI from '../abis/ComplianceManager.json';

const SETTLEMENT_ADDR = import.meta.env.VITE_SETTLEMENT_ENGINE_ADDRESS as `0x${string}`;
const COMPLIANCE_ADDR = import.meta.env.VITE_COMPLIANCE_MANAGER_ADDRESS as `0x${string}`;

export function useAdmin() {
  const { address } = useAccount();

  // Check if current user is an operator
  const { data: isOperator } = useReadContract({
    address: COMPLIANCE_ADDR,
    abi: ComplianceABI.abi,
    functionName: 'hasOperatorRole',
    args: [address],
  });

  // Check system pause status
  const { data: isPaused } = useReadContract({
    address: COMPLIANCE_ADDR,
    abi: ComplianceABI.abi,
    functionName: 'isSystemPaused',
  });

  // Get settlement countdown
  const { data: timeLeft } = useReadContract({
    address: SETTLEMENT_ADDR,
    abi: SettlementABI.abi,
    functionName: 'timeUntilSettlement',
    query: { refetchInterval: 2000 } // Refresh every 2s for smoother countdown
  });

  const { writeContractAsync } = useWriteContract();

  const togglePause = async () => {
    await writeContractAsync({
      address: COMPLIANCE_ADDR,
      abi: ComplianceABI.abi,
      functionName: isPaused ? 'unpause' : 'pause',
    });
  };

  const manualSettle = async () => {
    await writeContractAsync({
      address: SETTLEMENT_ADDR,
      abi: SettlementABI.abi,
      functionName: 'settleBatch',
    });
  };

  const blacklistToken = async (token: `0x${string}`) => {
    await writeContractAsync({
      address: COMPLIANCE_ADDR,
      abi: ComplianceABI.abi,
      functionName: 'blacklistToken',
      args: [token],
    });
  };

  const setUserStatus = async (user: `0x${string}`, statusVal: number) => {
    await writeContractAsync({
      address: COMPLIANCE_ADDR,
      abi: ComplianceABI.abi,
      functionName: 'setUserStatus',
      args: [user, statusVal],
    });
  };

  const grantOperator = async (role: `0x${string}`, account: `0x${string}`) => {
    await writeContractAsync({
      address: COMPLIANCE_ADDR,
      abi: ComplianceABI.abi,
      functionName: 'grantRole',
      args: [role, account],
    });
  };

  return { 
    isOperator, 
    isPaused, 
    togglePause, 
    manualSettle, 
    timeLeft: timeLeft ? Number(timeLeft) : 0,
    blacklistToken,
    setUserStatus,
    grantOperator
  };
}