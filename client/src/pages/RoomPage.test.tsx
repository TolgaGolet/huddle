// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { useMicrophone } from "../hooks/useMicrophone";
import { useSocket } from "../hooks/useSocket";
import { useTransmissionGate } from "../hooks/useTransmissionGate";
import { useVoiceActivity } from "../hooks/useVoiceActivity";
import { useWebRTC } from "../hooks/useWebRTC";
import { playMuteSound, playUnmuteSound } from "../lib/notificationSounds";
import { asAppSocket, emitsOf, fakeSocket, type FakeSocket } from "../test/fakeSocket";
import RoomPage from "./RoomPage";

// The hooks have their own tests. This covers what RoomCall does with them.
vi.mock("../hooks/useSocket", () => ({ useSocket: vi.fn() }));
vi.mock("../hooks/useWebRTC", () => ({ useWebRTC: vi.fn() }));
vi.mock("../hooks/useMicrophone", () => ({ useMicrophone: vi.fn() }));
vi.mock("../hooks/useTransmissionGate", () => ({ useTransmissionGate: vi.fn() }));
vi.mock("../hooks/useVoiceActivity", () => ({ useVoiceActivity: vi.fn() }));
vi.mock("../hooks/useMediaDevices", () => ({
  useMediaDevices: () => ({ audioInputs: [], selectedDeviceId: "", setSelectedDeviceId: vi.fn() }),
}));
vi.mock("../hooks/useCaptureAudio", () => ({
  useCaptureAudio: () => ({ processStream: vi.fn(), localAnalyser: null, needsAudioGesture: false, resumeAudio: vi.fn(), cleanup: vi.fn() }),
}));
vi.mock("../lib/notificationSounds", () => ({ playMuteSound: vi.fn(), playUnmuteSound: vi.fn() }));
vi.mock("../lib/callStateResync", () => ({ resyncCallStateWhenLimited: vi.fn(() => () => {}) }));

const captured = vi.hoisted(() => ({ list: null as null | Record<string, unknown> }));

vi.mock("../components/RoomChat", () => ({ default: () => <div data-testid="chat" /> }));
vi.mock("../components/SettingsPopup", () => ({ default: () => <div data-testid="settings" /> }));
vi.mock("../components/ScreenViewer", () => ({ default: ({ sharerName }: { sharerName: string }) => <div data-testid="screen">{sharerName}</div> }));
vi.mock("../components/ParticipantsList", () => ({
  default: (props: Record<string, unknown>) => {
    captured.list = props;
    return null;
  },
}));

const ana = { id: "s-ana", userId: "u-ana", name: "Ana", isMuted: false };

let socket: FakeSocket;
let setRemoteVolume: ReturnType<typeof vi.fn>;
let startScreenShare: ReturnType<typeof vi.fn>;
let stopScreenShare: ReturnType<typeof vi.fn>;
let retry: ReturnType<typeof vi.fn>;
let joinRoom: ReturnType<typeof vi.fn>;

function Landing() {
  return <output data-testid="landing">{JSON.stringify(useLocation().state)}</output>;
}

function setup(state: object | null = { name: "Me" }) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/room/abc", state }]}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/room/:roomId" element={<RoomPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function mockSocket(overrides: Partial<ReturnType<typeof useSocket>> = {}) {
  vi.mocked(useSocket).mockReturnValue({
    socket: asAppSocket(socket),
    userId: "u-me",
    httpToken: "token",
    imageSession: 1,
    participants: [],
    connected: true,
    joinError: null,
    currentScreenSharer: null,
    joinRoom: joinRoom as () => void,
    ...overrides,
  });
}

function mockWebRTC(overrides: Partial<ReturnType<typeof useWebRTC>> = {}) {
  vi.mocked(useWebRTC).mockReturnValue({
    remoteAnalysers: new Map(),
    screenStreams: new Map(),
    peerConnectionStates: new Map(),
    remotePlaybackBlocked: false,
    resumeRemotePlayback: vi.fn(),
    startScreenShare: startScreenShare as () => Promise<boolean>,
    stopScreenShare: stopScreenShare as () => void,
    setRemoteVolume: setRemoteVolume as (id: string, volume: number) => void,
    ...overrides,
  });
}

function mockMic(error: Parameters<typeof vi.fn>[0] | string | null = null) {
  vi.mocked(useMicrophone).mockReturnValue({
    stream: null,
    error: error as never,
    retrying: false,
    retry: retry as () => Promise<void>,
    dismissError: vi.fn(),
    setDevice: vi.fn(),
    setNoiseCancellation: vi.fn(),
  } as ReturnType<typeof useMicrophone>);
}

const firstButton = (name: string | RegExp) => screen.getAllByRole("button", { name })[0];
const listProps = () => captured.list as unknown as { connecting: Set<string>; speaking: Set<string>; participants: { id: string; name: string; isMuted: boolean }[]; onSetPeerVolume: (userId: string, volume: number) => void };
const announcedMute = () => vi.mocked(useSocket).mock.lastCall![0].isMuted;

beforeEach(() => {
  localStorage.clear();
  socket = fakeSocket("self");
  setRemoteVolume = vi.fn();
  startScreenShare = vi.fn(async () => true);
  stopScreenShare = vi.fn();
  retry = vi.fn(async () => {});
  joinRoom = vi.fn();
  captured.list = null;
  mockSocket();
  mockWebRTC();
  mockMic();
  vi.mocked(useTransmissionGate).mockReturnValue({ isTransmitting: true, gateStateRef: { current: { openSince: 0, consecutiveHigh: 0, noiseFloorDb: null } } });
  vi.mocked(useVoiceActivity).mockReturnValue(new Set());
  vi.mocked(playMuteSound).mockReset();
  vi.mocked(playUnmuteSound).mockReset();
  Object.defineProperty(navigator, "mediaDevices", { value: { getDisplayMedia: vi.fn() }, configurable: true });
});

afterEach(cleanup);

describe("arriving", () => {
  it("sends a visitor with no name to the join form, keeping the room", () => {
    setup(null);

    expect(JSON.parse(screen.getByTestId("landing").textContent!)).toEqual({ roomId: "abc" });
  });

  // RoomCall's hooks open the socket and prompt for the mic.
  it("opens no socket and asks for no mic before there's a name", () => {
    vi.mocked(useSocket).mockClear();
    vi.mocked(useMicrophone).mockClear();

    setup(null);

    expect(useSocket).not.toHaveBeenCalled();
    expect(useMicrophone).not.toHaveBeenCalled();
  });

  it("joins with the room, name and password it was given", () => {
    setup({ name: "Me", password: "pw" });

    expect(vi.mocked(useSocket).mock.lastCall![0]).toMatchObject({ roomId: "abc", name: "Me", password: "pw" });
  });

  it("joins once signaling reports ready", () => {
    setup();

    vi.mocked(useWebRTC).mock.lastCall![0].onSignalingReady!();

    expect(joinRoom).toHaveBeenCalledOnce();
  });

  it("returns to the join form with the reason when a join fails", () => {
    mockSocket({ joinError: "Incorrect password" });

    setup({ name: "Me", password: "wrong" });

    expect(JSON.parse(screen.getByTestId("landing").textContent!)).toEqual({ error: "Incorrect password", roomId: "abc", name: "Me", password: "wrong" });
  });
});

describe("muting", () => {
  it("toggles with its sound, and tells the room", () => {
    setup();
    socket.emit.mockClear();

    fireEvent.click(firstButton("Mute"));
    expect(playMuteSound).toHaveBeenCalledOnce();
    expect(emitsOf(socket, "mute-toggle")).toEqual([["mute-toggle", { isMuted: true }]]);
    expect(announcedMute()).toBe(true);

    fireEvent.click(firstButton("Unmute"));
    expect(playUnmuteSound).toHaveBeenCalledOnce();
    expect(emitsOf(socket, "mute-toggle").at(-1)).toEqual(["mute-toggle", { isMuted: false }]);
  });

  it("gates the track on the user's own choice", () => {
    setup();

    fireEvent.click(firstButton("Mute"));

    expect(vi.mocked(useTransmissionGate).mock.lastCall![0].isMuted).toBe(true);
  });

  // Socket.IO would flush this before the rejoin, where the server ignores it.
  it("doesn't queue a mute change while disconnected", () => {
    socket.connected = false;
    setup();

    fireEvent.click(firstButton("Mute"));

    expect(emitsOf(socket, "mute-toggle")).toEqual([]);
    expect(announcedMute()).toBe(true);
  });

  it.each(["denied", "not-found", "busy", "ended", "insecure"])("announces a user with the %s mic error as muted", (error) => {
    mockMic(error);

    setup();

    expect(announcedMute()).toBe(true);
    expect(listProps().participants[0].isMuted).toBe(true);
  });

  it("doesn't announce muted after a failed device switch, as the old mic still works", () => {
    mockMic("switch-failed");

    setup();

    expect(announcedMute()).toBe(false);
  });

  it("makes the mic button retry when there's no working mic", () => {
    mockMic("denied");
    setup();

    fireEvent.click(firstButton("Microphone unavailable, retry"));

    expect(retry).toHaveBeenCalledOnce();
    expect(playMuteSound).not.toHaveBeenCalled();
  });
});

describe("screen sharing", () => {
  it("starts and shows as sharing", async () => {
    setup();

    await act(async () => void fireEvent.click(firstButton("Share screen")));

    expect(startScreenShare).toHaveBeenCalledOnce();
    expect(firstButton("Stop sharing")).toBeTruthy();
  });

  it("stays off when the picker was cancelled", async () => {
    startScreenShare.mockResolvedValue(false);
    setup();

    await act(async () => void fireEvent.click(firstButton("Share screen")));

    expect(firstButton("Share screen")).toBeTruthy();
  });

  it("stops", async () => {
    setup();
    await act(async () => void fireEvent.click(firstButton("Share screen")));

    await act(async () => void fireEvent.click(firstButton("Stop sharing")));

    expect(stopScreenShare).toHaveBeenCalledOnce();
    expect(firstButton("Share screen")).toBeTruthy();
  });

  it("follows a share ended from outside the button", async () => {
    setup();
    await act(async () => void fireEvent.click(firstButton("Share screen")));

    act(() => vi.mocked(useWebRTC).mock.lastCall![0].onScreenShareStopped!());

    expect(firstButton("Share screen")).toBeTruthy();
  });

  it("is blocked while someone else shares", () => {
    mockSocket({ currentScreenSharer: "s-ana" });

    setup();

    expect((firstButton("Someone is already sharing") as HTMLButtonElement).disabled).toBe(true);
  });

  it("isn't blocked by our own share", () => {
    mockSocket({ currentScreenSharer: "self" });

    setup();

    expect(firstButton("Share screen")).toBeTruthy();
  });

  it("shows the viewer with the sharer's name", () => {
    mockSocket({ participants: [ana] });
    mockWebRTC({ screenStreams: new Map([["s-ana", {} as MediaStream]]) });

    setup();

    expect(screen.getByTestId("screen").textContent).toBe("Ana");
  });

  it("names an unknown sharer generically", () => {
    mockWebRTC({ screenStreams: new Map([["ghost", {} as MediaStream]]) });

    setup();

    expect(screen.getByTestId("screen").textContent).toBe("Someone");
  });

  it("shows no viewer with nothing shared", () => {
    setup();

    expect(screen.queryByTestId("screen")).toBeNull();
  });
});

describe("participants", () => {
  it("lists ourselves first, then the roster", () => {
    mockSocket({ participants: [ana] });

    setup();

    expect(listProps().participants.map((p) => p.name)).toEqual(["Me", "Ana"]);
  });

  it("marks a still-connecting peer, and ourselves along with it", () => {
    mockSocket({ participants: [ana] });
    mockWebRTC({ peerConnectionStates: new Map([["s-ana", "connecting"]]) });

    setup();

    expect([...listProps().connecting].sort()).toEqual(["s-ana", "self"]);
  });

  it("treats a failed peer as still connecting, since recovery is automatic", () => {
    mockWebRTC({ peerConnectionStates: new Map([["s-ana", "failed"]]) });

    setup();

    expect(listProps().connecting.has("s-ana")).toBe(true);
  });

  it.each(["connected", "closed"] as const)("doesn't mark a %s peer", (state) => {
    mockWebRTC({ peerConnectionStates: new Map([["s-ana", state]]) });

    setup();

    expect(listProps().connecting.size).toBe(0);
  });

  it("shows us speaking only while the voice is actually going out", () => {
    vi.mocked(useVoiceActivity).mockReturnValue(new Set(["self", "s-ana"]));
    vi.mocked(useTransmissionGate).mockReturnValue({ isTransmitting: false, gateStateRef: { current: { openSince: 0, consecutiveHigh: 0, noiseFloorDb: null } } });

    setup();

    expect([...listProps().speaking]).toEqual(["s-ana"]);
  });

  it("applies a volume choice by identity, to the peer's current socket", () => {
    mockSocket({ participants: [ana] });
    setup();

    act(() => listProps().onSetPeerVolume("u-ana", 0.5));

    expect(setRemoteVolume).toHaveBeenCalledWith("s-ana", 0.5);
  });

  it("keeps a volume choice across a reconnect under a new socket id", () => {
    mockSocket({ participants: [ana] });
    const view = setup();
    act(() => listProps().onSetPeerVolume("u-ana", 0.5));
    setRemoteVolume.mockClear();

    mockSocket({ participants: [{ ...ana, id: "s-ana-2" }] });
    view.rerender(
      <MemoryRouter initialEntries={[{ pathname: "/room/abc", state: { name: "Me" } }]}>
        <Routes>
          <Route path="/room/:roomId" element={<RoomPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(setRemoteVolume).toHaveBeenCalledWith("s-ana-2", 0.5);
  });
});

describe("leaving", () => {
  it("asks first, and goes home on confirmation", () => {
    setup();

    fireEvent.click(firstButton(/leave/i));
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));

    expect(screen.getByTestId("landing")).toBeTruthy();
  });

  it("stays on cancel", () => {
    setup();

    fireEvent.click(firstButton(/leave/i));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByTestId("landing")).toBeNull();
  });

  it("warns before the tab closes", () => {
    setup();
    const event = new Event("beforeunload", { cancelable: true });

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("stops warning after leaving", () => {
    const { unmount } = setup();

    unmount();
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });
});

describe("settings", () => {
  it("opens the settings popup", () => {
    setup();
    expect(screen.queryByTestId("settings")).toBeNull();

    fireEvent.click(firstButton(/settings/i));

    expect(screen.getByTestId("settings")).toBeTruthy();
  });
});
