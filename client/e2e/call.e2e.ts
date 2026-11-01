import { expect, test, type BrowserContext, type Page, type WebSocketRoute } from "@playwright/test";

interface AudioBytes { in: number; out: number }

/** Records every peer connection, so stats can be read without test hooks in the app. */
function recordPeerConnections() {
  const Native = window.RTCPeerConnection;
  const connections: RTCPeerConnection[] = [];
  (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs = connections;
  window.RTCPeerConnection = class extends Native {
    constructor(config?: RTCConfiguration) {
      super(config);
      connections.push(this);
    }
  };
}

/** Audio bytes on the newest open connection; a rejoin replaces the old one. */
function audioBytes(page: Page): Promise<AudioBytes> {
  return page.evaluate(async () => {
    const connections = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs;
    const pc = connections.filter((c) => c.connectionState === "connected").at(-1);
    const bytes = { in: 0, out: 0 };
    if (!pc) return bytes;
    (await pc.getStats()).forEach((s) => {
      if (s.kind !== "audio") return;
      if (s.type === "inbound-rtp") bytes.in = s.bytesReceived ?? 0;
      if (s.type === "outbound-rtp") bytes.out = s.bytesSent ?? 0;
    });
    return bytes;
  });
}

/** Passes once audio is growing in both directions on this page. */
async function expectAudioFlowing(page: Page) {
  let last: AudioBytes = { in: 0, out: 0 };
  await expect
    .poll(
      async () => {
        const now = await audioBytes(page);
        const flowing = last.in > 0 && last.out > 0 && now.in > last.in && now.out > last.out;
        last = now;
        return flowing;
      },
      { timeout: 30_000, intervals: [1000] },
    )
    .toBe(true);
}

async function openPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.addInitScript(recordPeerConnections);
  await page.goto("/");
  return page;
}

async function createRoom(page: Page, name: string): Promise<string> {
  await page.getByRole("button", { name: "Create a Room" }).click();
  await page.getByLabel("Your name").fill(name);
  await page.getByRole("button", { name: "Create Room" }).click();
  await page.waitForURL(/\/room\//);
  return new URL(page.url()).pathname.split("/").pop()!;
}

async function joinRoom(page: Page, name: string, roomId: string) {
  await page.getByRole("button", { name: "Join a Room" }).click();
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Room ID").fill(roomId);
  await page.getByRole("button", { name: "Join", exact: true }).click();
  await page.waitForURL(/\/room\//);
}

async function sendChat(page: Page, text: string) {
  await page.getByLabel("Message", { exact: true }).fill(text);
  await page.keyboard.press("Enter");
}

test("two browsers talk, chat, and recover from a dropped connection", async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alice = await openPage(aliceContext);
  // Proxied so the test can drop Bob's connection; going offline leaves an open websocket alone.
  const bobSockets: WebSocketRoute[] = [];
  await bobContext.routeWebSocket(/socket.io/, (ws) => {
    ws.connectToServer();
    bobSockets.push(ws);
  });
  const bob = await openPage(bobContext);

  const roomId = await createRoom(alice, "Alice");
  await joinRoom(bob, "Bob", roomId);

  await expectAudioFlowing(alice);
  await expectAudioFlowing(bob);

  await sendChat(alice, "hello from alice");
  await expect(bob.getByText("hello from alice")).toBeVisible();
  await sendChat(bob, "hello from bob");
  await expect(alice.getByText("hello from bob")).toBeVisible();

  // The rejoin rebuilds Bob's peer connection.
  const peerConnectionCount = () => bob.evaluate(() => (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.length);
  const connectionsBefore = await peerConnectionCount();
  await bobSockets.at(-1)!.close();
  await expect.poll(peerConnectionCount, { timeout: 30_000 }).toBeGreaterThan(connectionsBefore);

  await expectAudioFlowing(bob);
  await expectAudioFlowing(alice);

  // History comes back with the rejoin, and chat still works both ways.
  await expect(bob.getByText("hello from alice")).toBeVisible();
  await sendChat(bob, "back again");
  await expect(alice.getByText("back again")).toBeVisible();

  await aliceContext.close();
  await bobContext.close();
});
