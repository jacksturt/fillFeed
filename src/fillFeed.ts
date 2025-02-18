import WebSocket from "ws";
import { Connection, ConfirmedSignatureInfo, PublicKey } from "@solana/web3.js";

import { FillLog } from "@cks-systems/manifest-sdk/client/ts/src/manifest/accounts/FillLog";
import {
  OrderType,
  PlaceOrderLog,
  PROGRAM_ID,
} from "@cks-systems/manifest-sdk/client/ts/src/manifest";
import { convertU128 } from "@cks-systems/manifest-sdk/client/ts/src/utils/numbers";
import { genAccDiscriminator } from "@cks-systems/manifest-sdk/client/ts/src/utils/discriminator";
import * as promClient from "prom-client";
import { FillLogResult } from "@cks-systems/manifest-sdk/client/ts/src/types";

/**
 * FillLogResult is the message sent to subscribers of the FillFeed
 */
export type PlaceOrderLogResult = {
  /** Public key for the market as base58. */
  market: string;
  /** Public key for the trader as base58. */
  trader: string;
  /** Number of base atoms traded. */
  baseAtoms: string;
  /** Number of quote atoms traded. */
  price: number;
  /** Sequential number for every order placed / matched wraps around at u64::MAX */
  orderSequenceNumber: string;
  /** Index of the order in the orderbook. */
  orderIndex: number;
  /** Slot number of the order. */
  lastValidSlot: number;
  /** Type of the order. */
  orderType: OrderType;
  /** Boolean to indicate whether the order is a bid. */
  isBid: boolean;
  /** Padding to make the account size 128 bytes. */
  padding: number[];

  /** Slot number of the fill. */
  slot: number;
  /** Signature of the tx where the fill happened. */
  signature: string;
};

// For live monitoring of the fill feed. For a more complete look at fill
// history stats, need to index all trades.
const fills = new promClient.Counter({
  name: "fills",
  help: "Number of fills",
  labelNames: ["market", "isGlobal", "takerIsBuy"] as const,
});

/**
 * FillFeed example implementation.
 */
export class FillFeed {
  private wss: WebSocket.Server;
  private shouldEnd: boolean = false;
  private ended: boolean = false;
  private lastUpdateUnix: number = Date.now();
  private processingSignatures: Set<string> = new Set();
  private marketAddresses: string[] = [];
  constructor(private connection: Connection) {
    this.wss = new WebSocket.Server({ port: 1234 });

    this.wss.on("connection", (ws: WebSocket) => {
      console.log("New client connected");

      ws.on("message", (message: string) => {
        console.log(`Received message: ${message}`);
      });

      ws.on("close", () => {
        console.log("Client disconnected");
      });
    });
  }

  public msSinceLastUpdate() {
    return Date.now() - this.lastUpdateUnix;
  }

  public async stopParseLogs() {
    this.shouldEnd = true;
    const start = Date.now();
    while (!this.ended) {
      const timeout = 30_000;
      const pollInterval = 500;

      if (Date.now() - start > timeout) {
        return Promise.reject(
          new Error(`failed to stop parseLogs after ${timeout / 1_000} seconds`)
        );
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    return Promise.resolve();
  }

  /**
   * Parse logs in an endless loop.
   */
  public async parseLogs(endEarly?: boolean) {
    try {
      const response = await fetch(
        "https://player-markets.vercel.app/api/db/markets/getAddresses",
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${process.env.CRON_SECRET}`,
          },
        }
      );
      const data = await response.json();
      this.marketAddresses = data;
      console.log("marketAddresses", this.marketAddresses);
    } catch (error) {
      console.error(error);
    }
    for (const marketAddress of this.marketAddresses) {
    }
    const lastSignatureStatus = (
      await this.connection.getSignaturesForAddress(
        PROGRAM_ID,
        { limit: 1 },
        "finalized"
      )
    )[0];
    let lastSignature: string | undefined = lastSignatureStatus.signature;
    let lastSlot: number = lastSignatureStatus.slot;

    const endTime: Date = endEarly
      ? new Date(Date.now() + 30_000)
      : new Date(Date.now() + 1_000_000_000_000);

    while (!this.shouldEnd && new Date(Date.now()) < endTime) {
      await new Promise((f) => setTimeout(f, 10_000));
      const signatures: ConfirmedSignatureInfo[] = [];
      const marketsToCheck: string[] = [];

      const getSignaturesPromise = this.marketAddresses.map(
        async (marketAddress) => {
          await new Promise((f) => setTimeout(f, 1000));

          const marketSignatures =
            await this.connection.getSignaturesForAddress(
              new PublicKey(marketAddress),
              {
                until: lastSignature,
              },
              "finalized"
            );
          if (marketSignatures.length > 0) {
            marketsToCheck.push(marketAddress);
          }
          signatures.push(...marketSignatures);
        }
      );
      await Promise.all(getSignaturesPromise);
      console.log("marketsToCheck", marketsToCheck);
      console.log("signatures", signatures);
      for (const marketAddress of marketsToCheck) {
        try {
          const response = await fetch(
            `https://player-markets.vercel.app/api/cron/checkOrdersAndFills?marketAddress=${marketAddress}`,
            {
              method: "GET",
              headers: {
                Authorization: `Bearer ${process.env.CRON_SECRET}`,
              },
            }
          );
          const data = await response.json();
          console.log("checkOrdersAndFills", data);
        } catch (error) {
          console.error(error);
        }
      }
      signatures.reverse();
      if (signatures.length < 1) {
        continue;
      }

      for (const signature of signatures) {
        if (this.processingSignatures.has(signature.signature)) {
          continue;
        }

        if (signature.slot < lastSlot) {
          continue;
        }

        this.processingSignatures.add(signature.signature);
        await this.handleSignature(signature);
        this.processingSignatures.delete(signature.signature);
      }

      console.log(
        "New last signature:",
        signatures[signatures.length - 1].signature,
        "New last signature slot:",
        signatures[signatures.length - 1].slot,
        "num sigs",
        signatures.length
      );
      lastSignature = signatures[signatures.length - 1].signature;
      lastSlot = signatures[signatures.length - 1].slot;

      this.lastUpdateUnix = Date.now();

      if (this.processingSignatures.size > 1000) {
        const signaturesArray = Array.from(this.processingSignatures);
        this.processingSignatures = new Set(signaturesArray.slice(-1000));
      }
    }

    console.log("ended loop");
    this.wss.close();
    this.ended = true;
  }
  /**
   * Handle a signature by fetching the tx onchain and possibly sending a fill
   * notification.
   */
  private async handleSignature(signature: ConfirmedSignatureInfo) {
    console.log("Handling", signature.signature, "slot", signature.slot);
    const tx = await this.connection.getTransaction(signature.signature, {
      maxSupportedTransactionVersion: 0,
    });
    if (!tx?.meta?.logMessages) {
      console.log("No log messages");
      return;
    }
    if (tx.meta.err != null) {
      console.log("Skipping failed tx", signature.signature);
      return;
    }

    const messages: string[] = tx?.meta?.logMessages!;
    const programDatas: string[] = messages.filter((message) => {
      return message.includes("Program data:");
    });

    if (programDatas.length == 0) {
      console.log("No program datas");
      return;
    }

    for (const programDataEntry of programDatas) {
      const programData = programDataEntry.split(" ")[2];
      const byteArray: Uint8Array = Uint8Array.from(atob(programData), (c) =>
        c.charCodeAt(0)
      );
      const buffer = Buffer.from(byteArray);
      console.log("buffer", buffer);
      if (buffer.subarray(0, 8).equals(fillDiscriminant)) {
        const deserializedFillLog: FillLog = FillLog.deserialize(
          buffer.subarray(8)
        )[0];
        const resultString: string = JSON.stringify(
          toFillLogResult(
            deserializedFillLog,
            signature.slot,
            signature.signature
          )
        );
        console.log("Got a fill", resultString);
        fills.inc({
          market: deserializedFillLog.market.toString(),
          isGlobal: deserializedFillLog.isMakerGlobal.toString(),
          takerIsBuy: deserializedFillLog.takerIsBuy.toString(),
        });
        this.wss.clients.forEach((client) => {
          client.send(
            JSON.stringify({
              type: "fill",
              data: toFillLogResult(
                deserializedFillLog,
                signature.slot,
                signature.signature
              ),
            })
          );
        });
      } else if (buffer.subarray(0, 8).equals(placeOrderDiscriminant)) {
        const deserializedPlaceOrderLog: PlaceOrderLog =
          PlaceOrderLog.deserialize(buffer.subarray(8))[0];
        const resultString: string = JSON.stringify(
          toPlaceOrderLogResult(
            deserializedPlaceOrderLog,
            signature.slot,
            signature.signature
          )
        );
        console.log("Got an order", resultString);

        this.wss.clients.forEach((client) => {
          client.send(
            JSON.stringify({
              type: "placeOrder",
              data: toPlaceOrderLogResult(
                deserializedPlaceOrderLog,
                signature.slot,
                signature.signature
              ),
            })
          );
        });
      } else {
        continue;
      }
    }
  }
}

const fillDiscriminant = genAccDiscriminator("manifest::logs::FillLog");

function toFillLogResult(
  fillLog: FillLog,
  slot: number,
  signature: string
): FillLogResult {
  return {
    market: fillLog.market.toBase58(),
    maker: fillLog.maker.toBase58(),
    taker: fillLog.taker.toBase58(),
    baseAtoms: fillLog.baseAtoms.inner.toString(),
    quoteAtoms: fillLog.quoteAtoms.inner.toString(),
    priceAtoms: convertU128(fillLog.price.inner),
    takerIsBuy: fillLog.takerIsBuy,
    isMakerGlobal: fillLog.isMakerGlobal,
    makerSequenceNumber: fillLog.makerSequenceNumber.toString(),
    takerSequenceNumber: fillLog.takerSequenceNumber.toString(),
    signature,
    slot,
  };
}

const placeOrderDiscriminant = genAccDiscriminator(
  "manifest::logs::PlaceOrderLog"
);

function toPlaceOrderLogResult(
  placeOrderLog: PlaceOrderLog,
  slot: number,
  signature: string
): PlaceOrderLogResult {
  return {
    market: placeOrderLog.market.toBase58(),
    trader: placeOrderLog.trader.toBase58(),
    baseAtoms: placeOrderLog.baseAtoms.inner.toString(),
    price: convertU128(placeOrderLog.price.inner),
    orderSequenceNumber: placeOrderLog.orderSequenceNumber.toString(),
    orderIndex: placeOrderLog.orderIndex,
    lastValidSlot: placeOrderLog.lastValidSlot,
    orderType: placeOrderLog.orderType,
    isBid: placeOrderLog.isBid,
    padding: placeOrderLog.padding,
    signature,
    slot,
  };
}
