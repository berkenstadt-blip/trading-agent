/**
 * AEGIS EARNINGS PLAYS ENGINE
 * The most consistent options trade:
 * 1. Find stocks with earnings in 5-14 days
 * 2. Buy calls (bullish) or puts (bearish) when IV is still cheap
 * 3. Exit 1 day BEFORE earnings (IV peaks, sell into strength)
 * 4. Never hold through earnings (IV crush = losses)
 */

import { blackScholes, earningsExpectedMove } from './options-engine.js';
import { getEarningsInfo, EarningsInfo } from './data-feeds.js';
import { logger } from './logger.js';

export interface EarningsPlay {
  symbol: string;
  earningsDate: string;
  daysUntilEarnings: number;
  direction: 'call' | 'put' | 'straddle';
  strike: number;
  expDays: number; // DTE -- expire AFTER earnings
  premium: number;
  expectedIVExpansion: number; // estimated IV increase before earnings
  expectedPnL: number; // estimated P&L if IV expands 30%
  exitDate: string; // exit 1 day before earnings
  rationale: string;
  score: number; // 0-100
}

export interface EarningsPlayResult {
  plays: EarningsPlay[];
  bestPlay: EarningsPlay | null;
  summary: string;
}

/**
 * Analyze a symbol for earnings play opportunity
 * Returns null if no play or earnings too far/close
 */
export async function analyzeEarningsPlay(
  symbol: string,
  currentPrice: number,
  currentIV: number, // realized vol as IV proxy
  technicalScore: number, // from scanner: positive = bullish bias
): Promise<EarningsPlay | null> {
  try {
    const earnings = await getEarningsInfo(symbol);
    
    if (!earnings.daysUntilEarnings || earnings.daysUntilEarnings < 3 || earnings.daysUntilEarnings > 21) {
      return null; // too close (risky) or too far (premium waste)
    }
    
    const dte = earnings.daysUntilEarnings;
    const T = (dte + 7) / 365; // expire 7 days AFTER earnings for safety
    const r = 0.05;
    
    // Direction based on technical score and last earnings surprise
    let direction: 'call' | 'put' | 'straddle' = 'straddle';
    if (technicalScore > 30) direction = 'call';
    else if (technicalScore < -30) direction = 'put';
    
    // Strike: ATM for maximum leverage on IV expansion
    const strike = Math.round(currentPrice / 5) * 5;
    
    // Price the option at current IV
    const optType = direction === 'put' ? 'put' : 'call';
    const bsm = blackScholes(currentPrice, strike, T, r, currentIV, optType);
    
    // Estimate IV expansion: historically IV rises 30-60% in the week before earnings
    const ivExpansion = 0.40; // 40% IV increase expected
    const bsmHighIV = blackScholes(currentPrice, strike, T, r, currentIV * (1 + ivExpansion), optType);
    const expectedPnL = (bsmHighIV.price - bsm.price) * 100; // per contract
    
    // Only worthwhile if expected P&L > $50 per contract
    if (expectedPnL < 50) return null;
    
    const exitDate = new Date(earnings.earningsDate!);
    exitDate.setDate(exitDate.getDate() - 1);
    
    const score = Math.min(100,
      (Math.min(dte, 14) / 14) * 30 + // sweet spot: 7-14 DTE from earnings
      (Math.min(expectedPnL, 500) / 500) * 40 +
      (Math.abs(technicalScore) / 100) * 30
    );
    
    return {
      symbol,
      earningsDate: earnings.earningsDate!,
      daysUntilEarnings: dte,
      direction,
      strike,
      expDays: dte + 7,
      premium: bsm.price,
      expectedIVExpansion: ivExpansion * 100,
      expectedPnL,
      exitDate: exitDate.toISOString().split('T')[0],
      rationale: `${symbol} earnings in ${dte} days. Buy ${direction} @ $${strike} strike. IV expected to expand ${(ivExpansion*100).toFixed(0)}% into earnings. Est P&L: +$${expectedPnL.toFixed(0)}/contract. Exit: ${exitDate.toISOString().split('T')[0]}.`,
      score,
    };
  } catch (e) {
    logger.warn({ e, symbol }, 'Earnings play analysis failed');
    return null;
  }
}

/**
 * Scan a list of symbols for earnings play opportunities
 */
export async function scanEarningsPlays(
  symbols: string[],
  prices: Record<string, number>,
  ivs: Record<string, number>,
  scores: Record<string, number>,
): Promise<EarningsPlayResult> {
  const plays: EarningsPlay[] = [];
  
  // Scan in batches to avoid rate limits
  const batch = symbols.slice(0, 30); // limit per cycle
  const results = await Promise.allSettled(
    batch.map(s => analyzeEarningsPlay(s, prices[s] ?? 100, ivs[s] ?? 0.30, scores[s] ?? 0))
  );
  
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) plays.push(r.value);
  }
  
  plays.sort((a, b) => b.score - a.score);
  
  return {
    plays,
    bestPlay: plays[0] ?? null,
    summary: plays.length > 0
      ? `Found ${plays.length} earnings plays. Best: ${plays[0].symbol} in ${plays[0].daysUntilEarnings} days (score ${plays[0].score.toFixed(0)})`
      : 'No earnings plays found this cycle',
  };
}
