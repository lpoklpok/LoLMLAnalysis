"""
polymarket_chain — shared on-chain helpers for Polymarket fill ingestion.

Vendored across `PolymarketTrades`, `PolymarketAlerts`, `PolymarketFollow`.
Edit the canonical copy in `LoLMLAnalysis/scripts/polymarket_chain.py` and
re-vendor with `scripts/vendor_polymarket_chain.sh` (or just `cp`).

What it does:
  - Constants (NegRisk exchange address + OrderFilled topic)
  - `decode_orderfilled(log)` — pure-fn decoder for an eth_subscribe log
  - `interpret_fill(decoded)` — second pass that classifies side / outcome /
    USDC amount and filters NegRisk split-leg synthetic events
  - `pad_address(addr)` — turn an 0x-address into a 32-byte topic value for
    eth_subscribe filtering

Why this exists:
  Before consolidation, three workers each had their own ~30-line decode
  function. Bug fixes (e.g. the split-leg exchange-address filter) had to
  be ported by hand. Shared lib means one fix touches all three.
"""
from __future__ import annotations

from typing import Any

# Polymarket's NegRisk CTF Exchange contract on Polygon. All fills emit
# OrderFilled logs from this address; subscribe to it and filter the topic
# to capture the whole firehose.
NEGRISK_EXCHANGE   = "0xe111180000d2663c0091e4f400237545b87b996b"

# keccak256("OrderFilled(bytes32,address,address,uint8,uint256,uint256,uint256,uint256,bytes32,bytes32)")
ORDER_FILLED_TOPIC = "0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee"


def pad_address(addr: str) -> str:
    """Left-pad an 0x address to a 32-byte topic value (eth_subscribe filter)."""
    return "0x" + addr.removeprefix("0x").lower().rjust(64, "0")


def decode_orderfilled(log_entry: dict) -> dict | None:
    """Decode a single OrderFilled log from `eth_subscribe(logs, ...)`.

    Returns a dict with raw on-chain fields, or None if the log isn't an
    OrderFilled event (or is malformed).

    Returned shape:
        {
          'maker':          '0x…',     (lowercase)
          'taker':          '0x…',     (lowercase)
          'maker_asset':    int,        (asset id; 0 = USDC)
          'taker_asset':    int,
          'maker_amount':   int,        (raw uint256 from data — divide by 1e6 for USDC/tokens)
          'taker_amount':   int,
          'fee':            int,
          'tx_hash':        '0x…',
          'block_number':   int,
          'log_index':      int,
        }
    """
    try:
        topics = log_entry.get("topics") or []
        if not topics or topics[0].lower() != ORDER_FILLED_TOPIC:
            return None
        # topics[1] = orderHash (not needed); topics[2] = maker; topics[3] = taker
        maker = "0x" + topics[2][-40:]
        taker = "0x" + topics[3][-40:]
        # data: makerAssetId, takerAssetId, makerAmountFilled, takerAmountFilled, fee
        raw = log_entry.get("data") or ""
        if raw.startswith("0x"):
            raw = raw[2:]
        chunks = [int(raw[i * 64:(i + 1) * 64], 16) for i in range(5)]
        m_asset, t_asset, m_amt, t_amt, fee = chunks
        block = log_entry.get("blockNumber")
        log_idx = log_entry.get("logIndex")
        return {
            "maker":        maker.lower(),
            "taker":        taker.lower(),
            "maker_asset":  m_asset,
            "taker_asset":  t_asset,
            "maker_amount": m_amt,
            "taker_amount": t_amt,
            "fee":          fee,
            "tx_hash":      log_entry.get("transactionHash"),
            "block_number": int(block, 16) if isinstance(block, str) else int(block or 0),
            "log_index":    int(log_idx, 16) if isinstance(log_idx, str) else int(log_idx or 0),
        }
    except Exception:
        return None


def interpret_fill(d: dict) -> dict | None:
    """Take a decoded OrderFilled log (from `decode_orderfilled`) and classify
    it into a usable trade. Returns None for synthetic/split-leg events that
    aren't real wallet-to-wallet fills.

    Returned shape:
        {
          'maker':          '0x…',
          'taker':          '0x…',
          'taker_side':     'BUY' | 'SELL',   (from the aggressor's POV)
          'outcome_asset':  int,                (token id of the outcome traded)
          'usdc':           float,              (USDC notional, USD units)
          'tokens':         float,              (outcome shares filled)
          'price':          float,              (usdc/tokens, in $)
          'tx_hash':        '0x…',
          'block_number':   int,
          'log_index':      int,
        }

    Two filters applied:
      1. **Both assets non-USDC** → NegRisk position-split internal event,
         not a real fill. Drop.
      2. **Either party is the exchange contract itself** → NegRisk
         synthetic accounting leg. Drop (would otherwise double-count).
    """
    if not d:
        return None
    # Filter 1: split-leg position transfer (both sides are outcome tokens)
    if d["maker_asset"] != 0 and d["taker_asset"] != 0:
        return None
    # Filter 2: exchange contract on either side = synthetic leg
    if d["maker"] == NEGRISK_EXCHANGE or d["taker"] == NEGRISK_EXCHANGE:
        return None

    if d["maker_asset"] == 0:
        # maker paid USDC → maker bought outcome → taker sold outcome
        outcome_asset = d["taker_asset"]
        usdc          = d["maker_amount"] / 1e6
        tokens        = d["taker_amount"] / 1e6
        taker_side    = "SELL"
    else:
        # taker paid USDC → taker bought outcome
        outcome_asset = d["maker_asset"]
        usdc          = d["taker_amount"] / 1e6
        tokens        = d["maker_amount"] / 1e6
        taker_side    = "BUY"
    if tokens <= 0:
        return None
    return {
        "maker":         d["maker"],
        "taker":         d["taker"],
        "taker_side":    taker_side,
        "outcome_asset": outcome_asset,
        "usdc":          usdc,
        "tokens":        tokens,
        "price":         usdc / tokens,
        "tx_hash":       d["tx_hash"],
        "block_number": d["block_number"],
        "log_index":    d["log_index"],
    }
