import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("Deployment", (m) => {
  // 1. DEPLOY ASSET MOCKS
  const mockWeth = m.contract("MockWETH", [], { id: "MockWETH" });
  const tokenA = m.contract("MockERC20", ["Token A", "TKNA", 18], { id: "TokenA" });
  const tokenB = m.contract("MockERC20", ["Token B", "TKNB", 18], { id: "TokenB" });
  const mockNFT = m.contract("MockERC721", ["Big NFT", "BNFT"], { id: "BigNFT" });
  const anotherMockNFT = m.contract("MockERC721", ["WOW NFT", "WNFT"], { id: "WOWNFT" });

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
  m.call(custodian, "initialize", [fungibleOrderbook, nftOrderbook, settlementEngine]);
  m.call(fungibleOrderbook, "initialize", [custodian, settlementEngine]);
  m.call(nftOrderbook, "initialize", [custodian, settlementEngine]);
  m.call(settlementEngine, "initialize", [fungibleOrderbook, nftOrderbook, custodian]);

  // 8. AUTOMATED LIQUIDITY: Pre-funding the LendingPool
  const liquidityAmount = BigInt(1000) * BigInt(10**18); // 1,000 tokens for liquidity
  const traderAmount = BigInt(500) * BigInt(10**18); // 500 tokens for local trading/testing

  // Fund WETH by depositing ETH into MockWETH from the deployer account
  const depositWeth = m.call(mockWeth, "deposit", [], { id: "DepositWeth", value: liquidityAmount, from: m.getAccount(0) });
  const mintA = m.call(tokenA, "mint", [m.getAccount(0), liquidityAmount], { id: "MintA" });

  m.call(tokenA, "mint", [m.getAccount(0), traderAmount], { id: "MintATrader0", after: [mintA] });
  m.call(tokenA, "mint", [m.getAccount(1), traderAmount], { id: "MintATrader1", after: [mintA] });
  m.call(tokenB, "mint", [m.getAccount(1), traderAmount], { id: "MintBTrader0" });

  // Mint NFTs to test account
  m.call(mockNFT, "mint", [m.getAccount(1), BigInt(1)], { id: "MintNFT1" });
  m.call(mockNFT, "mint", [m.getAccount(1), BigInt(2)], { id: "MintNFT2" });
  m.call(anotherMockNFT, "mint", [m.getAccount(0), BigInt(1)], { id: "MintAnotherNFT1" });

  // Approve the LendingPool to take the tokens
  const approveWeth = m.call(mockWeth, "approve", [lendingPool, liquidityAmount], { id: "ApproveWeth", after: [depositWeth] });
  const approveA = m.call(tokenA, "approve", [lendingPool, liquidityAmount], { id: "ApproveA", after: [mintA] });

  // Inject funds into the pool to cover future yield and withdrawals
  m.call(lendingPool, "addLiquidity", [mockWeth, liquidityAmount], { id: "AddWethLiquidity", after: [approveWeth, wethPool] });
  m.call(lendingPool, "addLiquidity", [tokenA, liquidityAmount], { id: "AddTokenALiquidity", after: [approveA, tokenAPool] });

  return { 
    compliance, lendingPool, custodian, fungibleOrderbook, nftOrderbook, 
    settlementEngine, mockWeth, tokenA, tokenB, mockNFT, anotherMockNFT
  };
});