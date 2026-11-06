// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AppSocket, RoomSettings } from "../types";
import RoomSettingsPanel from "./RoomSettingsPanel";

const settings: RoomSettings = { pinPermission: "everyone", screenSharePermission: "owners", messagePermission: "everyone", waitingRoom: false, hasPassword: true, ownerIds: [], creatorId: null };

function fakeSocket() {
  const handlers = new Map<string, (data: unknown) => void>();
  return {
    emit: vi.fn(),
    on: (event: string, handler: (data: unknown) => void) => handlers.set(event, handler),
    off: (event: string) => handlers.delete(event),
    fire: (event: string, data: unknown) => handlers.get(event)?.(data),
  };
}

let socket: ReturnType<typeof fakeSocket>;

function setup(isOwner: boolean, overrides: Partial<RoomSettings> = {}) {
  render(<RoomSettingsPanel socket={socket as unknown as AppSocket} settings={{ ...settings, ...overrides }} isOwner={isOwner} />);
}

const password = () => screen.getByLabelText(/room password/i) as HTMLInputElement;
const save = () => screen.getByRole("button", { name: /sav/i }) as HTMLButtonElement;

beforeEach(() => {
  socket = fakeSocket();
});
afterEach(cleanup);

describe("RoomSettingsPanel", () => {
  it("shows a non-owner the settings, all disabled", () => {
    setup(false);

    expect(screen.getByText(/Only owners can change/)).toBeTruthy();
    expect((screen.getByLabelText("Who can pin messages") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText("Who can share their screen") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText("Waiting room") as HTMLInputElement).disabled).toBe(true);
    expect(password().disabled).toBe(true);
    expect(save().disabled).toBe(true);
  });

  it("lets an owner change each setting", () => {
    setup(true);

    fireEvent.change(screen.getByLabelText("Who can pin messages"), { target: { value: "owners" } });
    expect(socket.emit).toHaveBeenLastCalledWith("update-room-settings", { pinPermission: "owners" });
    fireEvent.change(screen.getByLabelText("Who can share their screen"), { target: { value: "everyone" } });
    expect(socket.emit).toHaveBeenLastCalledWith("update-room-settings", { screenSharePermission: "everyone" });
    fireEvent.change(screen.getByLabelText("Who can send messages"), { target: { value: "owners" } });
    expect(socket.emit).toHaveBeenLastCalledWith("update-room-settings", { messagePermission: "owners" });
    fireEvent.click(screen.getByLabelText("Waiting room"));
    expect(socket.emit).toHaveBeenLastCalledWith("update-room-settings", { waitingRoom: true });
  });

  it("shows the current values", () => {
    setup(false);

    expect((screen.getByLabelText("Who can share their screen") as HTMLSelectElement).value).toBe("owners");
  });

  it("refuses a short password with a message, sending nothing", () => {
    setup(true);

    fireEvent.change(password(), { target: { value: "short" } });
    fireEvent.submit(save().closest("form")!);

    expect(screen.getByRole("alert").textContent).toMatch(/at least 8/);
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it("disables saving while it waits, then confirms and clears the field", () => {
    setup(true);

    fireEvent.change(password(), { target: { value: "long-secret" } });
    fireEvent.submit(save().closest("form")!);

    expect(socket.emit).toHaveBeenCalledWith("change-room-password", { password: "long-secret" });
    expect(save().disabled).toBe(true);

    act(() => socket.fire("room-password-result", { ok: true }));

    expect(screen.getByRole("status").textContent).toMatch(/Saved/);
    expect(password().value).toBe("");
  });

  it("reports a failure, or no answer at all", () => {
    vi.useFakeTimers();
    setup(true);
    fireEvent.change(password(), { target: { value: "long-secret" } });
    fireEvent.submit(save().closest("form")!);

    act(() => vi.advanceTimersByTime(10_000));

    expect(screen.getByRole("alert").textContent).toMatch(/Couldn't change/);
    expect(save().disabled).toBe(false);
    vi.useRealTimers();
  });

  // Regression: Save or Enter on the empty field opened the room with no warning.
  it("never removes the password from an empty field", () => {
    setup(true);

    expect(save().disabled).toBe(true);
    fireEvent.submit(save().closest("form")!);

    expect(socket.emit).not.toHaveBeenCalled();
  });

  it("removes the password only once confirmed, starting on the safe choice", () => {
    setup(true);

    fireEvent.click(screen.getByRole("button", { name: "Remove password" }));
    expect(socket.emit).not.toHaveBeenCalled();
    const keep = screen.getByRole("button", { name: "Keep password" });
    expect(document.activeElement).toBe(keep);

    fireEvent.click(keep);
    expect(socket.emit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove password" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(socket.emit).toHaveBeenCalledWith("change-room-password", { password: "" });
  });

  it("offers removal only to an owner of a room with a password", () => {
    setup(true, { hasPassword: false });
    expect(screen.queryByRole("button", { name: "Remove password" })).toBeNull();
    cleanup();

    setup(false);
    expect((screen.getByRole("button", { name: "Remove password" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
