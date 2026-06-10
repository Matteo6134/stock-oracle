import { scanPremarketMovers, getShortSqueezeSetups, getBreakoutSetups } from '../server/services/premarketScanner.js';
import { getDynamicSymbols } from '../server/services/dynamicDiscovery.js';

async function runAudit() {
  console.log('--- BOT AUDIT START ---');
  
  // 1. Get Dynamic Symbols
  console.log('Fetching dynamic symbols...');
  const dynamic = await getDynamicSymbols();
  console.log(`Found ${dynamic.length} dynamic symbols.`);

  // 2. Scan for High Conviction Short Squeeze
  console.log('\nScanning for Short Squeeze setups in the expanded universe...');
  const squeezeSetups = await getShortSqueezeSetups(dynamic);
  
  console.log('\nTOP SHORT SQUEEZE CANDIDATES:');
  squeezeSetups.slice(0, 10).forEach((s, i) => {
    console.log(`${i+1}. ${s.symbol}: SI %: ${s.shortPercentOfFloat}%, DTC: ${s.shortRatio}, Type: ${s.squeezeType}, Prob: ${s.probability}%`);
    if (s.targets) {
        console.log(`   Targets: Conservative: $${s.targets.conservative} (+${s.targets.conservativeGain}%), Extreme: $${s.targets.extreme} (+${s.targets.extremeGain}%)`);
    }
  });

  // 3. Scan for Breakouts
  console.log('\nScanning for Coiled Spring / Breakout setups...');
  const breakoutSetups = await getBreakoutSetups(dynamic);
  console.log('\nTOP BREAKOUT CANDIDATES:');
  breakoutSetups.slice(0, 5).forEach((b, i) => {
    console.log(`${i+1}. ${b.symbol}: Squeeze Strength: ${b.squeezeStrength}, BB Width: ${b.bbWidth}`);
  });

  console.log('\n--- AUDIT COMPLETE ---');
}

runAudit();
