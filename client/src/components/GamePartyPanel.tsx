import { memo, useState } from "react";
import { useElementFullscreen } from "../hooks/useElementFullscreen";
import { Ban, Crown, ExternalLink, Gamepad2, LogOut, Maximize, Minimize } from "lucide-react";
import type { GameInfo, GamePartyState, Participant } from "../types";
import ConfirmDialog from "./ConfirmDialog";

interface Props {
  party: GamePartyState;
  game: GameInfo;
  localUserId: string;
  /** Owners can end any party. */
  isOwner: boolean;
  /** Everyone in the room, for members' names. */
  participants: Participant[];
  onLeave: () => void;
  onEnd: (partyId: string) => void;
}

/**
 * Not allow-top-navigation, so the game can't navigate away from the call.
 * Scripts and same-origin, since the game is a full web app with its own storage.
 */
const SANDBOX = "allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-popups allow-popups-to-escape-sandbox allow-modals";

/** The game party's game and its members, shown in the theater area to its members. */
export default memo(GamePartyPanel);

function GamePartyPanel({ party, game, localUserId, isOwner, participants, onLeave, onEnd }: Props) {
  const { ref: containerRef, isFullscreen, toggle: toggleFullscreen } = useElementFullscreen<HTMLElement>();
  const [loaded, setLoaded] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);

  // Below md, a tab-only game needs room only for its button.
  const mobileHeight = game.embed ? "h-[60dvh]" : "";
  const sizeClass = isFullscreen ? "h-full" : `${mobileHeight} shrink-0 md:h-auto md:shrink md:flex-1 md:min-h-0`;
  const nameOf = (userId: string) => participants.find((p) => p.userId === userId)?.name ?? "Someone";
  const buttonClass =
    "touch-target inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-red-300 hover:bg-red-500/10 hover:text-red-200 transition-colors cursor-pointer";

  return (
    <section
      ref={containerRef}
      aria-label="Play Together"
      className={`flex flex-col bg-gray-950 min-w-0 ${sizeClass}`}
    >
      <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 bg-gray-900/60 border-b border-gray-800 shrink-0">
        <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-gray-200">
          <Gamepad2 size={13} className="shrink-0 text-emerald-400" aria-hidden />
          <span className="truncate max-w-48">{game.name}</span>
        </span>
        <ul aria-label="Playing" className="flex flex-1 flex-wrap items-center gap-1 min-w-0">
          {party.memberIds.map((id) => (
            <li
              key={id}
              className="inline-flex items-center gap-1 rounded-full border border-gray-700 bg-gray-800/70 px-2 py-0.5 text-[11px] text-gray-300"
            >
              {id === party.hostId && <Crown size={10} className="text-amber-400" aria-label="Host" />}
              {nameOf(id)}
              {id === localUserId && <span className="text-gray-400">(you)</span>}
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-1">
          {/* A tab-only game has its own big button below; a framed one may still be wanted in a tab. */}
          {game.embed && (
            <a
              href={game.url}
              target="_blank"
              rel="noopener noreferrer"
              className="touch-target p-1 rounded text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
              title="Open the game in a new tab"
              aria-label="Open the game in a new tab"
            >
              <ExternalLink size={14} />
            </a>
          )}
          {/* iPhone Safari has no element fullscreen. Nothing to show full screen for a tab-only game. */}
          {game.embed && document.fullscreenEnabled && (
            <button
              type="button"
              onClick={toggleFullscreen}
              className="touch-target p-1 rounded text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors cursor-pointer"
              title={isFullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
              aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            >
              {isFullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
            </button>
          )}
          {isOwner && (
            <button type="button" onClick={() => setConfirmEnd(true)} className={buttonClass}>
              <Ban size={13} aria-hidden />
              End party
            </button>
          )}
          <button type="button" onClick={onLeave} className={buttonClass}>
            <LogOut size={13} aria-hidden />
            Leave party
          </button>
        </div>
      </div>

      {game.embed ? (
        <div className="relative flex-1 min-h-0" aria-busy={!loaded}>
          {!loaded && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-gray-900 animate-pulse" aria-hidden>
              <Gamepad2 size={32} className="text-gray-600" />
              <span className="text-xs text-gray-400">Loading {game.name}…</span>
            </div>
          )}
          <iframe
            src={game.url}
            title={game.name}
            sandbox={SANDBOX}
            allow="fullscreen; autoplay; gamepad"
            allowFullScreen
            onLoad={() => setLoaded(true)}
            className={`absolute inset-0 h-full w-full border-0 bg-white ${loaded ? "" : "opacity-0"}`}
          />
        </div>
      ) : (
        // Its host won't let it run in a frame, so it opens in a tab of its own.
        <div className="flex flex-1 min-h-0 flex-col items-center justify-center gap-3 px-6 py-8 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-400">
            <Gamepad2 size={28} aria-hidden />
          </span>
          <p className="max-w-sm text-sm text-gray-300">
            {game.name} opens in its own tab. Keep this tab open to stay in the call and the chat.
          </p>
          <a
            href={game.url}
            target="_blank"
            rel="noopener noreferrer"
            className="touch-target inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
          >
            <ExternalLink size={16} aria-hidden />
            Open {game.name}
          </a>
          <p className="text-[11px] text-gray-400">Everyone in the party opens it the same way.</p>
        </div>
      )}

      {confirmEnd && (
        <ConfirmDialog
          icon={<Ban size={18} />}
          title="End this game party?"
          body="It closes the game for everyone playing it."
          confirmLabel="End party"
          overlayZ="z-60"
          onCancel={() => setConfirmEnd(false)}
          onConfirm={() => {
            setConfirmEnd(false);
            onEnd(party.id);
          }}
        />
      )}
    </section>
  );
}
