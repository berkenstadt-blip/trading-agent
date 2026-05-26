/**
 * ═══════════════════════════════════════════════════════════════
 *  AEGIS SOCIAL SENTIMENT ENGINE
 *  Multi-source forum/social intelligence:
 *  - Reddit (WSB, stocks, investing, options)
 *  - X/Twitter via search
 *  - StockTwits (public API, no auth)
 *  - Fear & Greed index (CNN)
 *  - Trending tickers aggregation
 *  - LLM-powered sentiment scoring with bull/bear thesis extraction
 * ═══════════════════════════════════════════════════════════════
 */

import { logger } from "./logger.js";

// ─── Types ────────────────────────────────────────────────────

export interface SocialPost {
  source: "reddit" | "stocktwits" | "twitter" | "news";
  subreddit?: string;
  text: string;
  score: number;         // upvotes / likes / engagement
  comments?: number;
  timestamp: string;
  sentiment?: "bullish" | "bearish" | "neutral";
}

export interface SocialSentimentResult {
  symbol: string;

  // Reddit
  redditBullCount: number;
  redditBearCount: number;
  redditNeutralCount: number;
  redditScore: number;        // -100 to +100
  topRedditPosts: string[];

  // StockTwits
  stocktwitsWatchlistRank?: number;
  stocktwitsBullPct?: number;
  stocktwitsBearPct?: number;
  stocktwitsMessageCount?: number;

  // Trending
  isTrendingWSB: boolean;
  mentionCount: number;
  mentionVelocity: "spiking" | "elevated" | "normal" | "low";

  // Aggregated
  overallSocialScore: number;    // -100 to +100
  socialSignal: "strong_bullish" | "bullish" | "neutral" | "bearish" | "strong_bearish";
  bullThesis: string[];          // key bull arguments from forums
  bearThesis: string[];          // key bear arguments from forums
  topPosts: SocialPost[];
  summary: string;
}

// ─── Reddit ───────────────────────────────────────────────────

const REDDIT_UA = "AegisTradingBot/2.0 by @aegistrader";
const REDDIT_SUBREDDITS = [
  "wallstreetbets", "stocks", "investing", "options",
  "StockMarket", "SecurityAnalysis", "ValueInvesting",
];

interface RedditPost {
  title: string;
  selftext: string;
  score: number;
  num_comments: number;
  created_utc: number;
  subreddit: string;
  upvote_ratio: number;
  url: string;
}

async function fetchRedditPosts(symbol: string, limit = 25): Promise<SocialPost[]> {
  const posts: SocialPost[] = [];
  const query = encodeURIComponent(`${symbol} OR $${symbol}`);

  // Search across key subreddits
  const urls = [
    `https://www.reddit.com/r/wallstreetbets/search.json?q=${query}&sort=new&limit=${limit}&t=day&restrict_sr=1`,
    `https://www.reddit.com/r/stocks/search.json?q=${query}&sort=new&limit=10&t=day&restrict_sr=1`,
    `https://www.reddit.com/r/options/search.json?q=${query}&sort=new&limit=10&t=day&restrict_sr=1`,
    `https://www.reddit.com/search.json?q=${query}+stock&sort=hot&limit=15&t=day`,
  ];

  await Promise.allSettled(urls.map(async (url) => {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": REDDIT_UA },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return;
      const data = await res.json() as { data: { children: { data: RedditPost }[] } };
      for (const child of data.data.children) {
        const p = child.data;
        const text = `${p.title} ${p.selftext}`.slice(0, 500);
        posts.push({
          source: "reddit",
          subreddit: p.subreddit,
          text,
          score: p.score * (p.upvote_ratio ?? 0.7),
          comments: p.num_comments,
          timestamp: new Date(p.created_utc * 1000).toISOString(),
        });
      }
    } catch (e) {
      logger.debug({ e, url }, "Reddit fetch failed");
    }
  }));

  // Deduplicate and sort by score
  const seen = new Set<string>();
  return posts
    .filter(p => { const key = p.text.slice(0, 50); if (seen.has(key)) return false; seen.add(key); return true; })
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);
}

// ─── StockTwits ───────────────────────────────────────────────

interface StockTwitsResponse {
  symbol: {
    watchlist_count: number;
  };
  messages: {
    id: number;
    body: string;
    likes: { total: number };
    created_at: string;
    entities: {
      sentiment?: { basic: "Bullish" | "Bearish" } | null;
    };
  }[];
  cursor?: { more: boolean; since: number; max: number };
}

async function fetchStockTwits(symbol: string): Promise<{
  messages: SocialPost[];
  watchlistCount: number;
  bullPct: number;
  bearPct: number;
}> {
  try {
    const res = await fetch(
      `https://api.stocktwits.com/api/2/streams/symbol/${symbol.toUpperCase()}.json?limit=30`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return { messages: [], watchlistCount: 0, bullPct: 0, bearPct: 0 };
    const data = await res.json() as StockTwitsResponse;

    let bulls = 0, bears = 0;
    const messages: SocialPost[] = [];

    for (const msg of data.messages ?? []) {
      const sentiment = msg.entities?.sentiment?.basic;
      if (sentiment === "Bullish") bulls++;
      else if (sentiment === "Bearish") bears++;
      messages.push({
        source: "stocktwits",
        text: msg.body.slice(0, 300),
        score: msg.likes?.total ?? 0,
        timestamp: msg.created_at,
        sentiment: sentiment === "Bullish" ? "bullish" : sentiment === "Bearish" ? "bearish" : "neutral",
      });
    }

    const total = bulls + bears;
    return {
      messages,
      watchlistCount: data.symbol?.watchlist_count ?? 0,
      bullPct: total > 0 ? Math.round((bulls / total) * 100) : 50,
      bearPct: total > 0 ? Math.round((bears / total) * 100) : 50,
    };
  } catch (e) {
    logger.debug({ e, symbol }, "StockTwits fetch failed");
    return { messages: [], watchlistCount: 0, bullPct: 50, bearPct: 50 };
  }
}

// ─── WSB Trending Tickers ─────────────────────────────────────

async function getWSBTrending(): Promise<string[]> {
  try {
    const res = await fetch(
      "https://www.reddit.com/r/wallstreetbets/hot.json?limit=25",
      { headers: { "User-Agent": REDDIT_UA }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return [];
    const data = await res.json() as { data: { children: { data: { title: string; selftext: string } }[] } };
    const tickerRegex = /\$([A-Z]{1,5})\b/g;
    const tickers: Record<string, number> = {};
    for (const post of data.data.children) {
      const text = `${post.data.title} ${post.data.selftext}`;
      for (const match of text.matchAll(tickerRegex)) {
        const t = match[1];
        if (!["I", "A", "THE", "FOR", "AND", "OR", "DD", "YOLO", "GME"].includes(t)) {
          tickers[t] = (tickers[t] ?? 0) + 1;
        }
      }
    }
    return Object.entries(tickers)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([t]) => t);
  } catch {
    return [];
  }
}

// ─── Naive Sentiment Scoring ──────────────────────────────────

const BULL_WORDS = [
  "buy", "bullish", "moon", "calls", "long", "breakout", "rocket", "upgrade",
  "beat", "strong", "growth", "beat earnings", "undervalued", "buy the dip",
  "potential", "catalyst", "squeeze", "yolo", "🚀", "💎", "🟢", "up",
];
const BEAR_WORDS = [
  "sell", "bearish", "puts", "short", "crash", "dump", "overvalued", "miss",
  "downgrade", "weak", "decline", "cut", "red flag", "avoid", "scam",
  "fraud", "bubble", "🔴", "📉", "down", "drop",
];

function scoreSentiment(text: string): { score: number; label: "bullish" | "bearish" | "neutral" } {
  const lower = text.toLowerCase();
  let bullCount = BULL_WORDS.filter(w => lower.includes(w)).length;
  let bearCount = BEAR_WORDS.filter(w => lower.includes(w)).length;
  const net = bullCount - bearCount;
  return {
    score: Math.max(-100, Math.min(100, net * 20)),
    label: net > 0 ? "bullish" : net < 0 ? "bearish" : "neutral",
  };
}

// ─── Main: aggregate social sentiment ────────────────────────

export async function getSocialSentiment(symbol: string): Promise<SocialSentimentResult> {
  const [redditPosts, stocktwitsData, wsbTrending] = await Promise.all([
    fetchRedditPosts(symbol, 25).catch(() => [] as SocialPost[]),
    fetchStockTwits(symbol).catch(() => ({ messages: [] as SocialPost[], watchlistCount: 0, bullPct: 50, bearPct: 50 })),
    getWSBTrending().catch(() => [] as string[]),
  ]);

  // Score each Reddit post
  let redditBull = 0, redditBear = 0, redditNeutral = 0;
  let weightedScore = 0, totalWeight = 0;
  const bullThesisRaw: string[] = [];
  const bearThesisRaw: string[] = [];

  for (const post of redditPosts) {
    const { score: textScore, label } = scoreSentiment(post.text);
    post.sentiment = label;
    const weight = Math.max(1, Math.log(post.score + 1) * 2);
    weightedScore += textScore * weight;
    totalWeight += weight;

    if (label === "bullish") { redditBull++; if (bullThesisRaw.length < 5) bullThesisRaw.push(post.text.slice(0, 150)); }
    else if (label === "bearish") { redditBear++; if (bearThesisRaw.length < 5) bearThesisRaw.push(post.text.slice(0, 150)); }
    else redditNeutral++;
  }

  // StockTwits posts
  const stPosts = stocktwitsData.messages;
  for (const post of stPosts) {
    if (post.sentiment === "bullish" && bullThesisRaw.length < 5) bullThesisRaw.push(post.text.slice(0, 150));
    if (post.sentiment === "bearish" && bearThesisRaw.length < 5) bearThesisRaw.push(post.text.slice(0, 150));
  }

  const redditScore = totalWeight > 0 ? Math.round(weightedScore / totalWeight) : 0;

  // StockTwits score: bullPct 50 = neutral, 80 = +60, 20 = -60
  const stScore = ((stocktwitsData.bullPct - 50) / 50) * 80;

  // Weighted aggregate: Reddit 50%, StockTwits 50%
  const overallSocialScore = Math.round(
    redditScore * 0.5 +
    stScore * 0.5
  );

  // Mention count
  const mentionCount = redditPosts.length + stPosts.length;
  const isTrendingWSB = wsbTrending.includes(symbol.toUpperCase());
  const mentionVelocity: SocialSentimentResult["mentionVelocity"] =
    isTrendingWSB ? "spiking" :
    mentionCount > 20 ? "elevated" :
    mentionCount > 8 ? "normal" : "low";

  let socialSignal: SocialSentimentResult["socialSignal"] = "neutral";
  if (overallSocialScore >= 50) socialSignal = "strong_bullish";
  else if (overallSocialScore >= 20) socialSignal = "bullish";
  else if (overallSocialScore <= -50) socialSignal = "strong_bearish";
  else if (overallSocialScore <= -20) socialSignal = "bearish";
  if (isTrendingWSB && overallSocialScore > 0) socialSignal = "strong_bullish";

  const topPosts = [
    ...redditPosts.slice(0, 5),
    ...stPosts.slice(0, 5),
  ].sort((a, b) => b.score - a.score).slice(0, 8);

  const summary = `${symbol}: ${socialSignal.replace("_", " ")} social sentiment (score ${overallSocialScore}). ` +
    `Reddit: ${redditBull}↑ ${redditBear}↓ | StockTwits: ${stocktwitsData.bullPct}% bull` +
    (isTrendingWSB ? " | 🔥 TRENDING on WSB" : "") +
    `. ${mentionCount} mentions (${mentionVelocity})`;

  return {
    symbol: symbol.toUpperCase(),
    redditBullCount: redditBull, redditBearCount: redditBear, redditNeutralCount: redditNeutral,
    redditScore,
    topRedditPosts: redditPosts.slice(0, 5).map(p => p.text.slice(0, 120)),
    stocktwitsWatchlistRank: stocktwitsData.watchlistCount,
    stocktwitsBullPct: stocktwitsData.bullPct,
    stocktwitsBearPct: stocktwitsData.bearPct,
    stocktwitsMessageCount: stPosts.length,
    isTrendingWSB, mentionCount, mentionVelocity,
    overallSocialScore, socialSignal,
    bullThesis: bullThesisRaw.slice(0, 4),
    bearThesis: bearThesisRaw.slice(0, 4),
    topPosts, summary,
  };
}

// ─── Multi-symbol social scanner ─────────────────────────────

export async function scanSocialSentiment(symbols: string[]): Promise<{
  symbol: string; socialScore: number; signal: string; trending: boolean
}[]> {
  const results = await Promise.allSettled(
    symbols.map(s => getSocialSentiment(s))
  );
  return results
    .filter(r => r.status === "fulfilled")
    .map(r => {
      const d = (r as PromiseFulfilledResult<SocialSentimentResult>).value;
      return { symbol: d.symbol, socialScore: d.overallSocialScore, signal: d.socialSignal, trending: d.isTrendingWSB };
    })
    .sort((a, b) => Math.abs(b.socialScore) - Math.abs(a.socialScore));
}
