import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("LocalDeployment", (m) => {
  // 1. DEPLOY ASSET MOCKS
  const mockWeth = m.contract("MockWETH", [], { id: "MockWETH" });
  const tokenA = m.contract("MockERC20", ["Token A", "TKNA", 18], { id: "TokenA" });
  const tokenB = m.contract("MockERC20", ["Token B", "TKNB", 18], { id: "TokenB" });
  const mockNFT = m.contract("MockERC721", ["Big NFT", "BNFT"], { id: "BigNFT" });

  // 2. DEPLOY INFRASTRUCTURE
  const lendingPool = m.contract("MockLendingPool");
  const compliance = m.contract("ComplianceManager");

  // 3. DEPLOY ORDERBOOKS
  const fungibleOrderbook = m.contract("FungibleOrderbook", [compliance]);
  const nftOrderbook = m.contract("NFTOrderbook", [compliance]);

  // 4. DEPLOY SETTLEMENT ENGINE
  const settlementEngine = m.contract("SettlementEngine", [compliance, 60, 50]);

  // 5. DEPLOY CUSTODIAN
  const custodian = m.contract("Custodian", [compliance, lendingPool, mockWeth]);

  // 6. SETUP: Register Token Pools in the LendingPool
  const wethPool = m.call(lendingPool, "addPool", [mockWeth, 500, "WETH", "WETH"], { id: "AddWethPool" });
  const tokenAPool = m.call(lendingPool, "addPool", [tokenA, 300, "Token A", "TKNA"], { id: "AddTokenAPool" });

  // 7. INITIALIZATION (Wiring circular dependencies)
  m.call(custodian, "initialize", [fungibleOrderbook, nftOrderbook, settlementEngine], { after: [wethPool] });
  m.call(fungibleOrderbook, "initialize", [custodian, settlementEngine]);
  m.call(nftOrderbook, "initialize", [custodian, settlementEngine]);
  m.call(settlementEngine, "initialize", [fungibleOrderbook, nftOrderbook, custodian]);

  // 8. AUTOMATED LIQUIDITY: Pre-funding the LendingPool
  // Use a smaller deposit so the deployer account can afford the upfront ETH cost
  const liquidityAmount = BigInt(1000) * BigInt(10**18); // 1,000 tokens for liquidity

  // Fund WETH by depositing ETH into MockWETH from the deployer account
  // MockWETH.deposit() is payable and m.call supports sending value and specifying the sender
  const depositWeth = m.call(mockWeth, "deposit", [], { id: "DepositWeth", value: liquidityAmount, from: m.getAccount(0) });
  const mintA = m.call(tokenA, "mint", [m.getAccount(0), liquidityAmount], { id: "MintA" });

  // Approve the LendingPool to take the tokens
  const approveWeth = m.call(mockWeth, "approve", [lendingPool, liquidityAmount], { id: "ApproveWeth", after: [depositWeth] });
  const approveA = m.call(tokenA, "approve", [lendingPool, liquidityAmount], { id: "ApproveA", after: [mintA] });

  // Inject funds into the pool to cover future yield and withdrawals
  m.call(lendingPool, "addLiquidity", [mockWeth, liquidityAmount], { id: "AddWethLiquidity", after: [approveWeth, wethPool] });
  m.call(lendingPool, "addLiquidity", [tokenA, liquidityAmount], { id: "AddTokenALiquidity", after: [approveA, tokenAPool] });

  return { 
    compliance, lendingPool, custodian, fungibleOrderbook, nftOrderbook, 
    settlementEngine, mockWeth, tokenA, tokenB, mockNFT 
  };
});