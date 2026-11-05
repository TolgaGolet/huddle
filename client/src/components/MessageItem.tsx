import { memo, useMemo } from "react";
import { MoreVertical, Pin, Reply } from "lucide-react";
import type { ChatEntry, ChatMessage } from "../types";
import { formatMessage } from "../lib/messageFormatter";
import { avatarTextColor } from "../lib/avatarColor";
import { hasReacted } from "../lib/reactions";
import { formatTime } from "../lib/formatTime";
import MessageEditor from "./MessageEditor";
import RoomImage from "./RoomImage";

/** Must keep a stable identity, or every message re-renders along with the list. */
export interface MessageActions {
  registerRef: (id: string, el: HTMLDivElement | null) => void;
  react: (messageId: string, emoji: string) => void;
  /** Absent when the user may not send messages. */
  reply?: (msg: ChatMessage) => void;
  openMenu: (entry: ChatEntry, e: React.MouseEvent) => void;
  scrollTo: (messageId: string) => void;
  viewImage: (url: string, senderName: string) => void;
  imageLoaded: () => void;
  /** Absent when the user may not send messages. */
  submitEdit?: (messageId: string, text: string) => void;
  cancelEdit: () => void;
}

interface Props {
  msg: ChatMessage;
  isPinned: boolean;
  isEditing: boolean;
  isHighlighted: boolean;
  /** Stable identity, for "is this mine?" checks. */
  localUserId: string;
  actions: MessageActions;
}

export const HIGHLIGHT_CLASS = "bg-indigo-500/10";

const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "👌"];

function MessageItem({ msg, isPinned, isEditing, isHighlighted, localUserId, actions }: Props) {
  const { reply, submitEdit } = actions;
  const reactions = msg.reactions || {};
  const reactionEntries = Object.entries(reactions).filter(([, users]) => users.length > 0);
  const formattedText = useMemo(() => formatMessage(msg.text), [msg.text]);

  return (
    <div
      ref={(el) => actions.registerRef(msg.id, el)}
      role="group"
      aria-label={`Message from ${msg.senderName}`}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- keyboard route to a message; focusing it reveals the action bar and adds its buttons to the Tab order.
      tabIndex={0}
      className={`group relative rounded-lg px-2 py-1 -mx-2 transition-colors hover:bg-gray-800/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 ${
        isPinned ? "border-l-2 border-amber-400/70" : ""
      } ${isHighlighted ? HIGHLIGHT_CLASS : ""}`}
    >
      {isPinned && (
        <span className="inline-flex items-center gap-1 text-[10px] text-amber-400 mb-0.5">
          <Pin size={9} /> Pinned
        </span>
      )}
      {/* Reply quote */}
      {msg.replyTo && (
        <div className="flex items-center gap-1.5 mb-1 pl-2 border-l-2 border-indigo-500/50 rounded-r py-0.5 pr-2">
          <button
            type="button"
            onClick={() => actions.scrollTo(msg.replyTo!.id)}
            aria-label={`Go to the message from ${msg.replyTo.senderName} this replies to`}
            className="flex items-center gap-1.5 min-w-0 cursor-pointer hover:bg-gray-800/60 rounded transition-colors"
          >
            <Reply size={10} className="text-gray-400 shrink-0" />
            <span className="text-[11px] text-indigo-400 font-medium shrink-0">{msg.replyTo.senderName}</span>
            {!msg.replyTo.imageUrl && (
              <span className="text-[11px] text-gray-400 truncate max-w-48">{msg.replyTo.text}</span>
            )}
          </button>
          {msg.replyTo.imageUrl && (
            <button
              type="button"
              onClick={() => actions.viewImage(msg.replyTo!.imageUrl!, msg.replyTo!.senderName)}
              className="shrink-0 cursor-zoom-in"
              title="View image"
            >
              <RoomImage
                src={msg.replyTo.imageUrl}
                alt={`Sent by ${msg.replyTo.senderName}`}
                className="h-8 w-8 rounded object-cover"
                skeletonClassName="h-8 w-8 rounded"
                loading="lazy"
                // The quoted image may have been deleted since; a retry can still bring it back.
                onError={(e) => e.currentTarget.parentElement?.classList.add("hidden")}
                onLoad={(e) => e.currentTarget.parentElement?.classList.remove("hidden")}
              />
            </button>
          )}
        </div>
      )}

      <div className="flex items-baseline gap-2">
        <span className={`text-sm font-semibold ${avatarTextColor(msg.senderName)}`}>
          {msg.senderName}
        </span>
        <span className="text-[10px] text-gray-400">{formatTime(msg.timestamp)}</span>
      </div>

      {msg.gifUrl ? (
        <div className="mt-1">
          <a href="https://giphy.com" target="_blank" rel="noopener noreferrer" className="group/gif inline-block">
            <img
              src={msg.gifUrl}
              alt={msg.text || "GIF"}
              className="rounded-lg max-w-full object-cover group-hover/gif:brightness-90 transition-all"
              style={{ maxHeight: 200, maxWidth: 260 }}
              loading="lazy"
              onLoad={actions.imageLoaded}
            />
          </a>
          <p className="text-[10px] text-gray-400 mt-0.5">
            via{" "}
            <a href="https://giphy.com" target="_blank" rel="noopener noreferrer" className="hover:text-gray-200 transition-colors">
              GIPHY
            </a>
          </p>
        </div>
      ) : (
        <>
          {msg.imageUrls?.length ? (
            <div className="mt-1 grid grid-cols-2 gap-1.5 max-w-sm">
              {msg.imageUrls.map((url) => (
                <button
                  key={url}
                  type="button"
                  onClick={() => actions.viewImage(url, msg.senderName)}
                  className="cursor-zoom-in"
                  title="View image"
                >
                  <RoomImage
                    src={url}
                    alt={`Sent by ${msg.senderName}`}
                    className="rounded-lg max-h-48 w-full object-cover hover:brightness-90 transition-all"
                    skeletonClassName="h-32 w-full rounded-lg"
                    loading="lazy"
                    onLoad={actions.imageLoaded}
                  />
                </button>
              ))}
            </div>
          ) : null}
          {isEditing ? (
            <MessageEditor
              initialText={msg.text}
              onSubmit={submitEdit && ((text) => submitEdit(msg.id, text))}
              onCancel={actions.cancelEdit}
            />
          ) : (
            msg.text && (
              <div className="text-sm text-gray-300 leading-relaxed">
                {formattedText}
                {msg.edited && <span className="text-[10px] text-gray-400 ml-1.5">(edited)</span>}
              </div>
            )
          )}
        </>
      )}

      {/* Reaction badges */}
      {reactionEntries.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {reactionEntries.map(([emoji, users]) => {
            const names = users.map((u) => u.name).join(", ");
            const reacted = hasReacted(users, localUserId);
            return (
              <button
                key={emoji}
                type="button"
                onClick={() => actions.react(msg.id, emoji)}
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs border transition-colors cursor-pointer ${
                  reacted
                    ? "border-indigo-500/50 bg-indigo-500/10"
                    : "border-gray-700 bg-gray-800/60 hover:border-gray-600"
                }`}
                title={names}
                aria-pressed={reacted}
                aria-label={`${emoji} reaction, ${users.length} ${users.length === 1 ? "person" : "people"}: ${names}`}
              >
                <span>{emoji}</span>
                <span className="text-gray-400">{users.length}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Action bar on hover or keyboard focus */}
      {/* hover and focus-visible never fire on a tap, so touch reveals it on focus.
          Hidden while editing: focus stays in the message and it would cover Save/Cancel. */}
      <div className={`absolute -top-3 right-0 hidden ${isEditing ? "" : "group-hover:flex group-has-[:focus-visible]:flex pointer-coarse:group-focus-within:flex"} pointer-coarse:max-w-full pointer-coarse:flex-wrap items-center bg-gray-800 border border-gray-700 rounded-lg shadow-lg overflow-hidden`}>
        {REACTION_EMOJIS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            onClick={() => actions.react(msg.id, emoji)}
            className="touch-target px-1.5 py-1 hover:bg-gray-700 transition-colors cursor-pointer text-sm"
            title={emoji}
            aria-label={`React with ${emoji}`}
          >
            {emoji}
          </button>
        ))}
        {reply && (
          <button
            type="button"
            onClick={() => reply(msg)}
            className="touch-target px-2 py-1 hover:bg-gray-700 transition-colors cursor-pointer text-gray-400 hover:text-gray-200 border-l border-gray-700"
            title="Reply"
            aria-label="Reply"
          >
            <Reply size={13} />
          </button>
        )}
        <button
          type="button"
          onClick={(e) => actions.openMenu(msg, e)}
          className="touch-target px-1.5 py-1 hover:bg-gray-700 transition-colors cursor-pointer text-gray-400 hover:text-gray-200 border-l border-gray-700"
          title="More actions"
          aria-label="More actions"
          aria-haspopup="menu"
        >
          <MoreVertical size={13} />
        </button>
      </div>
    </div>
  );
}

export default memo(MessageItem);
