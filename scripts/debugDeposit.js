import {ethers} from "ethers";

// Usage: node scripts/debugDeposit.js <rpc> <custodian> <token> <user>
// Example: node scripts/debugDeposit.js http://127.0.0.1:8545 0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6 0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 4) {
    console.error('Usage: node scripts/debugDeposit.js <rpc> <custodian> <token> <user>');
    process.exit(1);
  }
  const [rpc, custAddr, tokenAddr, userAddr] = args;

  const provider = new ethers.JsonRpcProvider(rpc);

  // Minimal ABIs
  const erc20 = [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
  ];
  const custAbi = [
    'function initialized() view returns (bool)',
    'function deposit(address token,uint256 amount)',
    'function balanceOf(address client,address token) view returns (uint256)',
    'error UserNotAllowed(address)',
    'error TokenNotAllowed(address)',
    'error InsufficientBalance(uint256,uint256)',
  ];
  const poolAbi = ['function getAToken(address) view returns (address)'];
  const compAbi = ['function isUserAllowed(address) view returns (bool)'];

  const token = new ethers.Contract(tokenAddr, erc20, provider);
  const cust = new ethers.Contract(custAddr, custAbi, provider);
  const pool = new ethers.Contract(custAddr /* placeholder */, poolAbi, provider);
  const comp = new ethers.Contract(custAddr /* placeholder */, compAbi, provider);

  try {
    const [balance, initialized, userAllowed] = await Promise.all([
      token.balanceOf(userAddr),
      cust.initialized(),
      // call compliance via storage: read complianceManager from Custodian not exposed here, so skip
      cust.balanceOf ? cust.balanceOf(userAddr, tokenAddr).catch(() => null) : null,
    ]);

    console.log('User token balance:', balance.toString());
    console.log('Custodian initialized:', initialized);

    // Allowance (user -> custodian)
    const allowance = await token.allowance(userAddr, custAddr);
    console.log('Allowance (user -> custodian):', allowance.toString());

    // Is the token an aToken in the lending pool? We need lending pool address from deployment (.env)
    const LENDING = process.env.LENDING_POOL || process.env.VITE_LENDING_POOL_ADDRESS || 'http://0';
    console.log('Note: this script cannot read ComplianceManager or LendingPool automatically.');

    // Attempt a call (static) to decode revert
    const iface = new ethers.Interface(custAbi);
    const data = iface.encodeFunctionData('deposit', [tokenAddr, ethers.parseUnits('1', 18)]);
    console.log('Simulating call to deposit(token, 1*1e18) to capture revert...');
    try {
      const res = await provider.call({ to: custAddr, data });
      console.log('Call result:', res);
    } catch (callErr) {
      console.error('Call threw:', callErr);
      // Try to decode error data if present
      const dataHex = callErr?.data || callErr?.error?.data || callErr?.body || null;
      if (dataHex) {
        const hex = typeof dataHex === 'string' ? dataHex : JSON.stringify(dataHex);
        console.log('Revert data (hex):', hex);
        // Try to parse with iface
        try {
          const parsed = iface.parseError(hex);
          console.log('Parsed custom error:', parsed.name, parsed.args);
        } catch (pe) {
          console.log('Could not parse error with Custodian ABI. Raw data shown.');
        }
      }
    }
  } catch (err) {
    console.error('Error running checks:', err);
  }
}

main();
