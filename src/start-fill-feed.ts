import "dotenv/config";

import { FillFeed } from "./fillFeed";
import { Connection } from "@solana/web3.js";
import * as promClient from "prom-client";
import express from "express";
import promBundle from "express-prom-bundle";
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;

const monitorFeed = async (feed: FillFeed) => {
  // 5 minutes
  const deadThreshold = 300_000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await sleep(60_000);
    const msSinceUpdate = feed.msSinceLastUpdate();
    if (msSinceUpdate > deadThreshold) {
      throw new Error(
        `fillFeed has had no updates since ${
          deadThreshold / 1_000
        } seconds ago.`
      );
    }
  }
};

const run = async () => {
  // Prometheus monitoring for this feed on the default prometheus port.
  promClient.collectDefaultMetrics({
    labels: {
      app: "fillFeed",
    },
  });

  const register = new promClient.Registry();
  register.setDefaultLabels({
    app: "fillFeed",
  });
  const metricsApp = express();
  metricsApp.listen(9090);

  const promMetrics = promBundle({
    includeMethod: true,
    metricsApp,
    autoregister: false,
  });
  metricsApp.use(promMetrics);

  const timeoutMs = 5_000;

  console.log("starting feed...");
  let feed: FillFeed | null = null;
  if (!rpcUrl) {
    throw new Error("NEXT_PUBLIC_RPC_URL is not set");
  }
  while (true) {
    try {
      console.log("setting up connection...");
      const conn = new Connection(rpcUrl, "confirmed");
      console.log("setting up feed...");
      feed = new FillFeed(conn);
      console.log("parsing logs...");
      await Promise.all([monitorFeed(feed), feed.parseLogs(false)]);
    } catch (e: unknown) {
      console.error("start:feed: error: ", e);
      if (feed) {
        console.log("shutting down feed before restarting...");
        await feed.stopParseLogs();
        console.log("feed has shut down successfully");
      }
    } finally {
      console.warn(`sleeping ${timeoutMs / 1000} before restarting`);
      sleep(timeoutMs);
    }
  }
};

run().catch((e) => {
  console.error("fatal error");
  // we do indeed want to throw here
  throw e;
});
