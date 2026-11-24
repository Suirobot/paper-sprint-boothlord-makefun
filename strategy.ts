// Second-wave rider — a paper-trading strategy for the pump.fun
// bonding-curve replay.
//
// Idea: the first wave of a launch is mostly bundles and snipers.
// This bot ignores a curve until it has real liquidity and a second
// wave of buying has already lifted the price off its first mark;
// only then does it ride, with one fixed small stake per curve.
//
// Entry (all must hold, checked on each batch's marks):
//   - the curve is not complete and we hold none of it;
//   - real quote reserves are at least minRealSol (it survived);
//   - the current price is at least entryLift above the first price
//     we marked for the curve (a second wave, not the launch spike);
//   - we have seen the curve for at least minMarks batches;
//   - caps, cash and the per-curve size cap all allow the stake.
//
// Exit (whole position, first trigger wins):
//   - take profit: mark value reaches cost * (1 + takeProfit);
//   - stop loss: mark value falls to cost * (1 - stopLoss);
//   - time stop: held for more than maxHoldBatches batches.
//
// Deterministic by construction: no clock, no randomness; state is
// kept in insertion-ordered maps fed only by the batch stream.

import type { Batch, Bot, OrderInput, Pubkey } from "./vendor/agentfun-bot.ts";

export interface Params {
  minRealSol: number;
  entryLift: number;
  minMarks: number;
  stakeSol: number;
  takeProfit: number;
  stopLoss: number;
  maxHoldBatches: number;
}

export const DEFAULT_PARAMS: Params = {
  minRealSol: 6,
  entryLift: 0.12,
  minMarks: 3,
  stakeSol: 0.05,
  takeProfit: 0.45,
  stopLoss: 0.22,
  maxHoldBatches: 900,
};

const LAMPORTS = 1_000_000_000;

interface CurveNote {
  firstPrice: number;
  marks: number;
}

export function createStrategy(params: Params): Bot {
  const notes = new Map<Pubkey, CurveNote>();
  const heldBatches = new Map<Pubkey, number>();

  return {
    onBatch(state, batch: Batch) {
      const orders: OrderInput[] = [];
      const { caps } = state.hello;
      const price = new Map<Pubkey, number>();
      const realSol = new Map<Pubkey, number>();

      for (const m of batch.marks) {
        const vt = Number(m.virtual_token_reserves);
        const vq = Number(m.virtual_quote_reserves);
        if (vt <= 0 || vq <= 0) continue;
        const p = vq / vt;
        price.set(m.mint, p);
        realSol.set(m.mint, Number(m.real_quote_reserves) / LAMPORTS);
        const note = notes.get(m.mint);
        if (note === undefined) notes.set(m.mint, { firstPrice: p, marks: 1 });
        else note.marks += 1;
      }

      const held = new Set(batch.account.positions.map((p) => p.mint));

      // Exits first: they free cash and position slots for entries.
      for (const pos of batch.account.positions) {
        const p = price.get(pos.mint);
        const batches = (heldBatches.get(pos.mint) ?? 0) + 1;
        heldBatches.set(pos.mint, batches);
        if (p === undefined) continue;
        const value = Number(pos.token_amount) * p;
        const cost = Number(pos.cost_lamports);
        if (cost <= 0) continue;
        if (
          value >= cost * (1 + params.takeProfit) ||
          value <= cost * (1 - params.stopLoss) ||
          batches > params.maxHoldBatches
        ) {
          orders.push({
            side: "sell",
            mint: pos.mint,
            token_amount: pos.token_amount,
            max_slippage_bps: 10_000,
          });
          heldBatches.delete(pos.mint);
        }
      }
      for (const mint of [...heldBatches.keys()]) {
        if (!held.has(mint)) heldBatches.delete(mint);
      }

      // Entries.
      let slots =
        caps.max_open_positions - state.committedPositionCount();
      let free = state.freeCashLamports();
      const tx = state.txFeeLamports();
      for (const [mint, p] of price) {
        if (orders.length >= caps.max_orders_per_batch) break;
        if (slots <= 0) break;
        if (held.has(mint)) continue;
        const note = notes.get(mint);
        if (note === undefined || note.marks < params.minMarks) continue;
        if ((realSol.get(mint) ?? 0) < params.minRealSol) continue;
        if (p < note.firstPrice * (1 + params.entryLift)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const cap = state.maxBuyLamports(mint);
        const stake = BigInt(Math.round(params.stakeSol * LAMPORTS));
        const amount = cap < stake ? cap : stake;
        if (amount <= 0n || free < amount + tx) continue;
        orders.push({
          side: "buy",
          mint,
          quote_lamports: amount,
          max_slippage_bps: 10_000,
        });
        free -= amount + tx;
        slots -= 1;
        held.add(mint);
      }

      return orders;
    },
  };
}
