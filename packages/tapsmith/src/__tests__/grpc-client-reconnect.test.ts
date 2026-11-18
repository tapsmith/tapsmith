import { afterEach, describe, expect, it } from 'vitest';
import * as grpc from '@grpc/grpc-js';
import { pickFreePort } from '../port-utils.js';
import { TapsmithGrpcClient } from '../grpc-client.js';

// The daemon listens within ~30 ms of being spawned, but the CLI's client
// tries it straight away, is refused, and then waits for grpc-js's first
// reconnect backoff — 1 s by default — before trying again.

describe('TapsmithGrpcClient reconnect backoff', () => {
  let server: grpc.Server | undefined;
  let client: TapsmithGrpcClient | undefined;

  afterEach(async () => {
    client?.close();
    client = undefined;
    if (server) await new Promise<void>((resolve) => server!.tryShutdown(() => resolve()));
    server = undefined;
  });

  it('connects soon after a refused first attempt, not after a second', async () => {
    const port = await pickFreePort();
    client = new TapsmithGrpcClient(`127.0.0.1:${port}`);
    const started = Date.now();
    const ready = client.waitForReady(5_000);
    // The first connect attempt is refused; the "daemon" comes up just after.
    await new Promise((resolve) => setTimeout(resolve, 100));
    server = new grpc.Server();
    await new Promise<void>((resolve, reject) => server!.bindAsync(
      `127.0.0.1:${port}`,
      grpc.ServerCredentials.createInsecure(),
      (err) => (err ? reject(err) : resolve()),
    ));
    expect(await ready).toBe(true);
    expect(Date.now() - started).toBeLessThan(700);
  });
});
