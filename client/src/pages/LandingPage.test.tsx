// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router-dom";
import LandingPage from "./LandingPage";

function RoomProbe() {
  const { roomId } = useParams();
  return <output data-testid="room">{JSON.stringify({ roomId, state: useLocation().state })}</output>;
}

function setup(state?: object) {
  render(
    <MemoryRouter initialEntries={[{ pathname: "/", state }]}>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/room/:roomId" element={<RoomProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

const roomInfo = (overrides = {}) => ({ exists: true, hasPassword: false, participantCount: 1, maxParticipants: 6, ...overrides });

function stubFetch(body: unknown, status = 200) {
  const mock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const submit = () => fireEvent.submit(document.querySelector("form")!);
const arrivedAt = async () => JSON.parse((await screen.findByTestId("room")).textContent!);

function openJoin(name = "Ana", roomId = "abc123") {
  setup();
  click("Join a Room");
  type("Your name", name);
  type("Room ID", roomId);
}

function openCreate(name = "Ana") {
  setup();
  click("Create a Room");
  type("Your name", name);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => stubFetch(roomInfo()));

describe("mode switching", () => {
  it("starts with the two choices", () => {
    setup();

    expect(button("Join a Room")).toBeTruthy();
    expect(button("Create a Room")).toBeTruthy();
    expect(document.querySelector("form")).toBeNull();
  });

  it("goes back to the choices, forgetting the error and password", async () => {
    stubFetch(roomInfo({ exists: false }));
    openJoin();
    submit();
    await screen.findByRole("alert");

    click("Back");
    click("Join a Room");

    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("joining", () => {
  it("requires a name and a room ID", () => {
    setup();
    click("Join a Room");
    expect(button("Join").disabled).toBe(true);

    type("Your name", "   ");
    type("Room ID", "abc");
    expect(button("Join").disabled).toBe(true);

    type("Your name", "Ana");
    expect(button("Join").disabled).toBe(false);
  });

  it("doesn't look up on Enter with fields blank", () => {
    const mock = stubFetch(roomInfo());
    setup();
    click("Join a Room");

    submit();

    expect(mock).not.toHaveBeenCalled();
  });

  it("enters an open room with the trimmed name and no password", async () => {
    const mock = stubFetch(roomInfo());
    openJoin("  Ana  ", "  abc123  ");

    submit();

    expect(await arrivedAt()).toEqual({ roomId: "abc123", state: { name: "Ana" } });
    expect((mock.mock.calls[0] as unknown as [string])[0]).toBe("/api/rooms/abc123");
  });

  it("shows progress and blocks a double submit while looking up", async () => {
    let finish!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => (finish = resolve))));
    openJoin();

    submit();

    expect(button("Joining...").disabled).toBe(true);
    finish(new Response(JSON.stringify(roomInfo())));
    await arrivedAt();
  });

  it("explains a missing room", async () => {
    stubFetch(roomInfo({ exists: false }));
    openJoin();

    submit();

    expect((await screen.findByRole("alert")).textContent).toContain("Room not found");
    expect(button("Join").disabled).toBe(false);
  });

  it("explains a full room", async () => {
    stubFetch(roomInfo({ participantCount: 6 }));
    openJoin();

    submit();

    expect((await screen.findByRole("alert")).textContent).toContain("full (6/6");
  });

  it("shows the server's message when the lookup itself is refused", async () => {
    stubFetch({ error: "Too many requests" }, 429);
    openJoin();

    submit();

    expect((await screen.findByRole("alert")).textContent).toBe("Too many requests");
  });

  it("explains a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    openJoin();

    submit();

    expect((await screen.findByRole("alert")).textContent).toContain("Failed to connect");
  });

  it("asks for the password first, then enters with it", async () => {
    stubFetch(roomInfo({ hasPassword: true }));
    openJoin();

    submit();
    const field = await screen.findByLabelText("Room password");
    expect(screen.queryByTestId("room")).toBeNull();
    expect(button("Join").disabled).toBe(true);

    fireEvent.change(field, { target: { value: "  secret  " } });
    submit();

    expect(await arrivedAt()).toEqual({ roomId: "abc123", state: { name: "Ana", password: "secret" } });
  });

  it("refuses a blank password", async () => {
    stubFetch(roomInfo({ hasPassword: true }));
    openJoin();
    submit();
    await screen.findByLabelText("Room password");

    submit();

    expect((await screen.findByRole("alert")).textContent).toContain("requires a password");
  });

  it("hides and clears the password when the room ID changes", async () => {
    stubFetch(roomInfo({ hasPassword: true }));
    openJoin();
    submit();
    fireEvent.change(await screen.findByLabelText("Room password"), { target: { value: "secret" } });

    type("Room ID", "other");

    expect(screen.queryByLabelText("Room password")).toBeNull();
  });
});

describe("arriving from a redirect", () => {
  it("opens the join form for a shared link", () => {
    setup({ roomId: "shared" });

    expect((screen.getByLabelText("Room ID") as HTMLInputElement).value).toBe("shared");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows why a join failed, with everything still filled in", () => {
    setup({ error: "Incorrect password", roomId: "abc", name: "Ana", password: "wrong" });

    expect(screen.getByRole("alert").textContent).toBe("Incorrect password");
    expect((screen.getByLabelText("Your name") as HTMLInputElement).value).toBe("Ana");
    expect((screen.getByLabelText("Room password") as HTMLInputElement).value).toBe("wrong");
  });

  it("can retry with a corrected password straight away", async () => {
    stubFetch(roomInfo({ hasPassword: true }));
    setup({ error: "Incorrect password", roomId: "abc", name: "Ana", password: "wrong" });
    type("Room password", "right");

    submit();

    expect((await arrivedAt()).state.password).toBe("right");
  });
});

describe("creating", () => {
  it("requires a name", () => {
    const mock = stubFetch({ roomId: "new" });
    setup();
    click("Create a Room");

    expect(button("Create Room").disabled).toBe(true);
    submit();

    expect(mock).not.toHaveBeenCalled();
  });

  it("creates an open room and enters it", async () => {
    const mock = stubFetch({ roomId: "new" });
    openCreate("  Ana  ");

    submit();

    expect(await arrivedAt()).toEqual({ roomId: "new", state: { name: "Ana" } });
    const init = (mock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it("creates a protected room with the trimmed password and carries it in", async () => {
    const mock = stubFetch({ roomId: "new" });
    openCreate();
    type("Password (optional)", "  secret  ");

    submit();

    expect((await arrivedAt()).state.password).toBe("secret");
    expect(JSON.parse((mock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ password: "secret" });
  });

  it("treats a blank password as none", async () => {
    const mock = stubFetch({ roomId: "new" });
    openCreate();
    type("Password (optional)", "   ");

    submit();

    expect((await arrivedAt()).state.password).toBeUndefined();
    expect(JSON.parse((mock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({});
  });

  it("shows the server's reason for refusing", async () => {
    stubFetch({ error: "The server is full, please try again later" }, 503);
    openCreate();

    submit();

    expect((await screen.findByRole("alert")).textContent).toContain("server is full");
    expect(screen.queryByTestId("room")).toBeNull();
  });

  it("has a fallback for a refusal with no reason", async () => {
    stubFetch({}, 500);
    openCreate();

    submit();

    expect((await screen.findByRole("alert")).textContent).toContain("Failed to create room");
  });

  it("explains a reply that isn't JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 502 })));
    openCreate();

    submit();

    expect((await screen.findByRole("alert")).textContent).toContain("Failed to create room");
  });

  it("re-enables the form after a failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    openCreate();

    submit();
    await screen.findByRole("alert");

    await waitFor(() => expect(button("Create Room").disabled).toBe(false));
  });
});
