export async function deploySystem(ethers: any) {
    const [admin, client1, client2] = await ethers.getSigners();

    // Deploy MockERC20 tokens
    const tokenA = await ethers.deployContract("MockERC20", ["TokenA", "TKA", 18]);
    const tokenB = await ethers.deployContract("MockERC20", ["TokenB", "TKB", 18]);

    // Deploy mock lending dependencies
    const mockLendingPool = await ethers.deployContract("MockLendingPool");
    const mockWeth = await ethers.deployContract("MockWETH");

    // Deploy core contracts
    const complianceManager = await ethers.deployContract("ComplianceManager");
    const orderbook = await ethers.deployContract("OrderBook", [complianceManager.target]);
    const custodian = await ethers.deployContract("Custodian", [complianceManager.target, mockLendingPool.target, mockWeth.target]);
    const settlementEngine  = await ethers.deployContract("SettlementEngine", [complianceManager.target]);

    // Wire them together
    await orderbook.connect(admin).initialize(custodian.target, settlementEngine.target);
    await custodian.connect(admin).initialize(orderbook.target, settlementEngine.target);
    await settlementEngine.connect(admin).initialize(orderbook.target, custodian.target);

    return {
        admin, client1, client2,
        complianceManager, orderbook, custodian, settlementEngine,
        tokenA, tokenB,
        mockLendingPool, mockWeth
    };
}