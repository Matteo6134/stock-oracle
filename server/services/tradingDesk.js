/**
 * AI Trading Desk — 5 Virtual Trader Agents
 *
 * Each agent analyzes gems from their unique trading style.
 * Rule-based (no LLM calls), persona-driven reasoning.
 * Agent parameters are user-configurable via the UI.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_CONFIG_FILE = path.join(__dirname, '..', 'data', 'agentConfig.json');

// ── Default Agent Profiles ──
const DEFAULT_AGENTS = [
  {
    name: 'Momentum Mike',
    style: 'momentum',
    emoji: '🚀',
    enabled: true,
    description: 'Rides breakouts and momentum acceleration. Buys when price is moving UP with volume confirmation.',
    targetSignals: ['early_momentum', 'momentum_acceleration', 'near_52w_high', 'bull_flag', 'golden_cross'],
    targetGainRange: [15, 30],
    timeframeDays: [3, 5],
    stopPct: 7,
  },
  {
    name: 'Squeeze Sarah',
    style: 'squeeze',
    emoji: '🔥',
    enabled: true,
    description: 'Hunts short squeezes and volatility explosions. Buys trapped shorts and coiled springs.',
    targetSignals: ['short_squeeze_loading', 'bb_squeeze', 'price_compression', 'volume_contraction'],
    targetGainRange: [20, 50],
    timeframeDays: [1, 3],
    stopPct: 5,
  },
  {
    name: 'Volume Victor',
    style: 'accumulation',
    emoji: '📊',
    enabled: true,
    description: 'Follows smart money. Buys when institutions are quietly loading shares before a big push.',
    targetSignals: ['unusual_volume', 'multi_day_accumulation', 'smart_money'],
    targetGainRange: [10, 20],
    timeframeDays: [3, 7],
    stopPct: 8,
  },
  {
    name: 'Catalyst Claire',
    style: 'catalyst',
    emoji: '⚡',
    enabled: true,
    description: 'Plays earnings and events. Buys before catalysts with strong setup scores.',
    targetSignals: ['earnings_tomorrow'],
    targetGainRange: [5, 15],
    timeframeDays: [1, 1],
    stopPct: 3,
  },
  {
    name: 'Contrarian Carlos',
    style: 'contrarian',
    emoji: '🔄',
    enabled: true,
    description: 'Buys fear, sells greed. Targets oversold quality stocks and sector laggards about to catch up.',
    targetSignals: ['oversold_bounce', 'sector_lag'],
    targetGainRange: [8, 15],
    timeframeDays: [5, 7],
    stopPct: 10,
  },
];

// ── Agent Config Persistence ──
function loadAgentOverrides() {
  try {
    if (fs.existsSync(AGENT_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(AGENT_CONFIG_FILE, 'utf8'));
    }
  } catch { /* use defaults */ }
  return {};
}

function saveAgentOverrides(overrides) {
  const dir = path.dirname(AGENT_CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(AGENT_CONFIG_FILE, JSON.stringify(overrides, null, 2), 'utf8');
}

/** Get merged agent profiles (defaults + user overrides) */
function getAgents() {
  const overrides = loadAgentOverrides();
  return DEFAULT_AGENTS.map(agent => {
    const ov = overrides[agent.style] || {};
    return {
      ...agent,
      enabled: ov.enabled !== undefined ? ov.enabled : agent.enabled,
      stopPct: ov.stopPct !== undefined ? ov.stopPct : agent.stopPct,
      targetGainRange: ov.targetGainRange || agent.targetGainRange,
      timeframeDays: ov.timeframeDays || agent.timeframeDays,
    };
  });
}

// Alias for backward compat
const AGENTS = getAgents();

// ── Individual Agent Analysis Functions ──

function momentumMike(gem) {
  const profile = getAgents()[0];
  const relevant = profile.targetSignals;
  const matches = gem.signals.filter(s => relevant.includes(s));
  const base = { agent: profile.name, style: profile.style, emoji: profile.emoji };

  if (matches.length === 0) {
    return { ...base, action: 'SKIP', conviction: 0, targetGain: null, timeframe: null, reasoning: 'No momentum signals detected.', stopLoss: null, targetPrice: null };
  }

  // Conviction: 1 signal = WATCH(2), 2+ signals = BUY(3-5)
  const volConfirm = gem.volumeRatio >= 1.5;
  const strongMomentum = gem.details?.momentumAccel > 3;

  if (matches.length === 1 && !volConfirm) {
    const reasons = [`${matches[0].replace(/_/g, ' ')} detected`];
    if (!volConfirm) reasons.push('but volume not yet confirming');
    return { ...base, action: 'WATCH', conviction: 2, targetGain: `${profile.targetGainRange[0]}%`, timeframe: `${profile.timeframeDays[1]} days`, reasoning: reasons.join(' — ') + '.', stopLoss: round(gem.price * (1 - profile.stopPct / 100)), targetPrice: round(gem.price * (1 + profile.targetGainRange[0] / 100)) };
  }

  let conviction = Math.min(5, 2 + matches.length);
  if (volConfirm) conviction = Math.min(5, conviction + 1);
  if (strongMomentum) conviction = Math.min(5, conviction + 1);

  const targetPct = conviction >= 4 ? profile.targetGainRange[1] : profile.targetGainRange[0];
  const days = conviction >= 4 ? profile.timeframeDays[0] : profile.timeframeDays[1];

  const reasons = [];
  reasons.push(`${matches.length} momentum signals: ${matches.map(s => s.replace(/_/g, ' ')).join(', ')}`);
  if (volConfirm) reasons.push(`volume ${gem.volumeRatio}x confirms breakout`);
  if (strongMomentum) reasons.push('momentum accelerating strongly');
  reasons.push(`targeting ${targetPct}% in ${days} days`);

  return {
    ...base, action: 'BUY', conviction, targetGain: `${targetPct}%`, timeframe: `${days} days`,
    reasoning: reasons.join('. ') + '.',
    stopLoss: round(gem.price * (1 - profile.stopPct / 100)),
    targetPrice: round(gem.price * (1 + targetPct / 100)),
  };
}

function squeezeSarah(gem) {
  const profile = getAgents()[1];
  const relevant = profile.targetSignals;
  const matches = gem.signals.filter(s => relevant.includes(s));
  const base = { agent: profile.name, style: profile.style, emoji: profile.emoji };

  if (matches.length === 0) {
    return { ...base, action: 'SKIP', conviction: 0, targetGain: null, timeframe: null, reasoning: 'No squeeze or compression signals.', stopLoss: null, targetPrice: null };
  }

  const highSI = (gem.details?.shortPercentOfFloat || 0) > 20;
  const extremeSI = (gem.details?.shortPercentOfFloat || 0) > 30;
  const bbTight = gem.signals.includes('bb_squeeze');
  const shortLoading = gem.signals.includes('short_squeeze_loading');

  if (matches.length === 1 && !highSI && !bbTight) {
    return { ...base, action: 'WATCH', conviction: 2, targetGain: `${profile.targetGainRange[0]}%`, timeframe: `${profile.timeframeDays[1]} days`, reasoning: `${matches[0].replace(/_/g, ' ')} detected but needs more confirmation.`, stopLoss: round(gem.price * 0.95), targetPrice: round(gem.price * 1.2) };
  }

  let conviction = Math.min(5, 2 + matches.length);
  if (highSI) conviction = Math.min(5, conviction + 1);
  if (extremeSI) conviction = Math.min(5, conviction + 1);
  if (shortLoading && bbTight) conviction = Math.min(5, conviction + 1);

  const targetPct = extremeSI ? profile.targetGainRange[1] : conviction >= 4 ? 35 : profile.targetGainRange[0];
  const days = conviction >= 4 ? profile.timeframeDays[0] : profile.timeframeDays[1];

  const reasons = [];
  if (shortLoading) reasons.push(`short squeeze loading — ${gem.details?.shortPercentOfFloat?.toFixed(1) || '?'}% SI`);
  if (bbTight) reasons.push('Bollinger Bands squeezed tight');
  if (gem.signals.includes('price_compression')) reasons.push('price compressing into a coil');
  if (highSI) reasons.push(`${gem.details?.daysToCover?.toFixed(1) || '?'} days to cover — shorts are trapped`);
  reasons.push(`explosive potential ${targetPct}% in ${days} days`);

  return {
    ...base, action: 'BUY', conviction, targetGain: `${targetPct}%`, timeframe: `${days} days`,
    reasoning: reasons.join('. ') + '.',
    stopLoss: round(gem.price * (1 - profile.stopPct / 100)),
    targetPrice: round(gem.price * (1 + targetPct / 100)),
  };
}

function volumeVictor(gem) {
  const profile = getAgents()[2];
  const relevant = profile.targetSignals;
  const matches = gem.signals.filter(s => relevant.includes(s));
  const base = { agent: profile.name, style: profile.style, emoji: profile.emoji };

  if (matches.length === 0) {
    return { ...base, action: 'SKIP', conviction: 0, targetGain: null, timeframe: null, reasoning: 'No accumulation or smart money signals.', stopLoss: null, targetPrice: null };
  }

  const multiDay = gem.signals.includes('multi_day_accumulation');
  const smartMoney = gem.signals.includes('smart_money');
  const streakDays = gem.details?.volumeStreakDays || 0;
  const closingStrength = gem.details?.closingStrength || 0;

  let conviction = Math.min(5, 1 + matches.length);
  if (multiDay && streakDays >= 4) conviction = Math.min(5, conviction + 1);
  if (smartMoney && closingStrength > 75) conviction = Math.min(5, conviction + 1);
  if (gem.volumeRatio >= 3) conviction = Math.min(5, conviction + 1);

  const action = conviction >= 3 ? 'BUY' : 'WATCH';
  const targetPct = conviction >= 4 ? profile.targetGainRange[1] : profile.targetGainRange[0];
  const days = conviction >= 4 ? profile.timeframeDays[0] : profile.timeframeDays[1];

  const reasons = [];
  if (multiDay) reasons.push(`${streakDays}-day volume accumulation streak`);
  if (smartMoney) reasons.push(`smart money footprint (closing strength ${closingStrength}%)`);
  if (gem.signals.includes('unusual_volume')) reasons.push(`unusual volume ${gem.volumeRatio}x above average`);
  if (gem.floatShares && gem.floatShares < 50e6) reasons.push(`low float ${(gem.floatShares / 1e6).toFixed(0)}M amplifies move`);
  reasons.push(`institutions are loading — targeting ${targetPct}% in ${days} days`);

  return {
    ...base, action, conviction, targetGain: `${targetPct}%`, timeframe: `${days} days`,
    reasoning: reasons.join('. ') + '.',
    stopLoss: round(gem.price * (1 - profile.stopPct / 100)),
    targetPrice: round(gem.price * (1 + targetPct / 100)),
  };
}

function catalystClaire(gem) {
  const profile = getAgents()[3];
  const base = { agent: profile.name, style: profile.style, emoji: profile.emoji };

  if (!gem.signals.includes('earnings_tomorrow')) {
    return { ...base, action: 'SKIP', conviction: 0, targetGain: null, timeframe: null, reasoning: 'No earnings catalyst tomorrow.', stopLoss: null, targetPrice: null };
  }

  // Use gemScore as proxy for earnings quality
  const highQuality = gem.gemScore >= 60;
  const hasVolume = gem.volumeRatio >= 1.3;
  const hasMomentum = gem.changePct > 0.5;

  let conviction = 2;
  if (highQuality) conviction++;
  if (hasVolume) conviction++;
  if (hasMomentum) conviction++;
  conviction = Math.min(5, conviction);

  const action = conviction >= 3 ? 'BUY' : 'WATCH';
  const targetPct = conviction >= 4 ? profile.targetGainRange[1] : profile.targetGainRange[0];

  const reasons = [];
  reasons.push('earnings report tomorrow');
  if (highQuality) reasons.push(`gem score ${gem.gemScore} suggests strong setup`);
  if (hasVolume) reasons.push(`pre-earnings volume building (${gem.volumeRatio}x)`);
  if (hasMomentum) reasons.push(`positive drift +${gem.changePct.toFixed(1)}% into earnings`);
  reasons.push(action === 'BUY' ? `playing the gap — targeting ${targetPct}% overnight` : 'watching for confirmation');

  return {
    ...base, action, conviction, targetGain: `${targetPct}%`, timeframe: '1 day',
    reasoning: reasons.join('. ') + '.',
    stopLoss: round(gem.price * (1 - profile.stopPct / 100)),
    targetPrice: round(gem.price * (1 + targetPct / 100)),
  };
}

function contrarianCarlos(gem) {
  const profile = getAgents()[4];
  const relevant = profile.targetSignals;
  const matches = gem.signals.filter(s => relevant.includes(s));
  const base = { agent: profile.name, style: profile.style, emoji: profile.emoji };

  if (matches.length === 0) {
    return { ...base, action: 'SKIP', conviction: 0, targetGain: null, timeframe: null, reasoning: 'No oversold bounce or sector lag signals.', stopLoss: null, targetPrice: null };
  }

  const isOversold = gem.signals.includes('oversold_bounce');
  const isSectorLag = gem.signals.includes('sector_lag');
  const bigDrop = gem.changePct < -3;
  const lowFloat = gem.floatShares && gem.floatShares < 50e6;

  let conviction = Math.min(5, 1 + matches.length);
  if (isOversold && bigDrop) conviction = Math.min(5, conviction + 1);
  if (isSectorLag && gem.details?.sectorChange > 2) conviction = Math.min(5, conviction + 1);
  if (lowFloat) conviction = Math.min(5, conviction + 1);

  const action = conviction >= 3 ? 'BUY' : 'WATCH';
  const targetPct = conviction >= 4 ? profile.targetGainRange[1] : profile.targetGainRange[0];
  const days = profile.timeframeDays[conviction >= 4 ? 0 : 1];

  const reasons = [];
  if (isOversold) reasons.push(`oversold bounce setup — stock down ${gem.changePct.toFixed(1)}%`);
  if (isSectorLag) reasons.push(`sector laggard — sector up but this stock hasn't moved yet`);
  if (bigDrop) reasons.push('selling looks exhausted');
  reasons.push(`mean reversion play — targeting ${targetPct}% in ${days} days`);

  return {
    ...base, action, conviction, targetGain: `${targetPct}%`, timeframe: `${days} days`,
    reasoning: reasons.join('. ') + '.',
    stopLoss: round(gem.price * (1 - profile.stopPct / 100)),
    targetPrice: round(gem.price * (1 + targetPct / 100)),
  };
}

// ── Utilities ──
function round(n) {
  return Math.round(n * 100) / 100;
}

const AGENT_FUNCS = [momentumMike, squeezeSarah, volumeVictor, catalystClaire, contrarianCarlos];

// ── Exports ──

/**
 * Run all 5 agents on a gem, return verdicts + consensus.
 * Respects per-agent enabled flag.
 */
export function analyzeGem(gem) {
  const agents = getAgents();
  const verdicts = AGENT_FUNCS.map((fn, i) => {
    if (!agents[i].enabled) {
      return {
        agent: agents[i].name, style: agents[i].style, emoji: agents[i].emoji,
        action: 'DISABLED', conviction: 0, targetGain: null, timeframe: null,
        reasoning: 'Agent disabled by user.', stopLoss: null, targetPrice: null,
      };
    }
    return fn(gem);
  });

  const activeVerdicts = verdicts.filter(v => v.action !== 'DISABLED');
  const buyCount = activeVerdicts.filter(v => v.action === 'BUY').length;

  let consensus;
  if (buyCount >= 3) consensus = 'Strong Buy';
  else if (buyCount === 2) consensus = 'Buy';
  else if (buyCount === 1) consensus = 'Speculative';
  else consensus = 'No Trade';

  const avgConviction = buyCount > 0
    ? Math.round(activeVerdicts.filter(v => v.action === 'BUY').reduce((s, v) => s + v.conviction, 0) / buyCount * 10) / 10
    : 0;

  return { verdicts, consensus, buyCount, avgConviction };
}

/**
 * Return agent profile metadata for the UI (with user overrides merged).
 */
export function getAgentProfiles() {
  return getAgents().map(a => ({
    name: a.name,
    style: a.style,
    emoji: a.emoji,
    enabled: a.enabled,
    description: a.description,
    targetSignals: a.targetSignals,
    targetGainRange: a.targetGainRange,
    timeframeDays: a.timeframeDays,
    stopPct: a.stopPct,
  }));
}

/**
 * Update an agent's config by style key.
 * Accepts partial updates: { enabled, stopPct, targetGainRange, timeframeDays }
 */
export function updateAgentProfile(style, updates) {
  const overrides = loadAgentOverrides();
  overrides[style] = { ...(overrides[style] || {}), ...updates };
  saveAgentOverrides(overrides);
  return getAgentProfiles();
}

/**
 * Reset all agents to defaults.
 */
export function resetAgentProfiles() {
  saveAgentOverrides({});
  return getAgentProfiles();
}
